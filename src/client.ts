/**
 * 出站 A2A 客户端：让 DSH（或任意 Node 程序）调用远端 A2A agent。
 *
 * 能力：
 * - `card()`          拉取远端 Agent Card（0.3 路径优先，0.2 路径兜底）；
 * - `send()`          message/send 同步调用；对端返回未完结任务时自动
 *                     按 tasks/get 轮询直到终态（或超时）；
 * - `sendStream()`    message/stream SSE 消费（对端支持流式时的首选）；
 * - `getTask()`       tasks/get；
 * - `cancelTask()`    tasks/cancel。
 *
 * 全部基于全局 fetch（Node ≥20），无第三方依赖。
 *
 * @module dsh-a2a/client
 */

import type {
  A2aTask,
  AgentCard,
  Artifact,
  JsonRpcResponse,
  TaskEvent,
} from './protocol.ts'

export interface A2aClientOptions {
  /** 远端 agent 基地址（Agent Card 所在站点的根，或直接给 JSON-RPC 地址）。 */
  baseUrl: string
  /** Bearer 令牌（远端启用鉴权时）。 */
  bearerToken?: string
  /** 单次 HTTP 请求 / 轮询总超时（ms，默认 120s）。 */
  timeoutMs?: number
  /**
   * 本端 peer 名：写入出站消息 `metadata.from`，供对端把回话路由回来。
   * 未配置（或为空串）时不携带 `from`，回退为旧行为。
   */
  peerName?: string
}

/**
 * 出站消息的 `metadata.kind`：
 * - `message` 仅入库/通知（默认，兼容旧行为）；
 * - `request` 触发对端处理并等待结果；
 * - `result` 回执/结果投递。
 */
export type A2aOutboundKind = 'message' | 'request' | 'result'

/** JSON-RPC 远端返回的错误。 */
export class A2aRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`远端 A2A 返回错误 ${code}: ${message}`)
    this.name = 'A2aRpcError'
  }
}

interface NormalizedBase {
  rpcUrl: string
  cardUrl: (path: string) => string
}

export class A2aClient {
  private base: NormalizedBase | undefined
  private cachedCard: AgentCard | undefined

  constructor(private readonly options: A2aClientOptions) {}

  /** 规范化基地址：容忍带 card 路径 / JSON-RPC 路径的输入。 */
  private normalize(): NormalizedBase {
    if (this.base !== undefined) return this.base
    let url: URL
    try {
      url = new URL(this.options.baseUrl)
    } catch {
      throw new Error(`无效的 A2A baseUrl: ${this.options.baseUrl}`)
    }
    // 输入直接指向 well-known 卡片或根路径时，JSON-RPC 都打到站点根。
    const origin = url.origin
    const path = url.pathname.replace(/\/+$/, '')
    const rpcPath = path !== '' && !path.startsWith('/.well-known') ? `${path}/` : '/'
    this.base = {
      rpcUrl: `${origin}${rpcPath}`,
      cardUrl: (wellKnown: string) => `${origin}${wellKnown}`,
    }
    return this.base
  }

