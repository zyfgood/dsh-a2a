/**
 * A2A（Agent2Agent）协议类型与纯函数工具：消息/任务/事件结构、
 * JSON-RPC 2.0 信封、错误码、Agent Card 构造与参数校验。
 *
 * 本模块零依赖（不 import DSH / cordis / node API 之外的任何包），
 * 服务器、客户端、冒烟测试共用，保证三端看到同一份 wire 契约。
 *
 * 兼容性：以 A2A 0.3.x（`kind` 判别字段、`/.well-known/agent-card.json`、
 * `protocolVersion`、`A2A-Version` 头）为准实现，同时兼容 0.2.x 客户端
 * （旧 `/.well-known/agent.json` 路径、camelCase 方法名一致）。
 *
 * @module dsh-a2a/protocol
 */

import { randomUUID } from 'node:crypto'

// ── 常量 ────────────────────────────────────────────────────────────────

/** 本实现宣告/应答的 A2A 协议版本。 */
export const PROTOCOL_VERSION = '0.3.0'

/** Agent Card 的 0.3.x 标准路径。 */
export const CARD_PATH = '/.well-known/agent-card.json'
/** Agent Card 的 0.2.x 旧路径（同时保留，兼容旧客户端）。 */
export const CARD_LEGACY_PATH = '/.well-known/agent.json'

// ── 消息部件（Parts）──────────────────────────────────────────────────

export interface TextPart {
  readonly kind: 'text'
  readonly text: string
  readonly metadata?: Record<string, unknown>
}

export interface DataPart {
  readonly kind: 'data'
  readonly data: Record<string, unknown>
  readonly metadata?: Record<string, unknown>
}

export interface FilePart {
  readonly kind: 'file'
  readonly file: {
    /** base64 编码的字节（与 uri 二选一）。 */
    readonly bytes?: string
    readonly uri?: string
    readonly mimeType?: string
    readonly name?: string
  }
  readonly metadata?: Record<string, unknown>
}

export type Part = TextPart | DataPart | FilePart

// ── 消息 / 产物（Message / Artifact）──────────────────────────────────

export type MessageRole = 'user' | 'agent'

export interface A2aMessage {
  readonly kind: 'message'
  readonly role: MessageRole
  readonly parts: readonly Part[]
  readonly messageId: string
  readonly taskId?: string
  readonly contextId?: string
  readonly metadata?: Record<string, unknown>
}

export interface Artifact {
  readonly kind: 'artifact'
  readonly artifactId: string
  readonly name?: string
  readonly description?: string
  readonly parts: readonly Part[]
  readonly metadata?: Record<string, unknown>
}

// ── 任务（Task）───────────────────────────────────────────────────────

export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'

/** 终态集合：再收到任何状态迁移都是协议错误。 */
export const TERMINAL_STATES: readonly TaskState[] = [
  'completed',
  'failed',
  'canceled',
  'rejected',
]

export interface TaskStatus {
  readonly state: TaskState
  readonly message?: A2aMessage
  /** RFC 3339 时间戳。 */
  readonly timestamp: string
}

export interface A2aTask {
  readonly kind: 'task'
  readonly id: string
  readonly contextId: string
  readonly status: TaskStatus
  readonly artifacts?: readonly Artifact[]
  readonly history?: readonly A2aMessage[]
  readonly metadata?: Record<string, unknown>
}

// ── 流事件（SSE events）──────────────────────────────────────────────

export interface TaskStatusUpdateEvent {
  readonly kind: 'status-update'
  readonly taskId: string
  readonly contextId: string
  readonly status: TaskStatus
  /** true = 本任务不再产生后续事件。 */
  readonly final: boolean
}

export interface TaskArtifactUpdateEvent {
  readonly kind: 'artifact-update'
  readonly taskId: string
  readonly contextId: string
  readonly artifact: Artifact
  readonly append?: boolean
  readonly lastChunk?: boolean
  readonly metadata?: Record<string, unknown>
}

export type TaskEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent

// ── Agent Card ────────────────────────────────────────────────────────

export interface AgentSkill {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly tags?: readonly string[]
  readonly inputModes?: readonly string[]
  readonly outputModes?: readonly string[]
}

