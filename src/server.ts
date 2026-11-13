/**
 * A2A HTTP 服务器：把 TaskStore + 任意 TaskRunner 暴露为标准 A2A 端点。
 *
 * 1.0 原生：wire 出口默认按 A2A 1.0（`SendMessage` 等方法名、
 * `TASK_STATE_*` 状态、`ROLE_*` 角色、无 `kind` 的 part、`SendMessageResponse`
 * 的 `{task}` oneof）。0.3.x 客户端（旧方法名 `message/send`、`X-A2A-Version: 0.3.0`
 * 头、浏览器端 client 半）仍走旧 wire 形态，由 `negotiateWire()` 逐请求决定。
 *
 * 端点（默认 http://host:port/）：
 * - `GET  /.well-known/agent-card.json` 与 `/.well-known/agent.json`（0.2 兼容）：Agent Card；
 * - `POST /` JSON-RPC 2.0：
 *   - `SendMessage` / `message/send`            同步执行一轮，返回完结后的任务；
 *   - `SendStreamingMessage` / `message/stream`   SSE 流：状态/产物实时推送；
 *   - `GetTask` / `tasks/get`                   查询任务快照；
 *   - `CancelTask` / `tasks/cancel`             取消进行中的任务；
 *   - `ListTasks` / `tasks/list`                任务列表（1.0 游标分页 / 0.3 摘要）；
 *   - `tasks/resubscribe`                       SSE 回放缓冲事件并继续实时跟随；
 *   - `agent/authenticatedExtendedCard`（启用鉴权时）返回扩展卡片；
 *   - `tasks/pushNotificationConfig/*` → -32003（未实现推送通知）。
 *
 * 传输细节：
 * - 所有响应带 `A2A-Version: 1.0` 头；请求带 `X-A2A-Version`/`A2A-Version` 且
 *   主版本不在 {0,1} 时返回 400（2+ 拒绝）；
 * - 可选 Bearer 鉴权（card 中同步宣告 securitySchemes）；
 * - CORS 放开（浏览器端 A2A 客户端直连调试场景）；
 * - 单轮执行有 turnTimeoutMs 上限，超时任务置 failed；
 * - 已完结任务由 TaskStore 按 TTL 回收。
 *
 * 本模块零 DSH 依赖：TaskRunner 是唯一扩展点（bridge.ts 提供
 * echo/llm/agent 三种实现）。
 *
 * @module dsh-a2a/server
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Server } from 'node:http'
import type {
  A2aMessage,
  AgentCard,
  JsonRpcRequest,
  JsonRpcResponse,
  TaskEvent,
  V1StreamResponse,
  V1Task,
} from './protocol.ts'
import {
  A2A_ERRORS,
  CARD_LEGACY_PATH,
  CARD_PATH,
  PROTOCOL_VERSION,
  RPC_ERRORS,
  jsonrpcError,
  jsonrpcResult,
  parseJsonRpcRequest,
  parseMessageSendParams,
  toV1StreamEvent,
  toV1Task,
  toV1TaskResponse,
} from './protocol.ts'
import type { StoredTask, TaskController } from './store.ts'
import { TaskStore, controllerFor } from './store.ts'

/** 请求体上限（A2A 消息含 base64 文件时可能较大）。 */
const MAX_BODY_BYTES = 10 * 1024 * 1024

/** SSE 心跳间隔（注释行，维持代理/负载均衡不断连）。 */
const SSE_HEARTBEAT_MS = 15_000

/**
 * wire 形态：`'v1'` = A2A 1.0 原生产出；`'v03'` = 0.3 兼容（旧形状）。
 * 逐请求协商，不随服务器配置定死（同一端口同时服务两代客户端）。
 */
type Wire = 'v1' | 'v03'

/** A2A 1.0 的原生方法名集合（这些方法名一律按 1.0 wire 形态应答）。 */
const V1_METHODS = new Set([
  'SendMessage',
  'SendStreamingMessage',
  'GetTask',
  'CancelTask',
  'ListTasks',
])

/** 版本协商放行的主版本（缺省视为同版本；0 = 历史客户端，1 = 1.0 原生）。 */
const ACCEPTED_MAJORS: readonly string[] = ['0', '1']