  /**
   * 构造出站消息的 metadata：始终带 `kind`（默认 message），
   * 配置了本端 peerName 时附带 `from`（对端据此路由回话）。
   */
  private messageMetadata(kind: A2aOutboundKind = 'message'): Record<string, unknown> {
    const peerName = this.options.peerName
    return {
      kind,
      ...(peerName !== undefined && peerName !== '' ? { from: peerName } : {}),
    }
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-A2A-Version': '0.3.0',
      ...(this.options.bearerToken !== undefined
        ? { Authorization: `Bearer ${this.options.bearerToken}` }
        : {}),
      ...(extra ?? {}),
    }
  }

  private async rpc<T>(method: string, params?: unknown): Promise<T> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      method,
      ...(params !== undefined ? { params } : {}),
    })
    const response = await fetch(this.normalize().rpcUrl, {
      method: 'POST',
      headers: this.headers(),
      body,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new A2aRpcError(-1, `HTTP ${response.status} ${text.slice(0, 200)}`)
    }
    const payload = (await response.json()) as JsonRpcResponse
    if ('error' in payload) {
      throw new A2aRpcError(payload.error.code, payload.error.message, payload.error.data)
    }
    return payload.result as T
  }

  /** 拉取远端 Agent Card（带进程内缓存）。 */
  async card(forceRefresh = false): Promise<AgentCard> {
    if (!forceRefresh && this.cachedCard !== undefined) return this.cachedCard
    const base = this.normalize()
    const headers = this.headers()
    const attempts = [
      { url: base.cardUrl('/.well-known/agent-card.json'), legacy: false },
      { url: base.cardUrl('/.well-known/agent.json'), legacy: true },
    ]
    let lastError: unknown
    for (const attempt of attempts) {
      try {
        const response = await fetch(attempt.url, {
          headers,
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
        })
        if (!response.ok) {
          lastError = new A2aRpcError(-1, `GET ${attempt.url} → HTTP ${response.status}`)
          continue
        }
        const card = (await response.json()) as AgentCard
        const url = resolveCardUrl(card)
        if (url !== undefined) {
          // v1.0 卡片可能只有 supportedInterfaces；补齐顶层 url 供本客户端统一使用。
          const normalized = url === card.url ? card : { ...card, url }
          this.cachedCard = normalized
          return normalized
        }
        lastError = new A2aRpcError(-1, `GET ${attempt.url} 返回的卡片缺少 url（顶层 url 与 supportedInterfaces[].url 均未提供）`)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /**
   * message/send：同步拿终态。
   * - 对端直接返回完结任务 → 即刻返回；
   * - 对端返回未完结任务 → tasks/get 轮询（pollMs 间隔）直到终态/超时。
   * - 对端返回裸 Message（非任务型 agent）→ 包装成 completed Task 形态。
   */
  async send(text: string, options?: {
    contextId?: string
    pollMs?: number
    onEvent?: (event: TaskEvent) => void
    /** 出站 metadata.kind（默认 message）。 */
    kind?: A2aOutboundKind
  }): Promise<A2aTask> {
    const messageId = crypto.randomUUID()
    const result = await this.rpc<A2aTask | { kind: 'message' }>('message/send', {
      message: {
        kind: 'message',
        role: 'user',
        parts: [{ kind: 'text', text }],
        messageId,
        metadata: this.messageMetadata(options?.kind),
        ...(options?.contextId !== undefined ? { contextId: options.contextId } : {}),
      },
    })
    if (result !== null && typeof result === 'object' && result.kind === 'message') {
      // 非任务型对端：把 agent 消息包装为完结任务。
      const message = result as { parts?: Array<{ kind: string; text?: string }> }
      const reply = (message.parts ?? [])
        .filter((p) => p.kind === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('\n')
      return {
        kind: 'task',
        id: 'inline',
        contextId: options?.contextId ?? 'inline',
        status: { state: 'completed', timestamp: new Date().toISOString() },
        artifacts: [{ kind: 'artifact', artifactId: 'inline', parts: [{ kind: 'text', text: reply }] }],
      }
    }
    let task = result as A2aTask
    const deadline = Date.now() + (this.options.timeoutMs ?? 120_000)
    while (!isTerminal(task) && Date.now() < deadline) {
      await sleep(Math.min(options?.pollMs ?? 1000, Math.max(deadline - Date.now(), 1)))
      task = await this.getTask(task.id)
      options?.onEvent?.({
        kind: 'status-update',
        taskId: task.id,
        contextId: task.contextId,
        status: task.status,
        final: isTerminal(task),
      })
    }
    return task
  }

  /**
   * message/stream：SSE 消费直到 final 事件；返回收到的全部事件。
   * 对端不支持流式（HTTP 非 SSE）时回退 send()。
   */
  async sendStream(text: string, onEvent: (event: TaskEvent) => void, options?: {
    contextId?: string
    /** 出站 metadata.kind（默认 message）。 */
    kind?: A2aOutboundKind
  }): Promise<TaskEvent[]> {
    const messageId = crypto.randomUUID()
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'stream-' + Date.now().toString(36),
      method: 'message/stream',
      params: {
        message: {
          kind: 'message',
          role: 'user',
          parts: [{ kind: 'text', text }],
          messageId,
          metadata: this.messageMetadata(options?.kind),
          ...(options?.contextId !== undefined ? { contextId: options.contextId } : {}),
        },
      },
    })
    const response = await fetch(this.normalize().rpcUrl, {
      method: 'POST',
      headers: this.headers({ Accept: 'text/event-stream' }),
      body,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
    })
    const contentType = String(response.headers.get('content-type') ?? '')
    if (!response.ok) {
      const text2 = await response.text().catch(() => '')
      throw new A2aRpcError(-1, `HTTP ${response.status} ${text2.slice(0, 200)}`)
    }
    if (!contentType.includes('text/event-stream')) {
      // 对端退化为同步 JSON-RPC 响应：读取任务并按 send() 语义补齐。
      const payload = (await response.json()) as JsonRpcResponse
      if ('error' in payload) {
        throw new A2aRpcError(payload.error.code, payload.error.message, payload.error.data)
      }
      const task = payload.result as A2aTask
      onEvent({
        kind: 'status-update',
        taskId: task.id,
        contextId: task.contextId,
        status: task.status,
        final: true,
      })
      return [buildFinalFromTask(task)]
    }

    const events: TaskEvent[] = []
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('远端未提供响应体流')
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data === '') continue
        const payload = JSON.parse(data) as JsonRpcResponse
        if ('error' in payload) {
          throw new A2aRpcError(payload.error.code, payload.error.message, payload.error.data)
        }
        const event = payload.result as TaskEvent
        if (event === null || typeof event !== 'object' || event.kind === undefined) continue
        events.push(event)
        onEvent(event)
        if (event.kind === 'status-update' && event.final) {
          await reader.cancel().catch(() => {})
          return events
        }
      }
    }
    return events
  }

  async getTask(taskId: string): Promise<A2aTask> {
    return this.rpc<A2aTask>('tasks/get', { taskId })
  }

  async cancelTask(taskId: string): Promise<A2aTask> {
    return this.rpc<A2aTask>('tasks/cancel', { taskId })
  }

  /** 便捷：send() + 提取 artifact 文本（工具层使用）。 */
  async sendForText(text: string, options?: {
    contextId?: string
    pollMs?: number
    preferStream?: boolean
    onEvent?: (event: TaskEvent) => void
    /** 出站 metadata.kind（默认 message）。 */
    kind?: A2aOutboundKind
  }): Promise<{ task: A2aTask; text: string }> {
    if (options?.preferStream) {
      const card = await this.card().catch(() => undefined)
      if (card === undefined || card.capabilities?.streaming) {
        const events = await this.sendStream(text, (e) => options.onEvent?.(e), {
          contextId: options.contextId,
          ...(options.kind !== undefined ? { kind: options.kind } : {}),
        })
        const task = taskFromEvents(events)
        return { task, text: artifactTextFromEvents(events) }
      }
    }
    const task = await this.send(text, options)
    const out: string[] = []
    for (const artifact of task.artifacts ?? []) {
      for (const part of artifact.parts) {
        if (part.kind === 'text') out.push(part.text)
      }
    }
    return { task, text: out.join('\n').trim() }
  }
}

