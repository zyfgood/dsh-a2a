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
/** 本实现宣告/应答的 A2A 协议版本（1.0 原生）。 */
export declare const PROTOCOL_VERSION = "1.0";
/** Agent Card 的 1.0 / 0.3.x 标准路径。 */
export declare const CARD_PATH = "/.well-known/agent-card.json";
/** Agent Card 的 0.2.x 旧路径（同时保留，兼容旧客户端）。 */
export declare const CARD_LEGACY_PATH = "/.well-known/agent.json";
export interface TextPart {
    readonly kind: 'text';
    readonly text: string;
    readonly metadata?: Record<string, unknown>;
}
export interface DataPart {
    readonly kind: 'data';
    readonly data: Record<string, unknown>;
    readonly metadata?: Record<string, unknown>;
}
export interface FilePart {
    readonly kind: 'file';
    readonly file: {
        /** base64 编码的字节（与 uri 二选一）。 */
        readonly bytes?: string;
        readonly uri?: string;
        readonly mimeType?: string;
        readonly name?: string;
    };
    readonly metadata?: Record<string, unknown>;
}
export type Part = TextPart | DataPart | FilePart;
/** A2A 1.0 content（无 `kind`，成员存在性判别）。 */
export interface V1TextPart {
    readonly text: string;
    readonly mediaType?: string;
    readonly metadata?: Record<string, unknown>;
}
export interface V1DataPart {
    readonly data: Record<string, unknown>;
    readonly mediaType?: string;
    readonly metadata?: Record<string, unknown>;
}
export interface V1FilePart {
    readonly file: FilePart['file'];
    readonly mediaType?: string;
    readonly metadata?: Record<string, unknown>;
}
export type V1Part = V1TextPart | V1DataPart | V1FilePart;
/** 内部角色名（0.3 形态）。 */
export type MessageRole = 'user' | 'agent';
/** A2A 1.0（ProtoJSON 枚举）角色名。 */
export type WireRole = 'ROLE_USER' | 'ROLE_AGENT';
export interface A2aMessage {
    readonly kind: 'message';
    readonly role: MessageRole;
    readonly parts: readonly Part[];
    readonly messageId: string;
    readonly taskId?: string;
    readonly contextId?: string;
    readonly metadata?: Record<string, unknown>;
}
/** A2A 1.0 Message（无 `kind`，role 为 `ROLE_*`，parts 无 `kind`）。 */
export interface V1Message {
    readonly role: WireRole;
    readonly parts: readonly V1Part[];
    readonly messageId?: string;
    readonly taskId?: string;
    readonly contextId?: string;
    readonly metadata?: Record<string, unknown>;
}
export interface Artifact {
    readonly kind: 'artifact';
    readonly artifactId: string;
    readonly name?: string;
    readonly description?: string;
    readonly parts: readonly Part[];
    readonly metadata?: Record<string, unknown>;
}
/** A2A 1.0 Artifact（无 `kind`，parts 无 `kind`）。 */
export interface V1Artifact {
    readonly artifactId: string;
    readonly name?: string;
    readonly description?: string;
    readonly parts: readonly V1Part[];
    readonly metadata?: Record<string, unknown>;
}
/** 内部任务状态（小写，store / bridge 沿用）。 */
export type TaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled' | 'rejected';
/** A2A 1.0（ProtoJSON 枚举）任务状态。 */
export type TaskStateV1 = 'TASK_STATE_SUBMITTED' | 'TASK_STATE_WORKING' | 'TASK_STATE_INPUT_REQUIRED' | 'TASK_STATE_COMPLETED' | 'TASK_STATE_FAILED' | 'TASK_STATE_CANCELED' | 'TASK_STATE_REJECTED';
/** 内部终态集合：再收到任何状态迁移都是协议错误。 */
export declare const TERMINAL_STATES: readonly TaskState[];
/** 内部状态名 → 1.0 枚举名（未知状态原样透传，便于排障）。 */
export declare function toV1State(state: string): TaskStateV1;
/** wire 状态名 → 内部状态名（同时接受 0.3 小写与 1.0 枚举）。 */
export declare function toInternalState(state: string): TaskState;
export interface TaskStatus {
    readonly state: TaskState;
    readonly message?: A2aMessage;
    /** RFC 3339 时间戳。 */
    readonly timestamp: string;
}
/** A2A 1.0 TaskStatus（state 为 `TASK_STATE_*`，message 无 `kind`）。 */
export interface V1TaskStatus {
    readonly state: TaskStateV1;
    readonly message?: V1Message;
    /** RFC 3339 时间戳。 */
    readonly timestamp?: string;
}
export interface A2aTask {
    readonly kind: 'task';
    readonly id: string;
    readonly contextId: string;
    readonly status: TaskStatus;
    readonly artifacts?: readonly Artifact[];
    readonly history?: readonly A2aMessage[];
    readonly metadata?: Record<string, unknown>;
}
/** A2A 1.0 Task（无 `kind`、状态枚举化、parts 无 `kind`）。 */
export interface V1Task {
    readonly id?: string;
    readonly contextId?: string;
    readonly status: V1TaskStatus;
    readonly artifacts?: readonly V1Artifact[];
    readonly history?: readonly V1Message[];
    readonly metadata?: Record<string, unknown>;
}
export interface TaskStatusUpdateEvent {
    readonly kind: 'status-update';
    readonly taskId: string;
    readonly contextId: string;
    readonly status: TaskStatus;
    /** true = 本任务不再产生后续事件。 */
    readonly final: boolean;
}
export interface TaskArtifactUpdateEvent {
    readonly kind: 'artifact-update';
    readonly taskId: string;
    readonly contextId: string;
    readonly artifact: Artifact;
    readonly append?: boolean;
    readonly lastChunk?: boolean;
    readonly metadata?: Record<string, unknown>;
}
export type TaskEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;
/**
 * A2A 1.0 StreamResponse（oneof，成员存在性判别）：
 * `statusUpdate` / `artifactUpdate` / `task`。
 * 1.0 的终态由 SSE 关闭本身表达（无 `final` 字段）。
 */
