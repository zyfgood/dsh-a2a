/**
 * dsh-a2a — DeepSeek Harness 的 A2A（Agent2Agent）协议插件。
 *
 * DSH 内置的互操作走 ACP + MCP，不含 A2A；本插件补上这块拼图：
 *
 * - 服务器方向（入站）：在本机/公网起一个标准 A2A HTTP 端点，把 DSH
 *   agent 暴露给任意 A2A 客户端（Google ADK、a2a-java/python SDK、
 *   其他 agent 网关……）：
 *   - Agent Card：`/.well-known/agent-card.json`（0.3）与
 *     `/.well-known/agent.json`（0.2 兼容）；
 *   - JSON-RPC：`message/send`（同步）、`message/stream`（SSE 流式）、
 *     `tasks/get`、`tasks/cancel`、`tasks/resubscribe`（断线续订）、
 *     `agent/authenticatedExtendedCard`；
 *   - 任务生命周期：submitted → working → completed/failed/canceled，
 *     支持 input-required 多轮续答；TTL 自动回收。
 * - 客户端方向（出站）：注册 `a2a_*` 模型工具（a2a_discover /
 *   a2a_send / a2a_task_status / a2a_cancel），让任意 DSH agent 直接
 *   呼叫远端 A2A agent，实现跨生态协作。
 *
 * 三种入站模式（config.mode）：
 * - `agent`（默认）每条 A2A contextId 对应一个持久 DSH agent 会话
 *   （跨任务续答、可落盘跨重启恢复）；
 * - `llm`   ctx.llm 直接回复（自包含轻量模式）；
 * - `echo`  回显原文（验证链路）。
 *
 * 加载方式（profile 的 cordis.patch.yml，或 dsh plugin add 一键安装）：
 * ```yaml
 * - id: a2a
 *   name: '@zyfgood/dsh-a2a'
 *   config:
 *     port: 7310
 *     mode: agent
 * ```
 *
 * @module dsh-a2a
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { AgentSkill } from './protocol.ts';
export declare const name = "a2a";
export interface Config {
    /** HTTP 监听地址（默认 127.0.0.1；公网暴露时改 0.0.0.0 并配合鉴权）。 */
    host?: string;
    /** HTTP 监听端口（默认 7310；0 = 系统分配）。 */
    port?: number;
    /**
     * 写入 Agent Card 的绝对 URL。客户端会向它发 JSON-RPC；公网部署
     * （反代/TLS）时必须配置为外部可达地址。
     */
    publicUrl?: string;
    /** Bearer 鉴权令牌；支持 `env:VAR`。不配置则开放访问。 */
    bearerToken?: string;
    /** Agent Card 中的名称。 */
    agentName?: string;
    /**
     * 本端 peer 名：出站消息写入 `metadata.from`，供对端把回话路由回来。
     * 缺省回退 agentName。
     */
    peerName?: string;
    /** Agent Card 中的描述。 */
    agentDescription?: string;
    /** Agent Card 中的版本号（agent 自身版本，默认 1.0.0）。 */
    agentVersion?: string;
    /** Agent Card 技能清单（缺省提供一个 dsh-agent 技能）。 */
    skills?: AgentSkill[];
    /**
     * 入站消息处理模式：
     * - `agent` 转交给 DSH agent 会话（默认，支持工具/技能/持久上下文）；
     * - `llm` 用 ctx.llm 直接生成回复（轻量自包含）；
     * - `echo` 回显原文（验证链路）。
     */
    mode?: 'agent' | 'llm' | 'echo';
    /** llm 模式的 provider 路由（例如 deepseek-official）。 */
    provider?: string;
    /** llm 模式的模型 id。 */
    model?: string;
    /** llm 模式的系统提示词。 */
    systemPrompt?: string;
    /** llm 模式每上下文保留的历史轮数（0 = 无记忆）。 */
    maxHistory?: number;
    /** agent 模式：复用 ctx.agents 中固定的会话 id；不配置则按 contextId 自动创建。 */
    agentId?: string;
    /** agent 模式自动创建会话的 preset id（默认跟随 GUI 默认预设）。 */
    agentPreset?: string;
    /** agent 模式自动创建会话的工作目录（默认 process.cwd()）。 */
    workspace?: string;
    /** 是否持久化 contextId → 会话映射（默认 true）：重启后自动恢复原会话。 */
    persistSessions?: boolean;
    /** 单轮执行上限（ms，默认 10 分钟）：超时任务置 failed。 */
    turnTimeoutMs?: number;
    /** 已完结任务内存保留时长（ms，默认 1 小时）。 */
    taskTtlMs?: number;
    /** 是否注册 a2a_* 出站工具（默认 true）。 */
    tools?: boolean;
    /** 出站工具可呼叫的远端地址白名单（默认 ['*'] 全放开）。 */
    clientAllowPatterns?: string[];
    /** 出站调用超时（ms，默认 2 分钟）。 */
    clientTimeoutMs?: number;
}
export declare const Config: z<Config>;
/** 把 `env:VAR` 形式的配置值解析为环境变量值。 */
export declare function resolveSecret(raw: string): string;
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map