/**
 * 解析卡片的服务地址：优先顶层 `url`（0.2/0.3 形态），缺失时回退
 * A2A v1.0 的 `supportedInterfaces[]`（取首个带 url 的接口，优先 JSONRPC）。
 */
function resolveCardUrl(card: AgentCard): string | undefined {
  if (typeof card.url === 'string' && card.url !== '') return card.url
  const interfaces = card.supportedInterfaces
  if (Array.isArray(interfaces)) {
    const usable = interfaces.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.url === 'string' && entry.url !== '')
    const preferred = usable.find((entry) => String(entry.protocolBinding ?? '').toUpperCase() === 'JSONRPC')
    const chosen = preferred ?? usable[0]
    if (chosen !== undefined) return chosen.url
  }
  return undefined
}

function isTerminal(task: A2aTask): boolean {
  return ['completed', 'failed', 'canceled', 'rejected'].includes(task.status.state)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildFinalFromTask(task: A2aTask): TaskEvent {
  return {
    kind: 'status-update',
    taskId: task.id,
    contextId: task.contextId,
    status: task.status,
    final: true,
  }
}

/** 从事件序列合成最终任务快照（流式路径没有 tasks/get）。 */
function taskFromEvents(events: TaskEvent[]): A2aTask {
  let taskId = 'unknown'
  let contextId = 'unknown'
  let lastStatus: A2aTask['status'] = { state: 'failed', timestamp: new Date().toISOString() }
  const artifacts: Artifact[] = []
  for (const event of events) {
    if (event.kind === 'status-update') {
      taskId = event.taskId
      contextId = event.contextId
      lastStatus = event.status
    } else {
      taskId = event.taskId
      contextId = event.contextId
      artifacts.push(event.artifact)
    }
  }
  return {
    kind: 'task',
    id: taskId,
    contextId,
    status: lastStatus,
    ...(artifacts.length > 0 ? { artifacts } : {}),
  }
}

/** 从事件序列提取最终产物文本。 */
function artifactTextFromEvents(events: TaskEvent[]): string {
  const out: string[] = []
  for (const event of events) {
    if (event.kind !== 'artifact-update') continue
    for (const part of event.artifact.parts) {
      if (part.kind === 'text') out.push(part.text)
    }
  }
  return out.join('\n').trim()
}

/**
 * 出站白名单模式匹配：
 * - `'*'` 全放开；
 * - URL 形式（`https://a2a.example.com/`、`http://10.0.0.5:7310/`）按
 *   host + port + 路径前缀匹配；hostname 支持 `*.example.com` 通配子域；
 * - `'*:7310'` 任意主机的指定端口。
 */
export function matchesAllowlist(patterns: readonly string[], target: string): boolean {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return false
  }
  const targetFull = `${url.origin}${url.pathname}`.replace(/\/+$/, '')
  for (const pattern of patterns) {
    if (pattern === '*') return true
    // URL 形式：按 host/port/路径前缀精确匹配。
    let parsed: URL | undefined
    try {
      parsed = new URL(pattern)
    } catch {
      parsed = undefined
    }
    if (parsed !== undefined) {
      const hostOk = parsed.hostname.startsWith('*.')
        ? (url.hostname === parsed.hostname.slice(2) || url.hostname.endsWith(`.${parsed.hostname.slice(2)}`))
        : parsed.hostname === url.hostname
      const portOk = parsed.port === url.port
      const pathOk = parsed.pathname === '/' || url.pathname.startsWith(parsed.pathname.replace(/\/+$/, ''))
      if (hostOk && portOk && pathOk) return true
      continue
    }
    if (pattern.startsWith('*.')) {
      // *.example.com 允许任意子域（含裸域）。
      const domain = pattern.slice(2)
      if (url.hostname === domain || url.hostname.endsWith(`.${domain}`)) return true
      continue
    }
    if (pattern.startsWith('*')) {
      // *:7310 → 任意主机的指定端口。
      if (url.port !== '' && pattern === `*:${url.port}`) return true
      continue
    }
    const normalized = pattern.replace(/\/+$/, '')
    if (url.origin === normalized || targetFull === normalized) return true
  }
  return false
}
