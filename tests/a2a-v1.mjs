/**
 * A2A 1.0 wire 形状测试：stub runner（直回固定文本，不走 bridge）在 7311 起服务，
 * 逐项断言 1.0 原生出口与 0.3 兼容入口。`npm test` 即跑本文件。
 *
 * 端口可用 A2A_TEST_PORT 覆盖；退出码反映 fail 数。
 */
import { buildAgentCard, PROTOCOL_VERSION } from '../lib/protocol.js';
import { A2aServer } from '../lib/server.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.A2A_TEST_PORT ?? 7311);
const BASE = `http://${HOST}:${PORT}/`;

let pass = 0, fail = 0;
const t = (name, fn) => {
    try { fn(); pass += 1; console.log(`PASS  ${name}`); }
    catch (e) { fail += 1; console.log(`FAIL  ${name}  ${e.message}`); }
};

/** stub runner 走内部形态（{kind:'text'} part、小写状态），验证出口转换。 */
const runner = {
    async run({ controller, message }) {
        const text = message.parts.filter((p) => p.kind === 'text').map((p) => p.text).join('');
        if (text.includes('slow')) {
            await new Promise((r) => setTimeout(r, 60_000));
            return;
        }
        const reply = `stub-reply:${text}`;
        controller.addArtifact([{ kind: 'text', text: reply }], { name: 'reply' });
        controller.recordHistory({ kind: 'message', role: 'agent', parts: [{ kind: 'text', text: reply }], messageId: 'h' });
        controller.updateStatus('completed');
    },
};

const server = new A2aServer({
    host: HOST, port: PORT, mode: 'echo', runner,
    publicUrl: BASE,
    card: buildAgentCard({ name: 'DSH Agent (v1 test)', description: 'wire shape test', url: BASE, version: '0.3.0-a2a1.0' }),
});
await server.start();

const rpc = async (method, params, headers = {}) => {
    const res = await fetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: `req-${method}`, method, params }),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { /* SSE 等非 JSON */ }
    return { status: res.status, headers: res.headers, json, text };
};

// ── Agent Card ─────────────────────────────────────────────────────────
{
    const res = await fetch(BASE + '.well-known/agent-card.json');
    const c = await res.json();
    t('Card 200 + A2A-Version: 1.0 头', () => {
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        if (res.headers.get('a2a-version') !== '1.0') throw new Error('A2A-Version 头不是 1.0');
    });
    t('Card protocolVersion = 1.0', () => {
        if (PROTOCOL_VERSION !== '1.0' || c.protocolVersion !== '1.0') throw new Error(String(c.protocolVersion));
    });
    t('Card supportedInterfaces 形状', () => {
        const [i] = c.supportedInterfaces ?? [];
        if (!i || c.supportedInterfaces.length !== 1) throw new Error('supportedInterfaces 缺失或非单条');
        if (i.url !== BASE || i.protocolBinding !== 'JSONRPC' || i.protocolVersion !== '1.0') {
            throw new Error(JSON.stringify(i));
        }
    });
    t('Card capabilities 保留 streaming/pushNotifications', () => {
        if (c.capabilities?.streaming !== true) throw new Error('streaming 不是 true');
        if (typeof c.capabilities?.pushNotifications !== 'boolean') throw new Error('pushNotifications 缺失');
    });
}

