/**
 * 模型可调用的工具：a2a_*（出站 A2A 互操作）。
 *
 * 依赖 `ctx.tools`；未加载该服务时跳过注册并警告。
 * 目标地址受 config.clientAllowPatterns 白名单约束（前缀/通配），
 * 默认 `['*']` 全放开；收紧后 agent 只能呼叫清单内的远端 agent。
 *
 * @module dsh-a2a/tools
 */
import type { Context } from '@deepseek-ai/cordis';
export declare function registerA2aTools(ctx: Context, options: {
    allowPatterns: readonly string[];
    timeoutMs: number;
    /** 本端 peer 名：写入出站消息 metadata.from，供对端路由回话。 */
    peerName?: string;
}): void;
//# sourceMappingURL=tools.d.ts.map