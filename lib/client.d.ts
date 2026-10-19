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
import type { A2aTask, AgentCard, TaskEvent } from './protocol.ts';
export interface A2aClientOptions {
    /** 远端 agent 基地址（Agent Card 所在站点的根，或直接给 JSON-RPC 地址）。 */
    baseUrl: string;
    /** Bearer 令牌（远端启用鉴权时）。 */
    bearerToken?: string;
    /** 单次 HTTP 请求 / 轮询总超时（ms，默认 120s）。 */
    timeoutMs?: number;
    /**
     * 本端 peer 名：写入出站消息 `metadata.from`，供对端把回话路由回来。
     * 未配置（或为空串）时不携带 `from`，回退为旧行为。
     */
    peerName?: string;
}
/**
 * 出站消息的 `metadata.kind`：
 * - `message` 仅入库/通知（默认，兼容旧行为）；
 * - `request` 触发对端处理并等待结果；
 * - `result` 回执/结果投递。
 */
export type A2aOutboundKind = 'message' | 'request' | 'result';
/** JSON-RPC 远端返回的错误。 */
export declare class A2aRpcError extends Error {
    readonly code: number;
    readonly data?: unknown | undefined;
    constructor(code: number, message: string, data?: unknown | undefined);
}
export declare class A2aClient {
    private readonly options;
    private base;
    private cachedCard;
    constructor(options: A2aClientOptions);
    /** 规范化基地址：容忍带 card 路径 / JSON-RPC 路径的输入。 */
    private normalize;
    /**
     * 构造出站消息的 metadata：始终带 `kind`（默认 message），
     * 配置了本端 peerName 时附带 `from`（对端据此路由回话）。
     */
    private messageMetadata;
    private headers;
    private rpc;
    /** 拉取远端 Agent Card（带进程内缓存）。 */
    card(forceRefresh?: boolean): Promise<AgentCard>;
    /**
     * message/send：同步拿终态。
     * - 对端直接返回完结任务 → 即刻返回；
     * - 对端返回未完结任务 → tasks/get 轮询（pollMs 间隔）直到终态/超时。
     * - 对端返回裸 Message（非任务型 agent）→ 包装成 completed Task 形态。
     */
    send(text: string, options?: {
        contextId?: string;
        pollMs?: number;
        onEvent?: (event: TaskEvent) => void;
        /** 出站 metadata.kind（默认 message）。 */
        kind?: A2aOutboundKind;
    }): Promise<A2aTask>;
    /**
     * message/stream：SSE 消费直到 final 事件；返回收到的全部事件。
     * 对端不支持流式（HTTP 非 SSE）时回退 send()。
     */
    sendStream(text: string, onEvent: (event: TaskEvent) => void, options?: {
        contextId?: string;
        /** 出站 metadata.kind（默认 message）。 */
        kind?: A2aOutboundKind;
    }): Promise<TaskEvent[]>;
    getTask(taskId: string): Promise<A2aTask>;
    cancelTask(taskId: string): Promise<A2aTask>;
    /** 便捷：send() + 提取 artifact 文本（工具层使用）。 */
    sendForText(text: string, options?: {
        contextId?: string;
        pollMs?: number;
        preferStream?: boolean;
        onEvent?: (event: TaskEvent) => void;
        /** 出站 metadata.kind（默认 message）。 */
        kind?: A2aOutboundKind;
    }): Promise<{
        task: A2aTask;
        text: string;
    }>;
}
/**
 * 出站白名单模式匹配：
 * - `'*'` 全放开；
 * - URL 形式（`https://a2a.example.com/`、`http://10.0.0.5:7310/`）按
 *   host + port + 路径前缀匹配；hostname 支持 `*.example.com` 通配子域；
 * - `'*:7310'` 任意主机的指定端口。
 */
export declare function matchesAllowlist(patterns: readonly string[], target: string): boolean;
//# sourceMappingURL=client.d.ts.map