/** ListTasks 单页上限与缺省页大小（A2A 1.0：pageSize 取 1–100，缺省 50）。 */
const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 50

/** 0.3 兼容分支的 limit 上限（旧客户端没有分页概念，只截断）。 */
const LEGACY_LIST_LIMIT = 200

/** pageToken 有效期：超时按过期拒绝（避免无限期重放旧游标）。 */
const PAGE_TOKEN_TTL_MS = 30 * 60 * 1000

/** 签发 pageToken 的进程级 HMAC 密钥：重启即换键，旧 token 按过期拒绝。 */
const PAGE_TOKEN_SECRET = randomBytes(32)

/** pageToken 载荷：`x` 下一页起点下标，`a` 上一页最后一条 id，`t` 签发时刻（ms）。 */
interface PageTokenPayload {
  readonly x: number
  readonly a: string
  readonly t: number
}

/** 对 token 载荷签名（截短 base64url，足够防伪造）。 */
function signPageToken(body: string): string {
  return createHmac('sha256', PAGE_TOKEN_SECRET).update(body).digest('base64url').slice(0, 22)
}

/**
 * 签发不透明游标 token：`base64url(载荷).HMAC`。
 * 载荷对外不可解，不暴露 offset 语义；`a` 用于列表头部新增任务时仍能锚定
 * 位置（避免重复翻页）。
 */
