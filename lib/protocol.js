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
import { randomUUID } from 'node:crypto';
// ── 常量 ────────────────────────────────────────────────────────────────
/** 本实现宣告/应答的 A2A 协议版本（1.0 原生）。 */
export const PROTOCOL_VERSION = '1.0';
/** Agent Card 的 1.0 / 0.3.x 标准路径。 */
export const CARD_PATH = '/.well-known/agent-card.json';
/** Agent Card 的 0.2.x 旧路径（同时保留，兼容旧客户端）。 */
export const CARD_LEGACY_PATH = '/.well-known/agent.json';
/** 内部终态集合：再收到任何状态迁移都是协议错误。 */
export const TERMINAL_STATES = [
    'completed',
    'failed',
    'canceled',
    'rejected',
];
/** 内部状态 → A2A 1.0（ProtoJSON 枚举）状态。 */
const STATE_TO_V1 = {
    submitted: 'TASK_STATE_SUBMITTED',
    working: 'TASK_STATE_WORKING',
    'input-required': 'TASK_STATE_INPUT_REQUIRED',
    completed: 'TASK_STATE_COMPLETED',
    failed: 'TASK_STATE_FAILED',
    canceled: 'TASK_STATE_CANCELED',
    rejected: 'TASK_STATE_REJECTED',
};
/** 入站状态归一化表（1.0 枚举 / 0.3 小写 都接受）。 */
const STATE_FROM_WIRE = (() => {
    const table = {};
    for (const [internal, wire] of Object.entries(STATE_TO_V1)) {
        table[internal] = internal;
        table[wire] = internal;
    }
    return table;
})();
/** 内部状态名 → 1.0 枚举名（未知状态原样透传，便于排障）。 */
export function toV1State(state) {
    return STATE_TO_V1[state] ?? state;
}
/** wire 状态名 → 内部状态名（同时接受 0.3 小写与 1.0 枚举）。 */
export function toInternalState(state) {
    return STATE_FROM_WIRE[state] ?? state;
}
export function buildAgentCard(options) {
    const card = {
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
    };
    return card;
}
/** JSON-RPC 标准错误码。 */
export const RPC_ERRORS = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
};
/** A2A 规范定义的服务端错误码。 */
export const A2A_ERRORS = {
    TASK_NOT_FOUND: -32001,
    TASK_NOT_CANCELABLE: -32002,
    PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
    UNSUPPORTED_OPERATION: -32004,
    CONTENT_TYPE_NOT_SUPPORTED: -32005,
};
export function jsonrpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}
export function jsonrpcError(id, code, message, data) {
    return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}
