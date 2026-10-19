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
/** 本实现宣告/应答的 A2A 协议版本。 */
export declare const PROTOCOL_VERSION = "0.3.0";
/** Agent Card 的 0.3.x 标准路径。 */
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
export type MessageRole = 'user' | 'agent';
export interface A2aMessage {
    readonly kind: 'message';
    readonly role: MessageRole;
    readonly parts: readonly Part[];
    readonly messageId: string;
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
export type TaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled' | 'rejected';
/** 终态集合：再收到任何状态迁移都是协议错误。 */
export declare const TERMINAL_STATES: readonly TaskState[];
export interface TaskStatus {
    readonly state: TaskState;
    readonly message?: A2aMessage;
    /** RFC 3339 时间戳。 */
    readonly timestamp: string;
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
/** A2A v1.0 卡片接口声明（`supportedInterfaces[]`）。 */
export interface AgentInterface {
    readonly url: string;
    readonly protocolBinding?: string;
    readonly protocolVersion?: string;
}
export interface AgentCard {
    readonly name: string;
    readonly description?: string;
    readonly url: string;
    /**
     * A2A v1.0 的接口列表形态：部分实现（如 pi-a2a）只给
     * `supportedInterfaces[].url`，不写顶层 `url`。客户端解析时兼容两种形态。
     */
    readonly supportedInterfaces?: readonly AgentInterface[];
    readonly version: string;
    readonly protocolVersion: string;
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
 * 解析 message/send、message/stream 的 params；补齐缺失的 messageId /
 * contextId（服务端生成），并校验 parts 形态。失败返回给客户端的错误文本。
 */
export declare function parseMessageSendParams(raw: unknown): {
    ok: true;
    params: MessageSendParams;
} | {
    ok: false;
    error: string;
};
/** 提取消息中的全部文本（text part 顺序拼接；无文本 part 返回空串）。 */
export declare function extractText(parts: readonly Part[]): string;
/** data/file part 的简要描述（用于日志与诊断，不参与正文）。 */
export declare function describeNonTextParts(parts: readonly Part[]): string[];
/** 当前时间的 RFC 3339 时间戳。 */
export declare function nowTimestamp(): string;
/** 终态判断。 */
export declare function isTerminalState(state: TaskState): boolean;
//# sourceMappingURL=protocol.d.ts.map