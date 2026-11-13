/**
 * A2A（Agent2Agent）协议类型与纯函数工具：消息/任务/事件结构、
 * JSON-RPC 2.0 信封、错误码、Agent Card 构造与参数校验。
 *
 * 本模块零依赖（不 import DSH / cordis / node API 之外的任何包），
 * 服务器、客户端、冒烟测试共用，保证三端看到同一份 wire 契约。
 *
 * 版本策略（1.0 原生）：
 * - 对外（wire）以 A2A 1.0 为准：`supportedInterfaces` / `protocolVersion: "1.0"`、
 *   `SendMessage` 等方法名、SCREAMING_SNAKE_CASE 状态与角色、**无 `kind` 的 part**；
 * - 对内（store / bridge / persistence）保持历史内部形态（小写状态 `completed`、
 *   `{kind:'text'}` part、`{kind:'message'}` 消息），由本模块的 `toV1*`
 *   转换器在出口处统一改写——bridge/store 一行都不用动；
 * - 入站两种形态都收（有/无 `kind`、`ROLE_USER`/`user`、旧方法名），
 *   兼容 0.3.x 客户端（`/.well-known/agent-card.json`、`A2A-Version` 头）。
 *
 * @module dsh-a2a/protocol
 */

import { randomUUID } from 'node:crypto'

// ── 常量 ────────────────────────────────────────────────────────────────

/** 本实现宣告/应答的 A2A 协议版本（1.0 原生）。 */
export const PROTOCOL_VERSION = '1.0'

/** Agent Card 的 1.0 / 0.3.x 标准路径。 */
export const CARD_PATH = '/.well-known/agent-card.json'
/** Agent Card 的 0.2.x 旧路径（同时保留，兼容旧客户端）。 */
export const CARD_LEGACY_PATH = '/.well-known/agent.json'

// ── 消息部件（Parts）──────────────────────────────────────────────────
//
// 内部形态以 `kind` 判别（store / bridge / client 沿用）；1.0 的 wire 形态
// 没有 `kind`，用成员存在性判别（`text` / `data` / `file` 之一）。

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

/** A2A 1.0 content（无 `kind`，成员存在性判别）。 */
export interface V1TextPart {
  readonly text: string
  readonly mediaType?: string
  readonly metadata?: Record<string, unknown>
}

export interface V1DataPart {
  readonly data: Record<string, unknown>
  readonly mediaType?: string
  readonly metadata?: Record<string, unknown>
}

export interface V1FilePart {
  readonly file: FilePart['file']
  readonly mediaType?: string
  readonly metadata?: Record<string, unknown>
}

export type V1Part = V1TextPart | V1DataPart | V1FilePart

// ── 消息 / 产物（Message / Artifact）──────────────────────────────────

/** 内部角色名（0.3 形态）。 */
export type MessageRole = 'user' | 'agent'

/** A2A 1.0（ProtoJSON 枚举）角色名。 */
export type WireRole = 'ROLE_USER' | 'ROLE_AGENT'

export interface A2aMessage {
  readonly kind: 'message'
  readonly role: MessageRole
  readonly parts: readonly Part[]
  readonly messageId: string
  readonly taskId?: string
  readonly contextId?: string
  readonly metadata?: Record<string, unknown>
}