function encodePageToken(payload: PageTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${body}.${signPageToken(body)}`
}

/** 校验并解出游标载荷；签名不符/格式损坏/过期/字段非法一律返回 undefined（调用方回 -32602）。 */
function decodePageToken(token: unknown): PageTokenPayload | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length !== 2) return undefined
  const [body, signature] = parts
  const expected = signPageToken(body)
  // 定长比较，避免长度差异导致 timingSafeEqual 抛错。
  if (signature.length !== expected.length) return undefined
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return undefined
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (payload === null || typeof payload !== 'object') return undefined
  const { x, a, t } = payload as Record<string, unknown>
  if (!Number.isInteger(x) || (x as number) < 0) return undefined
  if (typeof a !== 'string') return undefined
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return undefined
  if (Date.now() - t > PAGE_TOKEN_TTL_MS) return undefined // 过期
  return { x: x as number, a, t }
}

/** 任务 runner 入参：controller 驱动状态机，message 为本轮用户消息。 */
export interface RunnerInput {
  readonly controller: TaskController
  readonly message: A2aMessage
  /** 本任务已积累的全部消息（含本次 user 消息，按时间序）。 */
  readonly history: readonly A2aMessage[]
}

/** 任务执行器：实现方负责调用 controller 推进状态并产出 artifact。 */
export interface A2aRunner {
  run(input: RunnerInput): Promise<void>
}

/** 最小日志接口（cordis logger 满足之；测试可用静默实现）。 */
export interface A2aLogger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export const silentLogger: A2aLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

export interface A2aServerOptions {
  host: string
  port: number
  /** 写入 Agent Card 的绝对 URL（公网部署时与监听地址不同）。 */
  publicUrl: string
  card: AgentCard
  runner: A2aRunner
  logger?: A2aLogger
  /** Bearer 令牌；不配置则不鉴权。 */
  bearerToken?: string
  /** 单轮执行上限（ms）；默认 10 分钟。 */
  turnTimeoutMs?: number
  /** 已完结任务保留时长（ms）；默认 1 小时。 */
  taskTtlMs?: number
  /** 运维面板展示的运行模式（agent/llm/echo）；仅用于 /admin/status 展示。 */
  mode?: string
}

interface SseSession {
  write(response: JsonRpcResponse): void
  close(): void
}

export class A2aServer {
  private readonly store = new TaskStore()
  private readonly http: Server
  private readonly logger: A2aLogger
  private readonly turnTimeoutMs: number
  private readonly taskTtlMs: number
  private readonly sseSessions = new Set<SseSession>()
  private gcTimer: ReturnType<typeof setInterval> | undefined
  private started = false

  constructor(private readonly options: A2aServerOptions) {
    this.logger = options.logger ?? silentLogger
    this.turnTimeoutMs = options.turnTimeoutMs ?? 600_000
    this.taskTtlMs = options.taskTtlMs ?? 3_600_000
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.logger.error('a2a: 处理请求时未捕获异常', error)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
        }
        res.end(JSON.stringify({ error: 'internal error' }))
      })
    })
  }

  /** 实际监听端口（port=0 时为系统分配值）。 */
  get address(): string {
    const addr = this.http.address()
    if (addr === null || typeof addr === 'string') return this.options.publicUrl
    return `http://${this.options.host === '0.0.0.0' ? '127.0.0.1' : this.options.host}:${addr.port}/`
  }

  async start(): Promise<void> {
    if (this.started) return
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject)
      this.http.listen(this.options.port, this.options.host, () => {
        this.http.off('error', reject)
        resolve()
      })
    })
    this.gcTimer = setInterval(() => {
      const removed = this.store.gc(this.taskTtlMs)
      if (removed > 0) this.logger.debug(`a2a: TTL 回收 ${removed} 个任务`)
    }, Math.min(this.taskTtlMs / 2, 60_000))
    this.gcTimer.unref?.()
    this.started = true
    this.logger.info(`a2a: 服务器已启动 ${this.address}（card url: ${this.options.publicUrl}）`)
  }

  async stop(): Promise<void> {
    if (!this.started) return
    if (this.gcTimer !== undefined) clearInterval(this.gcTimer)
    for (const session of [...this.sseSessions]) session.close()
    await new Promise<void>((resolve, reject) => {
      this.http.close(() => resolve())
      this.http.once('error', reject)
    })
    this.started = false
  }

  // ── 请求路由 ────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.setCommonHeaders(res)
    const url = new URL(req.url ?? '/', 'http://a2a.local')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, this.corsHeaders())
      res.end()
      return
    }
    if (req.method === 'GET' && (url.pathname === CARD_PATH || url.pathname === CARD_LEGACY_PATH)) {
      this.serveCard(req, res)
      return
    }
    // 运维端点（与 JSON-RPC 同源鉴权）：状态摘要与最近任务列表，
    // 供浏览器端运维面板（client 半）直接 fetch。
    if (req.method === 'GET' && (url.pathname === '/admin/status' || url.pathname === '/admin/tasks')) {
      this.serveAdmin(req, res, url)
      return
    }
    if (req.method === 'POST' && this.isRpcPath(url.pathname)) {
      await this.handleRpc(req, res)
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json', ...this.corsHeaders() })
    res.end(JSON.stringify({ error: 'not found' }))
  }

  /** POST 目标路径：'/' 以及 publicUrl 指定的路径（公网反代常见 /a2a 前缀）。 */
  private isRpcPath(pathname: string): boolean {
    if (pathname === '/') return true
    try {
      return pathname.replace(/\/+$/, '') === new URL(this.options.publicUrl).pathname.replace(/\/+$/, '')
    } catch {
      return false
    }
  }

  private setCommonHeaders(res: ServerResponse): void {
    res.setHeader('A2A-Version', PROTOCOL_VERSION)
    for (const [key, value] of Object.entries(this.corsHeaders())) res.setHeader(key, value)
  }

  private corsHeaders(): Record<string, string> {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-A2A-Version, A2A-Version',
      'Access-Control-Expose-Headers': 'A2A-Version',
    }
  }

  private serveCard(req: IncomingMessage, res: ServerResponse): void {
    const accept = String(req.headers.accept ?? '')
    const body = accept.includes('text/html')
      ? `<html><body><pre>${JSON.stringify(this.options.card, null, 2)}</pre></body></html>`
      : JSON.stringify(this.options.card, null, 2)
    res.writeHead(200, { 'Content-Type': 'application/json', ...this.corsHeaders() })
    res.end(body)
  }

  /** /admin/status 与 /admin/tasks：运维面板数据源（Bearer 门禁同 RPC）。 */
  private serveAdmin(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (this.options.bearerToken !== undefined && !this.checkAuth(req)) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="a2a"',
        ...this.corsHeaders(),
      })
      res.end(JSON.stringify({ error: 'unauthorized：缺少或错误的 Bearer 令牌' }))
      return
    }
    if (url.pathname === '/admin/status') {
      const summaries = this.store.listSummaries(1000)
      const body = {
        running: this.started,
        mode: this.options.mode ?? 'agent',
        listen: `${this.options.host}:${this.options.port}`,
        publicUrl: this.options.publicUrl,
        rpcUrl: this.address,
        protocolVersion: PROTOCOL_VERSION,
        auth: this.options.bearerToken !== undefined,
        turnTimeoutMs: this.turnTimeoutMs,
        taskTtlMs: this.taskTtlMs,
        tasks: {
          total: summaries.length,
          active: summaries.filter((t) => t.state === 'working' || t.state === 'submitted' || t.state === 'input-required').length,
        },
        card: this.options.card,
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ...this.corsHeaders() })
      res.end(JSON.stringify(body, null, 2))
      return
    }
    // /admin/tasks
    const limitParam = Number(url.searchParams.get('limit') ?? '50')
    const limit = Number.isFinite(limitParam) ? Math.floor(limitParam) : 50
    const tasks = this.store.listSummaries(limit)
    res.writeHead(200, { 'Content-Type': 'application/json', ...this.corsHeaders() })
    res.end(JSON.stringify({ tasks }, null, 2))
  }

  // ── JSON-RPC 入口 ───────────────────────────────────────────────────

  private async handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 版本协商：缺省视为同版本（兼容 0.2 客户端）；主版本 {0,1} 放行，2+ 拒绝。
    const requestVersion = req.headers['x-a2a-version'] ?? req.headers['a2a-version']
    const requestedMajor = typeof requestVersion === 'string' ? requestVersion.split('.')[0] : undefined
    if (requestedMajor !== undefined && !ACCEPTED_MAJORS.includes(requestedMajor)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `unsupported A2A version ${requestVersion}（本服务器 ${PROTOCOL_VERSION}）` }))
      return
    }
    if (this.options.bearerToken !== undefined && !this.checkAuth(req)) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="a2a"',
      })
      res.end(JSON.stringify({ error: 'unauthorized：缺少或错误的 Bearer 令牌' }))
      return
    }

    const raw = await this.readBody(req, res)
    if (raw === undefined) return // readBody 已回错
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(jsonrpcError(null, RPC_ERRORS.PARSE_ERROR, 'JSON 解析失败')))
      return
    }
    const parsedRequest = parseJsonRpcRequest(parsed)
    if (!parsedRequest.ok) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(jsonrpcError(null, RPC_ERRORS.INVALID_REQUEST, parsedRequest.error)))
      return
    }
    const request = parsedRequest.request
    // wire 形态协商：1.0 方法名或 A2A-Version 主版本 1 → 1.0 原生产出；
    // 旧方法名 + 0.3 头（含本插件浏览器半）→ 旧 wire 形态，保持向后兼容。
    const wire = this.negotiateWire(request.method, requestedMajor)
    this.logger.debug(`a2a: JSON-RPC ${request.method} (id=${String(request.id)}) wire=${wire}`)

    // SSE 方法在 headers 写出前单独处理（成功响应是 text/event-stream）。
    if (request.method === 'message/stream' || request.method === 'SendStreamingMessage') {
      await this.handleStream(request, res, wire)
      return
    }
    if (request.method === 'tasks/resubscribe') {
      await this.handleResubscribe(request, res, wire)
      return
    }

    const response = await this.dispatch(request, wire)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(response))
  }

  /**
   * 逐请求判定 wire 形态：
   * - 方法名是 1.0 原名（SendMessage/SendStreamingMessage/GetTask/CancelTask/ListTasks）→ 'v1'；
   * - 请求头 A2A-Version/X-A2A-Version 主版本为 1 → 'v1'；
   * - 其余（旧方法名 + 无头或 0.x 头）→ 'v03'，保持旧响应形态（浏览器半依赖）。
   */
  private negotiateWire(method: string, requestedMajor: string | undefined): Wire {
    if (V1_METHODS.has(method)) return 'v1'
    if (requestedMajor === '1') return 'v1'
    return 'v03'
  }

  private checkAuth(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    return match !== null && match[1].trim() === this.options.bearerToken
  }

  private async readBody(req: IncomingMessage, res: ServerResponse): Promise<string | undefined> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'request body too large' }))
        return undefined
      }
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  /** 非流式方法的统一分发。`wire` 决定响应形态（'v1' 原生 / 'v03' 兼容）。 */
  private async dispatch(request: JsonRpcRequest, wire: Wire = 'v1'): Promise<JsonRpcResponse> {
    switch (request.method) {
      case 'message/send':
      case 'SendMessage': // 1.0 原生方法名
        return this.handleSend(request, wire)
      case 'tasks/get':
      case 'GetTask': // 1.0 原生方法名
        return this.handleGetTask(request, wire)
      case 'tasks/cancel':
      case 'CancelTask': // 1.0 原生方法名
        return this.handleCancel(request, wire)
      case 'ListTasks': // 1.0 原生（新增）
      case 'tasks/list':
        return this.handleListTasks(request, wire)
      case 'agent/authenticatedExtendedCard':
        return jsonrpcResult(request.id, this.options.card)
      case 'tasks/pushNotificationConfig/set':
      case 'tasks/pushNotificationConfig/get':
        return jsonrpcError(
          request.id,
          A2A_ERRORS.PUSH_NOTIFICATION_NOT_SUPPORTED,
          '本 A2A 服务器不支持推送通知',
        )
      default:
        return jsonrpcError(request.id, RPC_ERRORS.METHOD_NOT_FOUND, `未知方法 ${request.method}`)
    }
  }

  // ── SendMessage（同步执行）──────────────────────────────────────────

  private async handleSend(request: JsonRpcRequest, wire: Wire = 'v1'): Promise<JsonRpcResponse> {
    const parsed = parseMessageSendParams(request.params)
    if (!parsed.ok) {
      return jsonrpcError(request.id, RPC_ERRORS.INVALID_PARAMS, parsed.error)
    }
    const prepared = this.prepareTask(parsed.params.message)
    if (!prepared.ok) {
      return jsonrpcError(request.id, prepared.code, prepared.message)
    }
    const { task, message, history } = prepared
    this.logger.info(`a2a: ${request.method} task=${task.id} context=${task.contextId} turn=${message.messageId}`)
    await this.executeTurn(task, message, history)
    // 1.0：SendMessageResponse 是 oneof {task | message}，且 Task 无 kind、
    // 状态用 TASK_STATE_*、parts 无 kind；旧客户端拿原样 task 快照。
    return jsonrpcResult(request.id, wire === 'v1'
      ? toV1TaskResponse(task.snapshot())
      : task.snapshot())
  }

  /**
   * 解析/创建任务：
   * - 无 taskId：新任务（缺省 contextId 时生成）；
   * - 有 taskId：必须是存在的 input-required 任务（多轮续答）；
   *   否则 TaskNotFound / UnsupportedOperation。
   */
  private prepareTask(message: A2aMessage):
    | { ok: true; task: StoredTask; message: A2aMessage; history: A2aMessage[] }
    | { ok: false; code: number; message: string } {
    if (message.taskId === undefined) {
      const contextId = message.contextId ?? randomUUID()
      const full: A2aMessage = { ...message, contextId }
      const task = this.store.create(contextId)
      const history: A2aMessage[] = [full]
      task.pushHistory(full)
      return { ok: true, task, message: full, history }
    }
    const task = this.store.get(message.taskId)
    if (!task) {
      return { ok: false, code: A2A_ERRORS.TASK_NOT_FOUND, message: `任务 ${message.taskId} 不存在` }
    }
    if (task.final) {
      return { ok: false, code: A2A_ERRORS.TASK_NOT_FOUND, message: `任务 ${message.taskId} 已完结（${task.state}），请不带 taskId 发起新任务` }
    }
    if (task.state !== 'input-required') {
      return { ok: false, code: A2A_ERRORS.UNSUPPORTED_OPERATION, message: `任务 ${message.taskId} 状态为 ${task.state}，仅 input-required 状态可续答` }
    }
    const full: A2aMessage = { ...message, contextId: task.contextId }
    task.pushHistory(full)
    const history = [...(task.snapshot().history ?? [])]
    return { ok: true, task, message: full, history }
  }

  /** 执行一轮：working → runner → 补终态；覆盖取消/超时/异常。 */
  private async executeTurn(task: StoredTask, message: A2aMessage, history: readonly A2aMessage[]): Promise<void> {
    const controller = controllerFor(task)
    if (controller.canceled) return // 创建即取消的极端竞态
    controller.updateStatus('working')
    try {
      const run = this.options.runner.run({ controller, message, history })
      const timeout = new Promise<'timeout'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), this.turnTimeoutMs)
        timer.unref?.()
      })
      const outcome = await Promise.race([run.then(() => 'done' as const), timeout])
      if (controller.canceled) return // cancel() 已广播终态
      if (outcome === 'timeout') {
        controller.updateStatus('failed', this.agentNote(task, `任务超时（>${this.turnTimeoutMs}ms）被服务器终止`))
        return
      }
      // input-required：runner 主动暂停等待补充输入，保留状态供 taskId 续答。
      if (task.state === 'input-required') return
      if (!controller.final) {
        controller.updateStatus('completed')
      }
    } catch (error) {
      if (controller.canceled || controller.final) return
      const text = error instanceof Error ? error.message : String(error)
      this.logger.warn(`a2a: task ${task.id} 执行失败：${text}`)
      controller.updateStatus('failed', this.agentNote(task, `执行失败：${text}`))
    }
  }

  /** 造一条 role=agent 的状态说明消息（放入 status.message，供客户端展示）。 */
  private agentNote(task: StoredTask, text: string): A2aMessage {
    return {
      kind: 'message',
      role: 'agent',
      parts: [{ kind: 'text', text }],
      messageId: randomUUID(),
      taskId: task.id,
      contextId: task.contextId,
    }
  }

  // ── GetTask、CancelTask、ListTasks ────────────────────────────────────

  private handleGetTask(request: JsonRpcRequest, wire: Wire = 'v1'): JsonRpcResponse {
    const taskId = this.taskIdParam(request.params)
    if (taskId === undefined) {
      return jsonrpcError(request.id, RPC_ERRORS.INVALID_PARAMS, 'params.id（或 params.taskId）必须是非空字符串')
    }
    const task = this.store.get(taskId)
    if (!task) {
      return jsonrpcError(request.id, A2A_ERRORS.TASK_NOT_FOUND, `任务 ${taskId} 不存在或已过期回收`)
    }
    return jsonrpcResult(request.id, wire === 'v1' ? toV1Task(task.snapshot()) : task.snapshot())
  }

  private handleCancel(request: JsonRpcRequest, wire: Wire = 'v1'): JsonRpcResponse {
    const taskId = this.taskIdParam(request.params)
    if (taskId === undefined) {
      return jsonrpcError(request.id, RPC_ERRORS.INVALID_PARAMS, 'params.id（或 params.taskId）必须是非空字符串')
    }
    const result = this.store.cancel(taskId)
    if (result === 'not-found') {
      return jsonrpcError(request.id, A2A_ERRORS.TASK_NOT_FOUND, `任务 ${taskId} 不存在或已过期回收`)
    }
    if (result === 'not-cancelable') {
      return jsonrpcError(request.id, A2A_ERRORS.TASK_NOT_CANCELABLE, `任务 ${taskId} 已完结，无法取消`)
    }
    const snapshot = this.store.get(taskId)?.snapshot() ?? null
    return jsonrpcResult(request.id, (wire === 'v1' && snapshot !== null) ? toV1Task(snapshot) : snapshot)
  }

  /**
   * ListTasks（A2A 1.0 新增方法）：返回任务列表，1.0 用原生**游标**分页
   * （`pageToken` → `nextPageToken`，而不是 offset 语义）。
   *
   * - 1.0 wire：`{tasks, nextPageToken, pageSize}`；`nextPageToken` 始终是字符串，
   *   没有下一页时为空串 `""`（规范要求该字段必须始终出现）；`pageSize` 回显
   *   实际生效的页大小。`pageToken` 解不出（伪造/损坏/过期/非本 server 签发）
   *   → -32602 INVALID_PARAMS，绝不静默从头开始（否则客户端会死循环翻页）。
   * - 旧 wire（tasks/list）：`{tasks: [摘要...]}`，与 /admin/tasks 同形态，
   *   保持 0.3 行为不变（0.3 没有这套分页字段）。
   * 无任务时 1.0 返回 `{tasks: [], nextPageToken: '', pageSize}`（不是错误）。
   */
  private handleListTasks(request: JsonRpcRequest, wire: Wire = 'v1'): JsonRpcResponse {
    if (wire === 'v1') return this.listTasksV1(request)
    // ── 0.3 兼容分支：旧语义（limit 截断、无 pageToken/nextPageToken）──
    const limitRaw = this.numberParam(request.params, 'pageSize') ?? this.numberParam(request.params, 'limit')
    const limit = limitRaw !== undefined && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), LEGACY_LIST_LIMIT)
      : DEFAULT_PAGE_SIZE
    const tasks = this.store.listSummaries(limit)
    return jsonrpcResult(request.id, { tasks })
  }

  /** 1.0 原生游标分页实现（handleListTasks 的 v1 分支）。 */
  private listTasksV1(request: JsonRpcRequest): JsonRpcResponse {
    const params = request.params as Record<string, unknown> | null | undefined
    // pageSize 归一：非法/缺失 → 50；>100 → 100；<1 → 50。
    const sizeRaw = this.numberParam(params, 'pageSize')
    let pageSize = DEFAULT_PAGE_SIZE
    if (sizeRaw !== undefined) {
      const floor = Math.floor(sizeRaw)
      pageSize = floor >= 1 ? Math.min(floor, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE
    }
    // 任务集合以 store.list() 为准，沿用其稳定顺序（createdAt 倒序），不重排。
    const all = this.store.list()
    // pageToken：缺省/空串 = 第一页；给了就必须是本 server 签发的有效游标。
    const tokenRaw = params !== null && typeof params === 'object' ? params.pageToken : undefined
    let start = 0
    if (tokenRaw !== undefined && tokenRaw !== null && tokenRaw !== '') {
      if (typeof tokenRaw !== 'string') {
        return jsonrpcError(request.id, RPC_ERRORS.INVALID_PARAMS, 'params.pageToken 必须是字符串')
      }
      const cursor = decodePageToken(tokenRaw)
      if (cursor === undefined) {
        return jsonrpcError(request.id, RPC_ERRORS.INVALID_PARAMS, 'params.pageToken 无效（伪造、损坏或已过期），请从第一页重新开始')
      }
      // 优先按上一页最后一条任务的 id 锚定：期间新任务插到头部也不会重复/漏读；
      // 该任务已被回收时退回 token 内记录的位置。
      const anchor = all.findIndex((task) => task.id === cursor.a)
      start = anchor >= 0 ? anchor + 1 : Math.min(cursor.x, all.length)
    }
    const slice = all.slice(start, start + pageSize)
    const hasMore = start + pageSize < all.length
    const lastId = slice.length > 0 ? slice[slice.length - 1].id : ''
    const nextPageToken = hasMore
      ? encodePageToken({ x: start + pageSize, a: lastId, t: Date.now() })
      : ''
    return jsonrpcResult(request.id, {
      tasks: slice.map((task): V1Task => toV1Task(task.snapshot())),
      nextPageToken,
      pageSize,
    })
  }

  /**
   * 任务 id 参数：A2A 规范用 `params.id`，部分客户端与本插件旧约定
   * 用 `params.taskId`——两者都接受，优先规范写法。
   */
  private taskIdParam(params: unknown): string | undefined {
    return this.stringParam(params, 'id') ?? this.stringParam(params, 'taskId')
  }

  private stringParam(params: unknown, key: string): string | undefined {
    if (params === null || typeof params !== 'object') return undefined
    const value = (params as Record<string, unknown>)[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  /** 数值参数：接受 number 与可解析的字符串；非法一律 undefined（不静默归零）。 */
  private numberParam(params: unknown, key: string): number | undefined {
    if (params === null || typeof params !== 'object') return undefined
    const value = (params as Record<string, unknown>)[key]
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) ? n : undefined
  }

  // ── SSE（SendStreamingMessage、tasks/resubscribe）────────────────────

  private async handleStream(request: JsonRpcRequest, res: ServerResponse, wire: Wire = 'v1'): Promise<void> {
    const parsed = parseMessageSendParams(request.params)
    if (!parsed.ok) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(jsonrpcError(request.id, RPC_ERRORS.INVALID_PARAMS, parsed.error)))
      return
    }
    const prepared = this.prepareTask(parsed.params.message)
    if (!prepared.ok) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(jsonrpcError(request.id, prepared.code, prepared.message)))
      return
    }
    const { task, message, history } = prepared
    this.logger.info(`a2a: ${request.method} (stream) task=${task.id} context=${task.contextId} turn=${message.messageId} wire=${wire}`)

    const session = this.openSse(res)
    // 先订阅再执行：保证 working 事件不丢。1.0 的 StreamResponse 用成员存在性判别
    // （statusUpdate / artifactUpdate），终态由 SSE 关闭本身表达（无 final 字段）。
    const encode = (event: TaskEvent): V1StreamResponse | TaskEvent => (wire === 'v1' ? toV1StreamEvent(event) : event)
    const unsubscribe = task.subscribe((event) => {
      session.write(jsonrpcResult(request.id, encode(event)))
      if (event.kind === 'status-update' && event.final) session.close()
    })
    res.on('close', unsubscribe)
    session.onClose(unsubscribe)
    this.executeTurn(task, message, history).catch((error: unknown) => {
      this.logger.error(`a2a: stream task ${task.id} 执行异常`, error)
      session.close()
    })
  }

  private async handleResubscribe(request: JsonRpcRequest, res: ServerResponse, wire: Wire = 'v1'): Promise<void> {
    const taskId = this.taskIdParam(request.params)
    if (taskId === undefined) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(jsonrpcError(request.id, RPC_ERRORS.INVALID_PARAMS, 'params.id（或 params.taskId）必须是非空字符串')))
      return
    }
    const task = this.store.get(taskId)
    if (!task) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(jsonrpcError(request.id, A2A_ERRORS.TASK_NOT_FOUND, `任务 ${taskId} 不存在或已过期回收`)))
      return
    }
    const session = this.openSse(res)
    const encode = (event: TaskEvent): V1StreamResponse | TaskEvent => (wire === 'v1' ? toV1StreamEvent(event) : event)
    // 回放缓冲事件（含 final 则回放后收尾）。
    for (const event of task.bufferedEvents()) {
      session.write(jsonrpcResult(request.id, encode(event)))
    }
    const alreadyFinal = task.bufferedEvents().some((e) => e.kind === 'status-update' && e.final)
    if (alreadyFinal || task.final) {
      session.close()
      return
    }
    const unsubscribe = task.subscribe((event) => {
      session.write(jsonrpcResult(request.id, encode(event)))
      if (event.kind === 'status-update' && event.final) session.close()
    })
    res.on('close', unsubscribe)
    session.onClose(unsubscribe)
  }

  private openSse(res: ServerResponse): SseSession & { onClose(fn: () => void): void } {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    let closed = false
    const closeCallbacks: Array<() => void> = []
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n')
    }, SSE_HEARTBEAT_MS)
    const finish = (): void => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      this.sseSessions.delete(session)
      for (const fn of closeCallbacks) fn()
      res.end()
    }
    const session: SseSession & { onClose(fn: () => void): void } = {
      write: (response: JsonRpcResponse) => {
        if (closed) return
        res.write(`data: ${JSON.stringify(response)}\n\n`)
      },
      close: finish,
      onClose: (fn: () => void) => {
        closeCallbacks.push(fn)
      },
    }
    res.on('close', finish)
    this.sseSessions.add(session)
    return session
  }
}