export interface AgentCapabilities {
  readonly streaming: boolean
  readonly pushNotifications: boolean
  readonly stateTransitionHistory: boolean
}

/** A2A v1.0 卡片接口声明（`supportedInterfaces[]`）。 */
export interface AgentInterface {
  readonly url: string
  readonly protocolBinding?: string
  readonly protocolVersion?: string
}

export interface AgentCard {
  readonly name: string
  readonly description?: string
  readonly url: string
  /**
   * A2A v1.0 的接口列表形态：部分实现（如 pi-a2a）只给
   * `supportedInterfaces[].url`，不写顶层 `url`。客户端解析时兼容两种形态。
   */
  readonly supportedInterfaces?: readonly AgentInterface[]
  readonly version: string
  readonly protocolVersion: string
  readonly preferredTransport: 'JSONRPC'
  readonly capabilities: AgentCapabilities
  readonly defaultInputModes: readonly string[]
  readonly defaultOutputModes: readonly string[]
  readonly skills: readonly AgentSkill[]
  readonly provider?: {
    readonly organization: string
    readonly url?: string
  }
  readonly securitySchemes?: Record<string, {
    readonly type: string
    readonly scheme?: string
    readonly bearerFormat?: string
  }>
  readonly security?: readonly Record<string, readonly string[]>[]
  /** 扩展字段：本插件的运行模式（对人类诊断有用，客户端应忽略）。 */
  readonly 'x-dsh-a2a'?: Record<string, unknown>
}

/** Agent Card 构造入参（secret 已解析后的形态）。 */
export interface CardOptions {
  name: string
  description?: string
  /** 客户端回连本 agent 的 JSON-RPC 绝对地址。 */
  url: string
  /** agent 自身版本（非协议版本）。 */
  version: string
  skills?: readonly AgentSkill[]
  /** 配置了 bearer 鉴权时提供 token，卡片将宣告 bearerAuth 方案。 */
  bearerToken?: string
  providerOrganization?: string
  extra?: Record<string, unknown>
}

export function buildAgentCard(options: CardOptions): AgentCard {
  const card: AgentCard = {
    name: options.name,
    ...(options.description !== undefined ? { description: options.description } : {}),
    url: options.url,
    version: options.version,
    protocolVersion: PROTOCOL_VERSION,
    preferredTransport: 'JSONRPC',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: options.skills && options.skills.length > 0
      ? [...options.skills]
      : [{
          id: 'dsh-agent',
          name: 'DeepSeek Harness Agent',
          description: '通过 A2A 协议与 DeepSeek Harness（DSH）agent 会话交互：发送指令、获得执行结果文本。',
          tags: ['dsh', 'deepseek', 'harness', 'automation'],
        }],
    ...(options.providerOrganization
      ? { provider: { organization: options.providerOrganization } }
      : {}),
    ...(options.bearerToken
      ? {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT-or-opaque' },
          },
          security: [{ bearerAuth: [] }],
        }
      : { security: [] }),
    ...(options.extra !== undefined ? { 'x-dsh-a2a': options.extra } : {}),
  }
  return card
}

// ── JSON-RPC 2.0 ──────────────────────────────────────────────────────

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcSuccess {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly result: unknown
}

export interface JsonRpcErrorBody {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export interface JsonRpcFailure {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly error: JsonRpcErrorBody
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

/** JSON-RPC 标准错误码。 */
export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

/** A2A 规范定义的服务端错误码。 */
export const A2A_ERRORS = {
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
} as const

export function jsonrpcResult(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result }
}

export function jsonrpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}

/** 解析并校验单个（非批量）JSON-RPC 请求；失败返回错误字符串。 */
export function parseJsonRpcRequest(raw: unknown): { ok: true; request: JsonRpcRequest } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '请求必须是单个 JSON-RPC 对象（A2A 不支持批量请求）' }
  }
  const obj = raw as Record<string, unknown>
  if (obj.jsonrpc !== '2.0') {
    return { ok: false, error: 'jsonrpc 字段必须为 "2.0"' }
  }
  if (typeof obj.method !== 'string' || obj.method.length === 0) {
    return { ok: false, error: 'method 必须是非空字符串' }
  }
  const id = obj.id
  if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') {
    return { ok: false, error: 'id 必须是 string / number / null' }
  }
  return {
    ok: true,
    request: {
      jsonrpc: '2.0',
      id: (id ?? null) as string | number | null,
      method: obj.method,
      ...(obj.params !== undefined ? { params: obj.params } : {}),
    },
  }
}