/** A2A 1.0 Message（无 `kind`，role 为 `ROLE_*`，parts 无 `kind`）。 */
export interface V1Message {
  readonly role: WireRole
  readonly parts: readonly V1Part[]
  readonly messageId?: string
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

/** A2A 1.0 Artifact（无 `kind`，parts 无 `kind`）。 */
export interface V1Artifact {
  readonly artifactId: string
  readonly name?: string
  readonly description?: string
  readonly parts: readonly V1Part[]
  readonly metadata?: Record<string, unknown>
}

// ── 任务（Task）───────────────────────────────────────────────────────

/** 内部任务状态（小写，store / bridge 沿用）。 */
export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'

/** A2A 1.0（ProtoJSON 枚举）任务状态。 */
export type TaskStateV1 =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_REJECTED'

/** 内部终态集合：再收到任何状态迁移都是协议错误。 */
export const TERMINAL_STATES: readonly TaskState[] = [
  'completed',
  'failed',
  'canceled',
  'rejected',
]

/** 内部状态 → A2A 1.0（ProtoJSON 枚举）状态。 */
const STATE_TO_V1: Readonly<Record<string, TaskStateV1>> = {
  submitted: 'TASK_STATE_SUBMITTED',
  working: 'TASK_STATE_WORKING',
  'input-required': 'TASK_STATE_INPUT_REQUIRED',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  canceled: 'TASK_STATE_CANCELED',
  rejected: 'TASK_STATE_REJECTED',
}

/** 入站状态归一化表（1.0 枚举 / 0.3 小写 都接受）。 */
const STATE_FROM_WIRE: Readonly<Record<string, TaskState>> = (() => {
  const table: Record<string, TaskState> = {}
  for (const [internal, wire] of Object.entries(STATE_TO_V1)) {
    table[internal] = internal as TaskState
    table[wire] = internal as TaskState
  }
  return table
})()

/** 内部状态名 → 1.0 枚举名（未知状态原样透传，便于排障）。 */
export function toV1State(state: string): TaskStateV1 {
  return STATE_TO_V1[state] ?? (state as TaskStateV1)
}

/** wire 状态名 → 内部状态名（同时接受 0.3 小写与 1.0 枚举）。 */
export function toInternalState(state: string): TaskState {
  return STATE_FROM_WIRE[state] ?? (state as TaskState)
}

export interface TaskStatus {
  readonly state: TaskState
  readonly message?: A2aMessage
  /** RFC 3339 时间戳。 */
  readonly timestamp: string
}

/** A2A 1.0 TaskStatus（state 为 `TASK_STATE_*`，message 无 `kind`）。 */
export interface V1TaskStatus {
  readonly state: TaskStateV1
  readonly message?: V1Message
  /** RFC 3339 时间戳。 */
  readonly timestamp?: string
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

/** A2A 1.0 Task（无 `kind`、状态枚举化、parts 无 `kind`）。 */
export interface V1Task {
  readonly id?: string
  readonly contextId?: string
  readonly status: V1TaskStatus
  readonly artifacts?: readonly V1Artifact[]
  readonly history?: readonly V1Message[]
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

/**
 * A2A 1.0 StreamResponse（oneof，成员存在性判别）：
 * `statusUpdate` / `artifactUpdate` / `task`。
 * 1.0 的终态由 SSE 关闭本身表达（无 `final` 字段）。
 */
export interface V1StatusUpdate {
  readonly taskId?: string
  readonly contextId?: string
  readonly status: V1TaskStatus
}

export interface V1ArtifactUpdate {
  readonly taskId?: string
  readonly contextId?: string
  readonly artifact: V1Artifact
  readonly lastChunk?: boolean
  readonly append?: boolean
  readonly metadata?: Record<string, unknown>
}

export interface V1StreamResponse {
  readonly statusUpdate?: V1StatusUpdate
  readonly artifactUpdate?: V1ArtifactUpdate
  readonly task?: V1Task
}

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

/** A2A 1.0 的传输接口声明（客户端据此选协议版本与绑定）。 */
export interface AgentInterface {
  readonly url: string
  readonly protocolBinding: 'JSONRPC'
  readonly protocolVersion: string
}

export interface AgentCard {
  readonly name: string
  readonly description?: string
  readonly url: string
  readonly version: string
  readonly protocolVersion: string
  /** 1.0 的规范位置（0.3 只认 url + preferredTransport）。 */
  readonly supportedInterfaces: readonly AgentInterface[]
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
    // 1.0 的规范位置：客户端按 supportedInterfaces 选传输与协议版本。
    supportedInterfaces: [{
      url: options.url,
      protocolBinding: 'JSONRPC',
      protocolVersion: PROTOCOL_VERSION,
    }],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
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

// ── SendMessage / SendStreamingMessage 参数 ──────────────────────────

export interface MessageSendParams {
  readonly message: A2aMessage
  readonly configuration?: {
    readonly blocking?: boolean
    readonly acceptedOutputModes?: readonly string[]
  }
}

/** 入站 role 归一化：1.0 ProtoJSON 枚举 → 内部 Role。 */
const ROLE_FROM_WIRE: Readonly<Record<string, MessageRole>> = {
  ROLE_USER: 'user',
  ROLE_AGENT: 'agent',
}

/**
 * 解析 SendMessage / SendStreamingMessage / message/send 的 params；
 * 补齐缺失的 messageId / contextId（服务端生成），并校验 parts 形态。
 * 失败返回给客户端的错误文本。
 *
 * 入站契约（双形态都收）：
 * - role：`ROLE_USER`/`ROLE_AGENT`（1.0 枚举）与 `user`/`agent`（0.3）；
 * - parts：`{text}`（1.0，成员存在性判别）与 `{kind:'text',text}`（0.3），
 *   额外的 `mediaType`/`mimeType` 一律忽略。
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
  const rawRole = m.role
  const role = typeof rawRole === 'string' ? (ROLE_FROM_WIRE[rawRole] ?? rawRole) : rawRole
  if (role !== 'user' && role !== 'agent') {
    return { ok: false, error: 'message.role 必须是 ROLE_USER / ROLE_AGENT（或 user / agent）' }
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
      // 0.3 形态：显式 kind 判别。
      parts.push({ kind: 'text', text: part.text })
    } else if (part.kind === undefined && typeof part.text === 'string') {
      // 1.0 形态：无 kind 的 text part，用成员存在性判别（多余 mediaType 忽略）。
      parts.push({ kind: 'text', text: part.text })
    } else if (
      (part.kind === 'data' || part.kind === undefined)
      && part.data !== null && typeof part.data === 'object' && !Array.isArray(part.data)
    ) {
      // 1.0 的 data part 同样无 kind。
      parts.push({ kind: 'data', data: part.data as Record<string, unknown> })
    } else if (
      (part.kind === 'file' || part.kind === undefined)
      && part.file !== null && typeof part.file === 'object'
      && (typeof (part.file as Record<string, unknown>).uri === 'string'
        || typeof (part.file as Record<string, unknown>).bytes === 'string')
    ) {
      // 1.0 的 file part 同样无 kind。
      parts.push({ kind: 'file', file: part.file as FilePart['file'] })
    } else {
      return { ok: false, error: 'message.parts[] 含不支持的 part（须含 text / data / file 之一，可选 kind）' }
    }
  }
  const messageId = typeof m.messageId === 'string' && m.messageId.length > 0 ? m.messageId : randomUUID()
  const contextId = typeof m.contextId === 'string' && m.contextId.length > 0 ? m.contextId : undefined
  const taskId = typeof m.taskId === 'string' && m.taskId.length > 0 ? m.taskId : undefined
  const message: A2aMessage = {
    kind: 'message',
    role,
    parts,
    messageId,
    ...(taskId !== undefined ? { taskId } : {}),
    // contextId 未提供时由服务器补（见 server.ts：同一缺省上下文 = 无状态）。
    ...(contextId !== undefined ? { contextId } : {}),
  }
  return { ok: true, params: { message, ...(obj.configuration !== undefined ? { configuration: obj.configuration as MessageSendParams['configuration'] } : {}) } }
}

// ── 出口转换（内部形态 → A2A 1.0 wire 形态）─────────────────────────────

/** 造一个 1.0 text part（成员存在性判别，无 kind）。 */
export function textPart(text: string, mediaType = 'text/plain'): V1TextPart {
  return { text, mediaType }
}

/** 内部 part（`{kind}`）→ 1.0 part（无 kind，用成员存在性判别）。 */
export function toV1Part(part: Part): V1Part {
  switch (part.kind) {
    case 'text':
      return { text: part.text, mediaType: 'text/plain' }
    case 'data':
      return { data: part.data, mediaType: 'application/json' }
    case 'file':
      return { file: part.file, mediaType: part.file.mimeType ?? 'application/octet-stream' }
    default: {
      // 未知形态：去掉 kind 后原样透传。
      const { kind: _kind, ...rest } = part as unknown as Record<string, unknown>
      return rest as unknown as V1Part
    }
  }
}

/** 内部 parts 数组 → 1.0 parts 数组。 */
export function toV1Parts(parts: readonly Part[]): V1Part[] {
  return Array.isArray(parts) ? parts.map(toV1Part) : []
}

/** 内部 message（`kind:'message'`，role user/agent）→ 1.0 Message（ROLE_*，无 kind）。 */
export function toV1Message(message: A2aMessage): V1Message {
  const role: WireRole = message.role === 'agent' ? 'ROLE_AGENT' : 'ROLE_USER'
  return {
    role,
    parts: toV1Parts(message.parts),
    ...(typeof message.messageId === 'string' ? { messageId: message.messageId } : {}),
    ...(typeof message.taskId === 'string' ? { taskId: message.taskId } : {}),
    ...(typeof message.contextId === 'string' ? { contextId: message.contextId } : {}),
  }
}

/** 内部 status → 1.0 TaskStatus（state 用 TASK_STATE_*，message 用 ROLE_AGENT）。 */
export function toV1Status(status: TaskStatus): V1TaskStatus {
  return {
    state: toV1State(status.state),
    ...(status.message !== undefined ? { message: toV1Message(status.message) } : {}),
    ...(typeof status.timestamp === 'string' ? { timestamp: status.timestamp } : {}),
  }
}

/** 内部 artifact（`kind:'artifact'`）→ 1.0 Artifact（无 kind、parts 无 kind）。 */
export function toV1Artifact(artifact: Artifact): V1Artifact {
  return {
    artifactId: artifact.artifactId,
    ...(artifact.name !== undefined ? { name: artifact.name } : {}),
    ...(artifact.description !== undefined ? { description: artifact.description } : {}),
    parts: toV1Parts(artifact.parts),
  }
}

/** 内部 task 快照 → 1.0 Task（无 kind、无 createdAt）。 */
export function toV1Task(snapshot: A2aTask): V1Task {
  return {
    id: snapshot.id,
    contextId: snapshot.contextId,
    status: toV1Status(snapshot.status),
    ...(Array.isArray(snapshot.artifacts) && snapshot.artifacts.length > 0
      ? { artifacts: snapshot.artifacts.map(toV1Artifact) }
      : {}),
    ...(Array.isArray(snapshot.history) && snapshot.history.length > 0
      ? { history: snapshot.history.map(toV1Message) }
      : {}),
  }
}

/**
 * 内部流事件（`{kind:'status-update'}` / `{kind:'artifact-update'}`）→
 * 1.0 StreamResponse（成员存在性判别：`statusUpdate` / `artifactUpdate` / `task`）。
 */
export function toV1StreamEvent(event: TaskEvent): V1StreamResponse {
  if (event.kind === 'artifact-update') {
    return {
      artifactUpdate: {
        taskId: event.taskId,
        contextId: event.contextId,
        artifact: toV1Artifact(event.artifact),
        ...(event.lastChunk !== undefined ? { lastChunk: event.lastChunk } : {}),
      },
    }
  }
  return {
    statusUpdate: {
      taskId: event.taskId,
      contextId: event.contextId,
      status: toV1Status(event.status),
    },
  }
}

/** 内部任务快照 → 1.0 SendMessageResponse（oneof：`task`）。 */
export function toV1TaskResponse(snapshot: A2aTask): { task: V1Task } {
  return { task: toV1Task(snapshot) }
}

// ── 小工具 ─────────────────────────────────────────────────────────────

/** 判断 part 是否承载文本（内部带 kind，1.0 入站无 kind）。 */
function isTextPart(part: Part | V1Part): part is TextPart | V1TextPart {
  const kind = (part as { kind?: unknown }).kind
  if (kind !== undefined && kind !== 'text') return false
  return typeof (part as { text?: unknown }).text === 'string'
}

/** 提取消息中的全部文本（text part 顺序拼接；无文本 part 返回空串）。 */
export function extractText(parts: readonly (Part | V1Part)[]): string {
  let out = ''
  for (const p of parts) {
    if (isTextPart(p)) out += p.text
  }
  return out
}

/** data/file part 的简要描述（用于日志与诊断，不参与正文）。 */
export function describeNonTextParts(parts: readonly (Part | V1Part)[]): string[] {
  const out: string[] = []
  for (const p of parts) {
    const kind = (p as { kind?: unknown }).kind
      ?? ((p as V1DataPart).data !== undefined ? 'data' : (p as V1FilePart).file !== undefined ? 'file' : undefined)
    if (kind === 'data') out.push('[data part]')
    else if (kind === 'file') {
      const file = (p as FilePart | V1FilePart).file
      out.push(file.name ? `[file: ${file.name}]` : `[file: ${file.uri ?? 'inline'}]`)
    }
  }
  return out
}

/** 当前时间的 RFC 3339 时间戳。 */
export function nowTimestamp(): string {
  return new Date().toISOString()
}

/** 终态判断（同时接受内部小写状态与 1.0 TASK_STATE_* 枚举）。 */
export function isTerminalState(state: string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(toInternalState(state))
}

/** input-required 判断（接受两种写法）。 */
export function isInputRequiredState(state: string): boolean {
  return toInternalState(state) === 'input-required'
}