/** 解析并校验单个（非批量）JSON-RPC 请求；失败返回错误字符串。 */
export function parseJsonRpcRequest(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: '请求必须是单个 JSON-RPC 对象（A2A 不支持批量请求）' };
    }
    const obj = raw;
    if (obj.jsonrpc !== '2.0') {
        return { ok: false, error: 'jsonrpc 字段必须为 "2.0"' };
    }
    if (typeof obj.method !== 'string' || obj.method.length === 0) {
        return { ok: false, error: 'method 必须是非空字符串' };
    }
    const id = obj.id;
    if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') {
        return { ok: false, error: 'id 必须是 string / number / null' };
    }
    return {
        ok: true,
        request: {
            jsonrpc: '2.0',
            id: (id ?? null),
            method: obj.method,
            ...(obj.params !== undefined ? { params: obj.params } : {}),
        },
    };
}
/** 入站 role 归一化：1.0 ProtoJSON 枚举 → 内部 Role。 */
const ROLE_FROM_WIRE = {
    ROLE_USER: 'user',
    ROLE_AGENT: 'agent',
};
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
export function parseMessageSendParams(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: 'params 必须是对象' };
    }
    const obj = raw;
    const messageRaw = obj.message;
    if (messageRaw === null || typeof messageRaw !== 'object') {
        return { ok: false, error: 'params.message 必须是对象' };
    }
    const m = messageRaw;
    const rawRole = m.role;
    const role = typeof rawRole === 'string' ? (ROLE_FROM_WIRE[rawRole] ?? rawRole) : rawRole;
    if (role !== 'user' && role !== 'agent') {
        return { ok: false, error: 'message.role 必须是 ROLE_USER / ROLE_AGENT（或 user / agent）' };
    }
    if (!Array.isArray(m.parts) || m.parts.length === 0) {
        return { ok: false, error: 'message.parts 必须是非空数组' };
    }
    const parts = [];
    for (const p of m.parts) {
        if (p === null || typeof p !== 'object') {
            return { ok: false, error: 'message.parts[] 的每一项必须是对象' };
        }
        const part = p;
        if (part.kind === 'text' && typeof part.text === 'string') {
            // 0.3 形态：显式 kind 判别。
            parts.push({ kind: 'text', text: part.text });
        }
        else if (part.kind === undefined && typeof part.text === 'string') {
            // 1.0 形态：无 kind 的 text part，用成员存在性判别（多余 mediaType 忽略）。
            parts.push({ kind: 'text', text: part.text });
        }
        else if ((part.kind === 'data' || part.kind === undefined)
            && part.data !== null && typeof part.data === 'object' && !Array.isArray(part.data)) {
            // 1.0 的 data part 同样无 kind。
            parts.push({ kind: 'data', data: part.data });
        }
        else if ((part.kind === 'file' || part.kind === undefined)
            && part.file !== null && typeof part.file === 'object'
            && (typeof part.file.uri === 'string'
                || typeof part.file.bytes === 'string')) {
            // 1.0 的 file part 同样无 kind。
            parts.push({ kind: 'file', file: part.file });
        }
        else {
            return { ok: false, error: 'message.parts[] 含不支持的 part（须含 text / data / file 之一，可选 kind）' };
        }
    }
    const messageId = typeof m.messageId === 'string' && m.messageId.length > 0 ? m.messageId : randomUUID();
    const contextId = typeof m.contextId === 'string' && m.contextId.length > 0 ? m.contextId : undefined;
    const taskId = typeof m.taskId === 'string' && m.taskId.length > 0 ? m.taskId : undefined;
    const message = {
        kind: 'message',
        role,
        parts,
        messageId,
        ...(taskId !== undefined ? { taskId } : {}),
        // contextId 未提供时由服务器补（见 server.ts：同一缺省上下文 = 无状态）。
        ...(contextId !== undefined ? { contextId } : {}),
    };
    return { ok: true, params: { message, ...(obj.configuration !== undefined ? { configuration: obj.configuration } : {}) } };
}
// ── 出口转换（内部形态 → A2A 1.0 wire 形态）─────────────────────────────
/** 造一个 1.0 text part（成员存在性判别，无 kind）。 */
export function textPart(text, mediaType = 'text/plain') {
    return { text, mediaType };
}
/** 内部 part（`{kind}`）→ 1.0 part（无 kind，用成员存在性判别）。 */
export function toV1Part(part) {
    switch (part.kind) {
        case 'text':
            return { text: part.text, mediaType: 'text/plain' };
        case 'data':
            return { data: part.data, mediaType: 'application/json' };
        case 'file':
            return { file: part.file, mediaType: part.file.mimeType ?? 'application/octet-stream' };
        default: {
            // 未知形态：去掉 kind 后原样透传。
            const { kind: _kind, ...rest } = part;
            return rest;
        }
    }
}
/** 内部 parts 数组 → 1.0 parts 数组。 */
export function toV1Parts(parts) {
    return Array.isArray(parts) ? parts.map(toV1Part) : [];
}
/** 内部 message（`kind:'message'`，role user/agent）→ 1.0 Message（ROLE_*，无 kind）。 */
export function toV1Message(message) {
    const role = message.role === 'agent' ? 'ROLE_AGENT' : 'ROLE_USER';
    return {
        role,
        parts: toV1Parts(message.parts),
        ...(typeof message.messageId === 'string' ? { messageId: message.messageId } : {}),
        ...(typeof message.taskId === 'string' ? { taskId: message.taskId } : {}),
        ...(typeof message.contextId === 'string' ? { contextId: message.contextId } : {}),
    };
}
/** 内部 status → 1.0 TaskStatus（state 用 TASK_STATE_*，message 用 ROLE_AGENT）。 */
export function toV1Status(status) {
    return {
        state: toV1State(status.state),
        ...(status.message !== undefined ? { message: toV1Message(status.message) } : {}),
        ...(typeof status.timestamp === 'string' ? { timestamp: status.timestamp } : {}),
    };
}
/** 内部 artifact（`kind:'artifact'`）→ 1.0 Artifact（无 kind、parts 无 kind）。 */
export function toV1Artifact(artifact) {
    return {
        artifactId: artifact.artifactId,
        ...(artifact.name !== undefined ? { name: artifact.name } : {}),
        ...(artifact.description !== undefined ? { description: artifact.description } : {}),
        parts: toV1Parts(artifact.parts),
    };
}
/** 内部 task 快照 → 1.0 Task（无 kind、无 createdAt）。 */
export function toV1Task(snapshot) {
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
    };
}
/**
 * 内部流事件（`{kind:'status-update'}` / `{kind:'artifact-update'}`）→
 * 1.0 StreamResponse（成员存在性判别：`statusUpdate` / `artifactUpdate` / `task`）。
 */