// ── message/send、message/stream 参数 ────────────────────────────────

export interface MessageSendParams {
  readonly message: A2aMessage
  readonly configuration?: {
    readonly blocking?: boolean
    readonly acceptedOutputModes?: readonly string[]
  }
}

/**
 * 解析 message/send、message/stream 的 params；补齐缺失的 messageId /
 * contextId（服务端生成），并校验 parts 形态。失败返回给客户端的错误文本。
 */
export function parseMessageSendParams(raw: unknown): { ok: true; params: MessageSendParams } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'params 必须是对象' }
  }
  const obj = raw as Record<string, unknown>
  const messageRaw = obj.message
  if (messageRaw === null || typeof messageRaw !== 'object') {
    return { ok: false, error: 'params.message 必须是对象' }
  }
  const m = messageRaw as Record<string, unknown>
  if (m.role !== 'user' && m.role !== 'agent') {
    return { ok: false, error: 'message.role 必须是 "user" 或 "agent"' }
  }
  if (!Array.isArray(m.parts) || m.parts.length === 0) {
    return { ok: false, error: 'message.parts 必须是非空数组' }
  }
  const parts: Part[] = []
  for (const p of m.parts) {
    if (p === null || typeof p !== 'object') {
      return { ok: false, error: 'message.parts[] 的每一项必须是对象' }
    }
    const part = p as Record<string, unknown>
    if (part.kind === 'text' && typeof part.text === 'string') {
      parts.push({ kind: 'text', text: part.text })
    } else if (part.kind === 'data' && part.data !== null && typeof part.data === 'object' && !Array.isArray(part.data)) {
      parts.push({ kind: 'data', data: part.data as Record<string, unknown> })
    } else if (
      part.kind === 'file' && part.file !== null && typeof part.file === 'object'
      && (typeof (part.file as Record<string, unknown>).uri === 'string'
        || typeof (part.file as Record<string, unknown>).bytes === 'string')
    ) {
      parts.push({ kind: 'file', file: part.file as FilePart['file'] })
    } else {
      return { ok: false, error: 'message.parts[] 含不支持的 part（kind 必须是 text/data/file 且形态合法）' }
    }
  }
  const messageId = typeof m.messageId === 'string' && m.messageId.length > 0 ? m.messageId : randomUUID()
  const contextId = typeof m.contextId === 'string' && m.contextId.length > 0 ? m.contextId : undefined
  const taskId = typeof m.taskId === 'string' && m.taskId.length > 0 ? m.taskId : undefined
  const message: A2aMessage = {
    kind: 'message',
    role: m.role,
    parts,
    messageId,
    ...(taskId !== undefined ? { taskId } : {}),
    // contextId 未提供时由服务器补（见 server.ts：同一缺省上下文 = 无状态）。
    ...(contextId !== undefined ? { contextId } : {}),
  }
  return { ok: true, params: { message, ...(obj.configuration !== undefined ? { configuration: obj.configuration as MessageSendParams['configuration'] } : {}) } }
}

// ── 小工具 ─────────────────────────────────────────────────────────────

/** 提取消息中的全部文本（text part 顺序拼接；无文本 part 返回空串）。 */
export function extractText(parts: readonly Part[]): string {
  let out = ''
  for (const p of parts) {
    if (p.kind === 'text') out += p.text
  }
  return out
}

/** data/file part 的简要描述（用于日志与诊断，不参与正文）。 */
export function describeNonTextParts(parts: readonly Part[]): string[] {
  const out: string[] = []
  for (const p of parts) {
    if (p.kind === 'data') out.push('[data part]')
    else if (p.kind === 'file') out.push(p.file.name ? `[file: ${p.file.name}]` : `[file: ${p.file.uri ?? 'inline'}]`)
  }
  return out
}

/** 当前时间的 RFC 3339 时间戳。 */
export function nowTimestamp(): string {
  return new Date().toISOString()
}

/** 终态判断。 */
export function isTerminalState(state: TaskState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state)
}