// ── SendMessage（1.0 原生）───────────────────────────────────────────
let taskId;
{
    const r = await rpc('SendMessage', {
        message: { role: 'ROLE_USER', parts: [{ text: 'hello-v1', mediaType: 'text/plain' }], messageId: 'm1', contextId: 'ctx1' },
    }, { 'A2A-Version': '1.0' });
    const res = r.json?.result ?? {};
    const task = res.task ?? {};
    taskId = task.id;
    t('SendMessage 无 error、结果为 {task} oneof', () => {
        if (r.json.error) throw new Error(JSON.stringify(r.json.error));
        if (!task.id || res.message) throw new Error('非 task oneof：' + r.text.slice(0, 160));
    });
    t('Task 无 kind、状态 TASK_STATE_COMPLETED', () => {
        if (task.kind !== undefined) throw new Error('Task 带 kind');
        if (task.status?.state !== 'TASK_STATE_COMPLETED') throw new Error(String(task.status?.state));
    });
    t('artifact parts 无 kind、{text, mediaType}', () => {
        const a = task.artifacts?.[0];
        if (!a?.artifactId || a.kind !== undefined) throw new Error('artifact 形态错');
        const p = a.parts?.[0] ?? {};
        if (p.kind !== undefined || p.text !== 'stub-reply:hello-v1' || p.mediaType !== 'text/plain') {
            throw new Error(JSON.stringify(p));
        }
    });
    t('history role = ROLE_USER/ROLE_AGENT、无 kind', () => {
        const h = task.history ?? [];
        const roles = h.filter((m) => m.role).map((m) => m.role);
        if (!roles.includes('ROLE_USER') || !roles.includes('ROLE_AGENT')) throw new Error(roles.join(','));
        if (h.some((m) => m.kind !== undefined)) throw new Error('history 带 kind');
    });
    t('contextId 回显', () => {
        if (task.contextId !== 'ctx1') throw new Error(String(task.contextId));
    });
    t('整个响应里无 "kind" 键', () => {
        if (r.text.includes('"kind"')) throw new Error(r.text.slice(0, 200));
    });
}

// ── GetTask / ListTasks / CancelTask ──────────────────────────────────
{
    const r = await rpc('GetTask', { id: taskId }, { 'A2A-Version': '1.0' });
    t('GetTask 返回裸 1.0 Task', () => {
        if (r.json.error) throw new Error(JSON.stringify(r.json.error));
        const x = r.json.result;
        if (x.id !== taskId || x.kind !== undefined || x.status.state !== 'TASK_STATE_COMPLETED') {
            throw new Error(JSON.stringify(x).slice(0, 160));
        }
    });
    const miss = await rpc('GetTask', { id: 'no-such-task' }, { 'A2A-Version': '1.0' });
    t('GetTask 未知 id → -32001', () => {
        if (miss.json.error?.code !== -32001) throw new Error(JSON.stringify(miss.json));
    });

    const list = await rpc('ListTasks', { pageSize: 10 }, { 'A2A-Version': '1.0' });
    t('ListTasks → {tasks: [...]} 元素为 1.0 Task', () => {
        if (list.json.error) throw new Error(JSON.stringify(list.json.error));
        const tasks = list.json.result?.tasks;
        if (!Array.isArray(tasks)) throw new Error('tasks 不是数组');
        for (const x of tasks) {
            if (x.kind !== undefined || !/^TASK_STATE_/.test(x.status.state)) throw new Error(JSON.stringify(x).slice(0, 120));
        }
    });

    const pending = rpc('SendMessage', {
        message: { role: 'ROLE_USER', parts: [{ text: 'slow-task' }], messageId: 'ms', contextId: 'ctxs' },
    }, { 'A2A-Version': '1.0' });
    await new Promise((r2) => setTimeout(r2, 300));
    const running = (await rpc('ListTasks', { pageSize: 10 }, { 'A2A-Version': '1.0' }))
        .json.result.tasks.find((x) => x.status.state === 'TASK_STATE_WORKING');
    t('执行中任务 = TASK_STATE_WORKING', () => {
        if (!running) throw new Error('找不到 working 任务');
    });
    const cancel = await rpc('CancelTask', { id: running?.id }, { 'A2A-Version': '1.0' });
    t('CancelTask → TASK_STATE_CANCELED、无 kind', () => {
        if (cancel.json.error) throw new Error(JSON.stringify(cancel.json.error));
        const x = cancel.json.result;
        if (x.status.state !== 'TASK_STATE_CANCELED' || x.kind !== undefined) throw new Error(JSON.stringify(x).slice(0, 160));
    });
    const again = await rpc('CancelTask', { id: running?.id }, { 'A2A-Version': '1.0' });
    t('重复 CancelTask → -32002', () => {
        if (again.json.error?.code !== -32002) throw new Error(JSON.stringify(again.json));
    });
    pending.catch(() => { });
}

