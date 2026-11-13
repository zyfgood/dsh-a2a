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
import type { A2aMessage, AgentCard } from './protocol.ts';
import type { TaskController } from './store.ts';
/** 任务 runner 入参：controller 驱动状态机，message 为本轮用户消息。 */
export interface RunnerInput {
    readonly controller: TaskController;
    readonly message: A2aMessage;
    /** 本任务已积累的全部消息（含本次 user 消息，按时间序）。 */
    readonly history: readonly A2aMessage[];
}
/** 任务执行器：实现方负责调用 controller 推进状态并产出 artifact。 */
export interface A2aRunner {
    run(input: RunnerInput): Promise<void>;
}
/** 最小日志接口（cordis logger 满足之；测试可用静默实现）。 */
export interface A2aLogger {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}
export declare const silentLogger: A2aLogger;
export interface A2aServerOptions {
    host: string;
    port: number;
    /** 写入 Agent Card 的绝对 URL（公网部署时与监听地址不同）。 */
    publicUrl: string;
    card: AgentCard;
    runner: A2aRunner;
    logger?: A2aLogger;
    /** Bearer 令牌；不配置则不鉴权。 */
    bearerToken?: string;
    /** 单轮执行上限（ms）；默认 10 分钟。 */
    turnTimeoutMs?: number;
    /** 已完结任务保留时长（ms）；默认 1 小时。 */
    taskTtlMs?: number;
    /** 运维面板展示的运行模式（agent/llm/echo）；仅用于 /admin/status 展示。 */
    mode?: string;
}
export declare class A2aServer {
    private readonly options;
    private readonly store;
    private readonly http;
    private readonly logger;
    private readonly turnTimeoutMs;
    private readonly taskTtlMs;
    private readonly sseSessions;
    private gcTimer;
    private started;
    constructor(options: A2aServerOptions);
    /** 实际监听端口（port=0 时为系统分配值）。 */
    get address(): string;
    start(): Promise<void>;
    stop(): Promise<void>;
    private handle;
    /** POST 目标路径：'/' 以及 publicUrl 指定的路径（公网反代常见 /a2a 前缀）。 */
    private isRpcPath;
    private setCommonHeaders;
    private corsHeaders;
    private serveCard;
    /** /admin/status 与 /admin/tasks：运维面板数据源（Bearer 门禁同 RPC）。 */
    private serveAdmin;
    private handleRpc;
    /**
     * 逐请求判定 wire 形态：
     * - 方法名是 1.0 原名（SendMessage/SendStreamingMessage/GetTask/CancelTask/ListTasks）→ 'v1'；
     * - 请求头 A2A-Version/X-A2A-Version 主版本为 1 → 'v1'；
     * - 其余（旧方法名 + 无头或 0.x 头）→ 'v03'，保持旧响应形态（浏览器半依赖）。
     */
    private negotiateWire;
    private checkAuth;
    private readBody;
    /** 非流式方法的统一分发。`wire` 决定响应形态（'v1' 原生 / 'v03' 兼容）。 */
    private dispatch;
    private handleSend;
    /**
     * 解析/创建任务：
     * - 无 taskId：新任务（缺省 contextId 时生成）；
     * - 有 taskId：必须是存在的 input-required 任务（多轮续答）；
     *   否则 TaskNotFound / UnsupportedOperation。
     */
    private prepareTask;
    /** 执行一轮：working → runner → 补终态；覆盖取消/超时/异常。 */
    private executeTurn;
    /** 造一条 role=agent 的状态说明消息（放入 status.message，供客户端展示）。 */
    private agentNote;
    private handleGetTask;
    private handleCancel;
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
    private handleListTasks;
    /** 1.0 原生游标分页实现（handleListTasks 的 v1 分支）。 */
    private listTasksV1;
    /**
     * 任务 id 参数：A2A 规范用 `params.id`，部分客户端与本插件旧约定
     * 用 `params.taskId`——两者都接受，优先规范写法。
     */
    private taskIdParam;
    private stringParam;
    /** 数值参数：接受 number 与可解析的字符串；非法一律 undefined（不静默归零）。 */
    private numberParam;
    private handleStream;
    private handleResubscribe;
    private openSse;
}
//# sourceMappingURL=server.d.ts.map