export interface V1StatusUpdate {
    readonly taskId?: string;
    readonly contextId?: string;
    readonly status: V1TaskStatus;
}
export interface V1ArtifactUpdate {
    readonly taskId?: string;
    readonly contextId?: string;
    readonly artifact: V1Artifact;
    readonly lastChunk?: boolean;
    readonly append?: boolean;
    readonly metadata?: Record<string, unknown>;
}
export interface V1StreamResponse {
    readonly statusUpdate?: V1StatusUpdate;
    readonly artifactUpdate?: V1ArtifactUpdate;
    readonly task?: V1Task;
}
export interface AgentSkill {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly tags?: readonly string[];
    readonly inputModes?: readonly string[];
    readonly outputModes?: readonly string[];
}
export interface AgentCapabilities {
    readonly streaming: boolean;
    readonly pushNotifications: boolean;
    readonly stateTransitionHistory: boolean;
}
/** A2A 1.0 的传输接口声明（客户端据此选协议版本与绑定）。 */
export interface AgentInterface {
    readonly url: string;
    readonly protocolBinding: 'JSONRPC';
    readonly protocolVersion: string;
}
export interface AgentCard {
    readonly name: string;
    readonly description?: string;
    readonly url: string;
    readonly version: string;
    readonly protocolVersion: string;
    /** 1.0 的规范位置（0.3 只认 url + preferredTransport）。 */
    readonly supportedInterfaces: readonly AgentInterface[];
    readonly preferredTransport: 'JSONRPC';
    readonly capabilities: AgentCapabilities;
    readonly defaultInputModes: readonly string[];
    readonly defaultOutputModes: readonly string[];
    readonly skills: readonly AgentSkill[];
    readonly provider?: {
        readonly organization: string;
        readonly url?: string;
    };
    readonly securitySchemes?: Record<string, {
        readonly type: string;
        readonly scheme?: string;
        readonly bearerFormat?: string;
    }>;
    readonly security?: readonly Record<string, readonly string[]>[];
    /** 扩展字段：本插件的运行模式（对人类诊断有用，客户端应忽略）。 */
    readonly 'x-dsh-a2a'?: Record<string, unknown>;
}
/** Agent Card 构造入参（secret 已解析后的形态）。 */
export interface CardOptions {
    name: string;
    description?: string;
    /** 客户端回连本 agent 的 JSON-RPC 绝对地址。 */
    url: string;
    /** agent 自身版本（非协议版本）。 */
    version: string;
    skills?: readonly AgentSkill[];
    /** 配置了 bearer 鉴权时提供 token，卡片将宣告 bearerAuth 方案。 */
    bearerToken?: string;
    providerOrganization?: string;
    extra?: Record<string, unknown>;
}
export declare function buildAgentCard(options: CardOptions): AgentCard;
export interface JsonRpcRequest {
    readonly jsonrpc: '2.0';
    readonly id: string | number | null;
    readonly method: string;
    readonly params?: unknown;
}
export interface JsonRpcSuccess {
    readonly jsonrpc: '2.0';
    readonly id: string | number | null;
    readonly result: unknown;
}
export interface JsonRpcErrorBody {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
}
export interface JsonRpcFailure {
    readonly jsonrpc: '2.0';
    readonly id: string | number | null;
    readonly error: JsonRpcErrorBody;
}
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
/** JSON-RPC 标准错误码。 */
export declare const RPC_ERRORS: {
    readonly PARSE_ERROR: -32700;
    readonly INVALID_REQUEST: -32600;
    readonly METHOD_NOT_FOUND: -32601;
    readonly INVALID_PARAMS: -32602;
    readonly INTERNAL_ERROR: -32603;
};
/** A2A 规范定义的服务端错误码。 */
export declare const A2A_ERRORS: {
    readonly TASK_NOT_FOUND: -32001;
    readonly TASK_NOT_CANCELABLE: -32002;
    readonly PUSH_NOTIFICATION_NOT_SUPPORTED: -32003;
    readonly UNSUPPORTED_OPERATION: -32004;
    readonly CONTENT_TYPE_NOT_SUPPORTED: -32005;
};
export declare function jsonrpcResult(id: string | number | null, result: unknown): JsonRpcSuccess;
export declare function jsonrpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcFailure;
/** 解析并校验单个（非批量）JSON-RPC 请求；失败返回错误字符串。 */
export declare function parseJsonRpcRequest(raw: unknown): {
    ok: true;
    request: JsonRpcRequest;
} | {
    ok: false;
    error: string;
};
export interface MessageSendParams {
    readonly message: A2aMessage;
    readonly configuration?: {
        readonly blocking?: boolean;
        readonly acceptedOutputModes?: readonly string[];
    };
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
export declare function parseMessageSendParams(raw: unknown): {
    ok: true;
    params: MessageSendParams;
} | {
    ok: false;
    error: string;
};
/** 造一个 1.0 text part（成员存在性判别，无 kind）。 */
export declare function textPart(text: string, mediaType?: string): V1TextPart;
/** 内部 part（`{kind}`）→ 1.0 part（无 kind，用成员存在性判别）。 */
export declare function toV1Part(part: Part): V1Part;
/** 内部 parts 数组 → 1.0 parts 数组。 */
export declare function toV1Parts(parts: readonly Part[]): V1Part[];
/** 内部 message（`kind:'message'`，role user/agent）→ 1.0 Message（ROLE_*，无 kind）。 */
export declare function toV1Message(message: A2aMessage): V1Message;
/** 内部 status → 1.0 TaskStatus（state 用 TASK_STATE_*，message 用 ROLE_AGENT）。 */
export declare function toV1Status(status: TaskStatus): V1TaskStatus;
/** 内部 artifact（`kind:'artifact'`）→ 1.0 Artifact（无 kind、parts 无 kind）。 */
export declare function toV1Artifact(artifact: Artifact): V1Artifact;
/** 内部 task 快照 → 1.0 Task（无 kind、无 createdAt）。 */
export declare function toV1Task(snapshot: A2aTask): V1Task;
/**
 * 内部流事件（`{kind:'status-update'}` / `{kind:'artifact-update'}`）→
 * 1.0 StreamResponse（成员存在性判别：`statusUpdate` / `artifactUpdate` / `task`）。
 */
export declare function toV1StreamEvent(event: TaskEvent): V1StreamResponse;
/** 内部任务快照 → 1.0 SendMessageResponse（oneof：`task`）。 */
export declare function toV1TaskResponse(snapshot: A2aTask): {
    task: V1Task;
};
/** 提取消息中的全部文本（text part 顺序拼接；无文本 part 返回空串）。 */
export declare function extractText(parts: readonly (Part | V1Part)[]): string;
/** data/file part 的简要描述（用于日志与诊断，不参与正文）。 */
export declare function describeNonTextParts(parts: readonly (Part | V1Part)[]): string[];
/** 当前时间的 RFC 3339 时间戳。 */
export declare function nowTimestamp(): string;
/** 终态判断（同时接受内部小写状态与 1.0 TASK_STATE_* 枚举）。 */
export declare function isTerminalState(state: string): boolean;
/** input-required 判断（接受两种写法）。 */
export declare function isInputRequiredState(state: string): boolean;
//# sourceMappingURL=protocol.d.ts.map