// ── ListTasks 1.0 原生游标分页 ────────────────────────────────────────
let pageTokens = {};
{
    // 造多任务：复用 stub runner 批量发 SendMessage（同 contextId，各自新任务）。
    const made = [];
    for (let i = 0; i < 4; i += 1) {
        const r = await rpc('SendMessage', {
            message: { role: 'ROLE_USER', parts: [{ text: `page-${i}` }], messageId: `mp${i}`, contextId: 'ctx-page' },
        }, { 'A2A-Version': '1.0' });
        if (r.json.error) throw new Error(`造任务失败：${JSON.stringify(r.json.error)}`);
        made.push(r.json.result.task.id);
    }

    const first = await rpc('ListTasks', { pageSize: 2 }, { 'A2A-Version': '1.0' });
    const p1 = first.json.result ?? {};
    t('ListTasks 首页：pageSize 回显 + nextPageToken 非空', () => {
        if (first.json.error) throw new Error(JSON.stringify(first.json.error));
        if (p1.pageSize !== 2) throw new Error(`pageSize=${p1.pageSize}`);
        if (typeof p1.nextPageToken !== 'string' || p1.nextPageToken === '') {
            throw new Error(`nextPageToken=${JSON.stringify(p1.nextPageToken)}`);
        }
        if (!Array.isArray(p1.tasks) || p1.tasks.length !== 2) throw new Error(`tasks=${p1.tasks?.length}`);
    });

    const second = await rpc('ListTasks', { pageSize: 2, pageToken: p1.nextPageToken }, { 'A2A-Version': '1.0' });
    const p2 = second.json.result ?? {};
    t('第二页 token 可用，两页 id 无交集', () => {
        if (second.json.error) throw new Error(JSON.stringify(second.json.error));
        if (!Array.isArray(p2.tasks) || p2.tasks.length === 0) throw new Error(`tasks=${p2.tasks?.length}`);
        const ids2 = p2.tasks.map((x) => x.id);
        const overlaps = ids2.filter((id) => p1.tasks.some((x) => x.id === id));
        if (overlaps.length > 0) throw new Error(`重复：${overlaps.join(',')}`);
    });

    // 一路翻到最后一页，断言 nextPageToken 变空串。
    let cursor = p1.nextPageToken;
    let lastPage = p2;
    for (let guard = 0; guard < 20 && cursor !== ''; guard += 1) {
        const r = await rpc('ListTasks', { pageSize: 2, pageToken: cursor }, { 'A2A-Version': '1.0' });
        if (r.json.error) throw new Error(JSON.stringify(r.json.error));
        lastPage = r.json.result;
        cursor = lastPage.nextPageToken;
    }
    t('最后一页 nextPageToken === ""', () => {
        if (typeof lastPage.nextPageToken !== 'string') throw new Error(`类型 ${typeof lastPage.nextPageToken}`);
        if (lastPage.nextPageToken !== '') throw new Error(`非空：${lastPage.nextPageToken}`);
    });
    t('末页 nextPageToken 字段始终存在（空串而非缺省）', () => {
        if (!Object.prototype.hasOwnProperty.call(lastPage, 'nextPageToken')) throw new Error('字段缺失');
    });

    const forged = await rpc('ListTasks', { pageSize: 2, pageToken: 'ZmFrZQ.c2lnbmF0dXJl' }, { 'A2A-Version': '1.0' });
    t('伪造 pageToken → -32602', () => {
        if (forged.json.error?.code !== -32602) throw new Error(JSON.stringify(forged.json));
    });
    const broken = await rpc('ListTasks', { pageSize: 2, pageToken: 'not-a-cursor' }, { 'A2A-Version': '1.0' });
    t('非法格式 pageToken → -32602', () => {
        if (broken.json.error?.code !== -32602) throw new Error(JSON.stringify(broken.json));
    });

    const big = await rpc('ListTasks', { pageSize: 999 }, { 'A2A-Version': '1.0' });
    t('pageSize: 999 → 实际 pageSize === 100', () => {
        if (big.json.error) throw new Error(JSON.stringify(big.json.error));
        if (big.json.result?.pageSize !== 100) throw new Error(`pageSize=${big.json.result?.pageSize}`);
    });
    const defaulted = await rpc('ListTasks', {}, { 'A2A-Version': '1.0' });
    t('pageSize 缺失 → 50', () => {
        if (defaulted.json.error) throw new Error(JSON.stringify(defaulted.json.error));
        if (defaulted.json.result?.pageSize !== 50) throw new Error(`pageSize=${defaulted.json.result?.pageSize}`);
    });
    pageTokens = { first: p1.nextPageToken, count: made.length };
}

