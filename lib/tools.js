/**
 * 模型可调用的工具：a2a_*（出站 A2A 互操作）。
 *
 * 依赖 `ctx.tools`；未加载该服务时跳过注册并警告。
 * 目标地址受 config.clientAllowPatterns 白名单约束（前缀/通配），
 * 默认 `['*']` 全放开；收紧后 agent 只能呼叫清单内的远端 agent。
 *
 * @module dsh-a2a/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { A2aClient, matchesAllowlist } from "./client.js";
/** 把任务快照渲染成给模型看的一段简报文本。 */
function renderTask(task) {
    const lines = [
        `任务 ${task.id}（context ${task.contextId}）：${task.status.state}`,
    ];
    const out = [];
    for (const artifact of task.artifacts ?? []) {
        for (const part of artifact.parts) {
            if (part.kind === 'text')
                out.push(part.text);
        }
    }
    const joined = out.join('\n').trim();
    if (joined !== '')
        lines.push(`回复文本：${joined}`);
    if (task.status.message !== undefined) {
        const note = task.status.message.parts
            .filter((p) => p.kind === 'text')
            .map((p) => p.text)
            .join(' ');
        if (note !== '')
            lines.push(`状态说明：${note}`);
    }
    return lines.join('\n');
}
export function registerA2aTools(ctx, options) {
    const tools = ctx.get('tools');
    if (!tools) {
        ctx.logger.warn('a2a: 当前环境未加载 ctx.tools，跳过 a2a_* 工具注册');
        return;
    }
    const register = (tool) => {
        ctx.effect(() => tools.register(tool));
    };
    const checkTarget = (target) => {
        if (!matchesAllowlist(options.allowPatterns, target)) {
            return `目标 ${target} 不在 a2a clientAllowPatterns 白名单内`;
        }
        return undefined;
    };
    const clientFor = (target, token) => new A2aClient({
        baseUrl: target,
        timeoutMs: options.timeoutMs,
        ...(token ? { bearerToken: token } : {}),
        ...(options.peerName !== undefined && options.peerName !== '' ? { peerName: options.peerName } : {}),
    });
    // ── a2a_discover：拉取远端 Agent Card ─────────────────────────────
    register(defineTool({
        name: 'a2a_discover',
        description: '获取远端 A2A agent 的 Agent Card（能力、技能、鉴权方式、服务地址）。呼叫一个陌生 A2A agent 前先用它了解对方能做什么。',
        parameters: {
            target: {
                type: 'string',
                required: true,
                description: '远端 agent 的基地址（如 https://a2a.example.com/ 或 http://127.0.0.1:7310/）',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    url: { type: 'string' },
                    version: { type: 'string' },
                    protocol_version: { type: 'string' },
                    streaming: { type: 'boolean' },
                    skills: { type: 'array', items: { type: 'string' } },
                    auth_required: { type: 'boolean' },
                    detail: { type: 'string' },
                },
            },
            render: (_args, raw) => {
                const value = raw;
                return [{
                        type: 'text',
                        text: value.ok
                            ? `远端 agent「${value.name}」：${value.description ?? '（无描述）'}；协议 ${value.protocol_version}，版本 ${value.version}，流式 ${value.streaming ? '支持' : '不支持'}，鉴权 ${value.auth_required ? '需要' : '无需'}`
                            : `发现失败：${value.detail}`,
                    }];
            },
        },
        execute: async (args) => {
            const blocked = checkTarget(args.target);
            if (blocked !== undefined)
                return { ok: false, detail: blocked };
            try {
                const card = await clientFor(args.target).card(true);
                const result = {
                    ok: true,
                    name: card.name,
                    url: card.url,
                    version: card.version,
                    protocol_version: card.protocolVersion,
                    streaming: card.capabilities?.streaming ?? false,
                    skills: card.skills.map((s) => `${s.id}（${s.name}${s.description !== undefined ? '：' + s.description : ''}）`),
                    auth_required: (card.security ?? []).some((entry) => Object.keys(entry).length > 0),
                };
                return result;
            }
            catch (error) {
                return { ok: false, detail: error instanceof Error ? error.message : String(error) };
            }
        },
    }));
    // ── a2a_send：把消息发给远端 A2A agent 并等待结果 ──────────────────
    register(defineTool({
        name: 'a2a_send',
        description: '向远端 A2A agent 发送一条文本消息并等待其最终回复（优先流式，自动降级同步+轮询）。适合跨 agent 协作：委托任务、提问、调用其他 agent 的技能。kind=request 时对端会实际处理并回应（部分实现默认 kind=message 仅入库不触发）。',
        parameters: {
            target: {
                type: 'string',
                required: true,
                description: '远端 agent 的基地址（Agent Card 的 url 或同源根地址）',
            },
            content: { type: 'string', required: true, description: '要发送的文本消息（自包含：对方看不到你的上下文）' },
            bearer_token: { type: 'string', description: '远端启用鉴权时的 Bearer 令牌' },
            context_id: { type: 'string', description: 'A2A contextId：同一 id 复用远端会话上下文（多轮对话时传回上一轮返回的值）' },
            kind: {
                type: 'string',
                enum: ['message', 'request', 'result'],
                description: '消息语义（metadata.kind）：message=仅投递/入库（默认）；request=请求对端处理并等待结果；result=回执/结果投递',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    state: { type: 'string' },
                    task_id: { type: 'string' },
                    context_id: { type: 'string' },
                    reply: { type: 'string' },
                    detail: { type: 'string' },
                },
            },
            render: (_args, raw) => {
                const value = raw;
                return [{
                        type: 'text',
                        text: value.ok
                            ? `远端回复（${value.state}）：${value.reply !== '' ? value.reply : '（无文本产物）'}`
                            : `发送失败：${value.detail}`,
                    }];
            },
        },
        execute: async (args) => {
            const blocked = checkTarget(args.target);
            if (blocked !== undefined)
                return { ok: false, detail: blocked };
            try {
                const client = clientFor(args.target, args.bearer_token);
                const { task, text } = await client.sendForText(args.content, {
                    ...(args.context_id !== undefined && args.context_id !== '' ? { contextId: args.context_id } : {}),
                    ...(args.kind !== undefined ? { kind: args.kind } : {}),
                    preferStream: true,
                });
                return {
                    ok: task.status.state === 'completed',
                    state: task.status.state,
                    task_id: task.id,
                    context_id: task.contextId,
                    reply: text,
                };
            }
            catch (error) {
                return { ok: false, detail: error instanceof Error ? error.message : String(error) };
            }
        },
    }));
    // ── a2a_task_status：查询远端任务 ─────────────────────────────────
    register(defineTool({
        name: 'a2a_task_status',
        description: '查询远端 A2A agent 上某个任务的状态（tasks/get）。用于 a2a_send 返回超时或进行中任务后的跟进。',
        parameters: {
            target: { type: 'string', required: true, description: '远端 agent 的基地址' },
            task_id: { type: 'string', required: true, description: '任务 id（a2a_send 返回的 task_id）' },
            bearer_token: { type: 'string', description: '远端启用鉴权时的 Bearer 令牌' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    state: { type: 'string' },
                    summary: { type: 'string' },
                    detail: { type: 'string' },
                },
            },
            render: (_args, raw) => {
                const value = raw;
                return [{
                        type: 'text',
                        text: value.ok ? value.summary : `查询失败：${value.detail}`,
                    }];
            },
        },
        execute: async (args) => {
            const blocked = checkTarget(args.target);
            if (blocked !== undefined)
                return { ok: false, detail: blocked };
            try {
                const task = await clientFor(args.target, args.bearer_token).getTask(args.task_id);
                return { ok: true, state: task.status.state, summary: renderTask(task) };
            }
            catch (error) {
                return { ok: false, detail: error instanceof Error ? error.message : String(error) };
            }
        },
    }));
    // ── a2a_cancel：取消远端任务 ──────────────────────────────────────
    register(defineTool({
        name: 'a2a_cancel',
        description: '取消远端 A2A agent 上仍在进行的任务（tasks/cancel）。已完结的任务不可取消。',
        parameters: {
            target: { type: 'string', required: true, description: '远端 agent 的基地址' },
            task_id: { type: 'string', required: true, description: '任务 id' },
            bearer_token: { type: 'string', description: '远端启用鉴权时的 Bearer 令牌' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    state: { type: 'string' },
                    detail: { type: 'string' },
                },
            },
            render: (_args, raw) => {
                const value = raw;
                return [{
                        type: 'text',
                        text: value.ok ? `任务已取消（${value.state}）` : `取消失败：${value.detail}`,
                    }];
            },
        },
        execute: async (args) => {
            const blocked = checkTarget(args.target);
            if (blocked !== undefined)
                return { ok: false, detail: blocked };
            try {
                const task = await clientFor(args.target, args.bearer_token).cancelTask(args.task_id);
                return { ok: task.status.state === 'canceled', state: task.status.state };
            }
            catch (error) {
                return { ok: false, detail: error instanceof Error ? error.message : String(error) };
            }
        },
    }));
}
//# sourceMappingURL=tools.js.map