export function toV1StreamEvent(event) {
    if (event.kind === 'artifact-update') {
        return {
            artifactUpdate: {
                taskId: event.taskId,
                contextId: event.contextId,
                artifact: toV1Artifact(event.artifact),
                ...(event.lastChunk !== undefined ? { lastChunk: event.lastChunk } : {}),
            },
        };
    }
    return {
        statusUpdate: {
            taskId: event.taskId,
            contextId: event.contextId,
            status: toV1Status(event.status),
        },
    };
}
/** 内部任务快照 → 1.0 SendMessageResponse（oneof：`task`）。 */
export function toV1TaskResponse(snapshot) {
    return { task: toV1Task(snapshot) };
}
// ── 小工具 ─────────────────────────────────────────────────────────────
/** 判断 part 是否承载文本（内部带 kind，1.0 入站无 kind）。 */
function isTextPart(part) {
    const kind = part.kind;
    if (kind !== undefined && kind !== 'text')
        return false;
    return typeof part.text === 'string';
}
/** 提取消息中的全部文本（text part 顺序拼接；无文本 part 返回空串）。 */
export function extractText(parts) {
    let out = '';
    for (const p of parts) {
        if (isTextPart(p))
            out += p.text;
    }
    return out;
}
/** data/file part 的简要描述（用于日志与诊断，不参与正文）。 */
export function describeNonTextParts(parts) {
    const out = [];
    for (const p of parts) {
        const kind = p.kind
            ?? (p.data !== undefined ? 'data' : p.file !== undefined ? 'file' : undefined);
        if (kind === 'data')
            out.push('[data part]');
        else if (kind === 'file') {
            const file = p.file;
            out.push(file.name ? `[file: ${file.name}]` : `[file: ${file.uri ?? 'inline'}]`);
        }
    }
    return out;
}
/** 当前时间的 RFC 3339 时间戳。 */
export function nowTimestamp() {
    return new Date().toISOString();
}
/** 终态判断（同时接受内部小写状态与 1.0 TASK_STATE_* 枚举）。 */
export function isTerminalState(state) {
    return TERMINAL_STATES.includes(toInternalState(state));
}
/** input-required 判断（接受两种写法）。 */
export function isInputRequiredState(state) {
    return toInternalState(state) === 'input-required';
}
//# sourceMappingURL=protocol.js.map