// ── 0.3 向后兼容 ─────────────────────────────────────────────────────
{
    const r = await rpc('message/send', {
        message: { kind: 'message', role: 'user', parts: [{ kind: 'text', text: 'hello-v03' }], messageId: 'm03' },
    }, { 'X-A2A-Version': '0.3.0' });
    t('0.3 请求仍成功且保持旧形状', () => {
        if (r.json.error) throw new Error(JSON.stringify(r.json.error));
        const x = r.json.result;
        if (x.kind !== 'task' || x.status.state !== 'completed' || x.artifacts[0].parts[0].kind !== 'text') {
            throw new Error(JSON.stringify(x).slice(0, 160));
        }
    });
    const noHdr = await rpc('message/send', {
        message: { kind: 'message', role: 'user', parts: [{ kind: 'text', text: 'hello-nohdr' }], messageId: 'mnh' },
    });
    t('无版本头的旧方法名仍成功', () => {
        if (noHdr.json.error) throw new Error(JSON.stringify(noHdr.json.error));
        if (noHdr.json.result.status.state !== 'completed') throw new Error('状态不是 completed');
    });
    const list03 = await rpc('tasks/list', { pageSize: 2 }, { 'X-A2A-Version': '0.3.0' });
    t('0.3 tasks/list 保持旧形状（摘要、无 nextPageToken/pageSize）', () => {
        if (list03.json.error) throw new Error(JSON.stringify(list03.json.error));
        const r03 = list03.json.result ?? {};
        if (!Array.isArray(r03.tasks)) throw new Error('tasks 不是数组');
        if (r03.nextPageToken !== undefined || r03.pageSize !== undefined) {
            throw new Error(`0.3 混入 1.0 分页字段：${Object.keys(r03).join(',')}`);
        }
        if (r03.tasks.length > 0 && r03.tasks[0].createdAt === undefined) throw new Error('不是摘要形态');
    });
}

// ── 版本协商 ──────────────────────────────────────────────────────────
{
    const v2 = await rpc('SendMessage', {
        message: { role: 'ROLE_USER', parts: [{ text: 'x' }], messageId: 'm2' },
    }, { 'A2A-Version': '2.0' });
    t('A2A-Version: 2.0 → 400', () => {
        if (v2.status !== 400) throw new Error(`status ${v2.status}`);
    });
    const v2legacy = await rpc('message/send', {
        message: { kind: 'message', role: 'user', parts: [{ kind: 'text', text: 'x' }] },
    }, { 'A2A-Version': '2.0' });
    t('旧方法名 + 2.0 也 400', () => {
        if (v2legacy.status !== 400) throw new Error(`status ${v2legacy.status}`);
    });
    const noHdr = await rpc('SendMessage', {
        message: { role: 'ROLE_USER', parts: [{ text: 'no-header' }], messageId: 'm3' },
    });
    t('SendMessage 无版本头放行', () => {
        if (noHdr.status !== 200 || noHdr.json.result.task.status.state !== 'TASK_STATE_COMPLETED') {
            throw new Error(noHdr.text.slice(0, 160));
        }
    });
}

// ── SendStreamingMessage（1.0 SSE）───────────────────────────────────
{
    const res = await fetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0', Accept: 'text/event-stream' },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 'stream-1', method: 'SendStreamingMessage',
            params: { message: { role: 'ROLE_USER', parts: [{ text: 'stream-v1' }], messageId: 'mst' } },
        }),
    });
    const text = await res.text();
    const frames = text.split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => JSON.parse(f.slice(6)));
    t('SSE content-type + 1.0 StreamResponse 帧', () => {
        if (!/text\/event-stream/.test(String(res.headers.get('content-type'))) ) throw new Error('非 SSE');
        if (frames.length < 2) throw new Error(`帧数 ${frames.length}`);
        if (frames.some((f) => f.result.kind !== undefined)) throw new Error('流帧带 kind');
        const st = frames.map((f) => f.result.statusUpdate).filter(Boolean).map((x) => x.status.state);
        if (!st.includes('TASK_STATE_COMPLETED')) throw new Error(st.join(','));
        const art = frames.map((f) => f.result.artifactUpdate).filter(Boolean)[0];
        if (!art || art.artifact.parts[0].kind !== undefined || art.artifact.parts[0].text !== 'stub-reply:stream-v1') {
            throw new Error('artifactUpdate 形态错');
        }
    });
}

await server.stop();
console.log(`\n--- summary ---\npass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
