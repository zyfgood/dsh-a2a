/**
 * dsh-a2a 冒烟测试（端到端，零 DSH 依赖）。
 *
 * 直接驱动编译产物 lib/（先 `tsc -p tsconfig.test.json` 构建核心）：
 * 起真实 A2A 服务器（echo/门控/input-required 三种假 runner），
 * 用原生 fetch + A2aClient 回环验证：
 *   1. Agent Card（0.3 / 0.2 双路径、字段、鉴权宣告）
 *   2. 版本协商头（A2A-Version 应答 / X-A2A-Version 主版本冲突拒绝）
 *   3. message/send（同步完结、contextId 生成与按 context 记忆）
 *   4. message/stream（SSE 事件序列 working→artifact→final、流自然关闭）
 *   5. tasks/get（命中 / 未命中 -32001）
 *   6. tasks/cancel（进行中可取消 / 已完结 -32002 / 不存在 -32001）
 *   7. input-required 暂停 + taskId 续答（多轮）
 *   8. tasks/resubscribe（缓冲回放 + 实时跟随）
 *   9. JSON-RPC 错误（未知方法 -32601、坏参数 -32602、解析错误 -32700）
 *  10. Bearer 鉴权（401/通过、卡片 securitySchemes）
 *  11. A2aClient 回环（card 发现、sendForText 流式与同步两条路径）
 *  12. matchesAllowlist 白名单纯函数
 *
 * 运行：node tests/smoke.mjs（失败非零退出）。
 */

import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { A2aServer, silentLogger } from '../lib/server.js'
import { buildAgentCard } from '../lib/protocol.js'
import { A2aClient, matchesAllowlist } from '../lib/client.js'

// ── 测试基础设施 ────────────────────────────────────────────────────────

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL  ${name}`)
    console.error(error instanceof Error ? error.stack : String(error))
  }
}

function textOf(task) {
  const out = []
  for (const artifact of task.artifacts ?? []) {
    for (const part of artifact.parts) {
      if (part.kind === 'text') out.push(part.text)
    }
  }
  return out.join('\n').trim()
}

/** echo runner：按 contextId 计数（验证上下文复用），支持关键字控制行为。 */
function echoRunner() {
  const counters = new Map()
  const gates = new Map() // taskId -> release
  return {
    async run({ controller, message }) {
      const text = message.parts.filter((p) => p.kind === 'text').map((p) => p.text).join('')
      controller.updateStatus('working')
      if (text === 'NEED_INPUT') {
        controller.addArtifact([{ kind: 'text', text: '请补充：要反转的文本是？' }])
        controller.updateStatus('input-required')
        return
      }
      if (text.startsWith('ANSWER:')) {
        const source = message.parts.filter((p) => p.kind === 'text').map((p) => p.text).join('')
        controller.addArtifact([{ kind: 'text', text: `结果：${source.slice(7).split('').reverse().join('')}` }])
        controller.updateStatus('completed')
        return
      }
      if (text === 'GATE') {
        // 挂起直到 release(taskId) 被调用；期间可被 tasks/cancel 打断。
        await new Promise((resolve) => gates.set(controller.taskId, resolve))
        if (controller.canceled) return
        controller.addArtifact([{ kind: 'text', text: 'gated done' }])
        controller.updateStatus('completed')
        return
      }
      const n = (counters.get(message.contextId) ?? 0) + 1
      counters.set(message.contextId, n)
      controller.addArtifact([{ kind: 'text', text: `echo: ${text} (#${n})` }])
      controller.updateStatus('completed')
    },
    release(taskId) {
      const resolve = gates.get(taskId)
      if (resolve !== undefined) {
        gates.delete(taskId)
        resolve()
      }
    },
  }
}

async function startServer(options = {}) {
  const runner = options.runner ?? echoRunner()
  const server = new A2aServer({
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1:0/',
    card: options.card ?? buildAgentCard({
      name: 'Smoke Agent',
      description: '冒烟测试',
      url: 'http://127.0.0.1/',
      version: '9.9.9',
      ...(options.bearerToken !== undefined ? { bearerToken: options.bearerToken } : {}),
    }),
    runner,
    logger: silentLogger,
    turnTimeoutMs: 5000,
    taskTtlMs: 600_000,
    ...(options.bearerToken !== undefined ? { bearerToken: options.bearerToken } : {}),
  })
  await server.start()
  return { server, url: server.address, runner }
}

function rpcId() {
  return Math.random().toString(36).slice(2, 10)
}

async function post(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: response.status, response }
}

/** post + 解析 JSON 响应（测试主体大量使用）。 */
async function postJson(url, body, headers = {}) {
  const { response } = await post(url, body, headers)
  return response.json()
}

function messageSendParams(text, extra = {}) {
  return {
    message: {
      kind: 'message',
      role: 'user',
      parts: [{ kind: 'text', text }],
      messageId: `m-${rpcId()}`,
      ...extra,
    },
  }
}

/** 手工解析 SSE 流（不经过 A2aClient，先验证原始 wire 格式）。 */
async function collectSse(response, onEvent) {
  const events = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data === '') continue
      const payload = JSON.parse(data)
      if ('error' in payload) throw new Error(`SSE 内 JSON-RPC 错误: ${JSON.stringify(payload.error)}`)
      events.push(payload.result)
      onEvent?.(payload.result)
    }
  }
  return events
}

/**
 * 捕获出站 JSON-RPC 请求体的最小假服务器：
 * - POST 到根路径 → 记录解析后的 body，按 handler 返回 result；
 * - GET 卡片路径 → 返回 setCard 提供的卡片。
 * 用于断言 A2aClient 实际发出的 message.metadata 与卡片解析行为。
 */
async function startCapture(handler) {
  const messages = []
  let card = null
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(card))
        return
      }
      const parsed = JSON.parse(body)
      messages.push(parsed)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: handler(parsed) }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  return {
    url,
    messages,
    setCard: (value) => { card = value },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function completedTask() {
  return {
    kind: 'task',
    id: 'inline',
    contextId: 'inline',
    status: { state: 'completed', timestamp: new Date().toISOString() },
  }
}

// ── 主流程 ─────────────────────────────────────────────────────────────

const main = async () => {
  console.log('dsh-a2a 冒烟测试\n')

  const openServer = await startServer()
  const base = openServer.url
  const rpc = base // JSON-RPC 打到站点根

  await test('Agent Card：0.3 标准路径字段完整', async () => {
    const response = await fetch(`${base.replace(/\/$/, '')}/.well-known/agent-card.json`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /application\/json/)
    const card = await response.json()
    assert.equal(card.name, 'Smoke Agent')
    assert.equal(card.protocolVersion, '0.3.0')
    assert.equal(card.preferredTransport, 'JSONRPC')
    assert.equal(card.capabilities.streaming, true)
    assert.equal(card.capabilities.pushNotifications, false)
    assert.ok(Array.isArray(card.skills) && card.skills.length > 0)
    assert.deepEqual(card.security, [])
  })

  await test('Agent Card：0.2 旧路径兼容', async () => {
    const response = await fetch(`${base.replace(/\/$/, '')}/.well-known/agent.json`)
    assert.equal(response.status, 200)
    const card = await response.json()
    assert.equal(card.name, 'Smoke Agent')
  })

  await test('版本协商：应答 A2A-Version 头', async () => {
    const response = await fetch(`${base.replace(/\/$/, '')}/.well-known/agent-card.json`)
    assert.equal(response.headers.get('a2a-version'), '0.3.0')
  })

  await test('版本协商：主版本冲突返回 400', async () => {
    const { status } = await post(rpc, {
      jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('hi'),
    }, { 'X-A2A-Version': '99.0.1' })
    assert.equal(status, 400)
  })

  await test('message/send：同步完结 + contextId 自动生成', async () => {
    const { response } = await post(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('hello') })
    const payload = await response.json()
    assert.ok('result' in payload, `应返回 result: ${JSON.stringify(payload)}`)
    const task = payload.result
    assert.equal(task.kind, 'task')
    assert.equal(task.status.state, 'completed')
    assert.equal(textOf(task), 'echo: hello (#1)')
    assert.ok(typeof task.contextId === 'string' && task.contextId.length > 0)
  })

  await test('message/send：同 contextId 复用 runner 状态', async () => {
    const first = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('a', { contextId: 'ctx-42' }) })
    const second = await postJson(rpc, { jsonrpc: '2.0', id: 2, method: 'message/send', params: messageSendParams('b', { contextId: 'ctx-42' }) })
    assert.equal(textOf(first.result), 'echo: a (#1)')
    assert.equal(textOf(second.result), 'echo: b (#2)')
    assert.equal(second.result.contextId, 'ctx-42')
  })

  await test('message/stream：SSE 事件序列 working→artifact→final', async () => {
    const response = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 's1', method: 'message/stream', params: messageSendParams('stream me') }),
    })
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const events = await collectSse(response)
    assert.ok(events.length >= 3, `事件数应 ≥3: ${JSON.stringify(events.map((e) => e.kind))}`)
    assert.equal(events[0].kind, 'status-update')
    assert.equal(events[0].status.state, 'working')
    assert.equal(events[0].final, false)
    const artifactEvent = events.find((e) => e.kind === 'artifact-update')
    assert.ok(artifactEvent !== undefined, '应包含 artifact-update')
    assert.equal(artifactEvent.artifact.parts[0].text, 'echo: stream me (#1)')
    const last = events[events.length - 1]
    assert.equal(last.kind, 'status-update')
    assert.equal(last.status.state, 'completed')
    assert.equal(last.final, true)
  })

  await test('tasks/get：命中', async () => {
    const send = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('x') })
    const got = await postJson(rpc, { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId: send.result.id } })
    assert.equal(got.result.id, send.result.id)
    assert.equal(got.result.status.state, 'completed')
  })

  await test('tasks/get：未命中 -32001', async () => {
    const got = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { taskId: 'nope' } })
    assert.equal(got.error.code, -32001)
  })

  await test('任务 id 参数：规范写法 params.id 与 params.taskId 都接受', async () => {
    const send = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('y') })
    const byId = await postJson(rpc, { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: send.result.id } })
    assert.equal(byId.result.id, send.result.id)
    const missing = await postJson(rpc, { jsonrpc: '2.0', id: 3, method: 'tasks/get', params: {} })
    assert.equal(missing.error.code, -32602)
    const ghost = await postJson(rpc, { jsonrpc: '2.0', id: 4, method: 'tasks/cancel', params: { id: 'ghost' } })
    assert.equal(ghost.error.code, -32001)
  })

  await test('tasks/cancel：进行中任务可取消', async () => {
    // GATE 任务挂起中；从首个 SSE 事件（working）取 taskId 后取消。
    const events = []
    const gated = (async () => {
      const response = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'sg', method: 'message/stream', params: messageSendParams('GATE') }),
      })
      await collectSse(response, (e) => events.push(e))
    })()
    for (let i = 0; i < 100 && events.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.ok(events.length > 0, '应收到 working 事件')
    const gateTaskId = events[0].taskId
    const canceled = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'tasks/cancel', params: { taskId: gateTaskId } })
    assert.equal(canceled.result.status.state, 'canceled')
    await gated
    const last = events[events.length - 1]
    assert.equal(last.kind, 'status-update')
    assert.equal(last.status.state, 'canceled')
    assert.equal(last.final, true)
  })

  await test('tasks/cancel：已完结任务 -32002', async () => {
    const send = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('done') })
    const res = await postJson(rpc, { jsonrpc: '2.0', id: 2, method: 'tasks/cancel', params: { taskId: send.result.id } })
    assert.equal(res.error.code, -32002)
  })

  await test('tasks/cancel：不存在 -32001', async () => {
    const res = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'tasks/cancel', params: { taskId: 'ghost' } })
    assert.equal(res.error.code, -32001)
  })

  await test('input-required：暂停 + taskId 续答', async () => {
    const first = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('NEED_INPUT', { contextId: 'ctx-multi' }) })
    assert.equal(first.result.status.state, 'input-required')
    assert.equal(textOf(first.result), '请补充：要反转的文本是？')
    const second = await postJson(rpc, {
      jsonrpc: '2.0', id: 2, method: 'message/send',
      params: messageSendParams('ANSWER:abcde', { contextId: 'ctx-multi', taskId: first.result.id }),
    })
    assert.ok('result' in second, JSON.stringify(second))
    assert.equal(second.result.status.state, 'completed')
    // 同一任务的两轮 artifact 会累积：最后一项是续答结果。
    const artifacts = second.result.artifacts
    assert.equal(artifacts[artifacts.length - 1].parts[0].text, '结果：edcba')
    assert.equal(second.result.id, first.result.id, '续答应复用同一任务')
    assert.ok((second.result.history ?? []).length >= 2, 'history 应包含两轮消息')
  })

  await test('续答非法状态：对 completed 任务带 taskId → -32001', async () => {
    const send = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('plain', { contextId: 'ctx-plain' }) })
    const res = await postJson(rpc, {
      jsonrpc: '2.0', id: 2, method: 'message/send',
      params: messageSendParams('again', { contextId: 'ctx-plain', taskId: send.result.id }),
    })
    assert.equal(res.error.code, -32001)
  })

  await test('tasks/resubscribe：缓冲回放 + 实时跟随', async () => {
    const events = []
    const gated = (async () => {
      const response = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'sr', method: 'message/stream', params: messageSendParams('GATE') }),
      })
      await collectSse(response, (e) => events.push(e))
    })()
    for (let i = 0; i < 100 && events.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const taskId = events[0].taskId
    // 第二条连接 resubscribe：应先回放 working，再实时收到 final。
    const reEvents = []
    const reSub = (async () => {
      const response = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'rs', method: 'tasks/resubscribe', params: { taskId } }),
      })
      await collectSse(response, (e) => reEvents.push(e))
    })()
    for (let i = 0; i < 100 && reEvents.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(reEvents[0].status.state, 'working', '应回放缓冲的 working 事件')
    openServer.runner.release(taskId)
    await Promise.all([gated, reSub])
    assert.equal(reEvents[reEvents.length - 1].status.state, 'completed')
    assert.equal(reEvents[reEvents.length - 1].final, true)
  })

  await test('JSON-RPC：未知方法 -32601', async () => {
    const res = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'magic/wand' })
    assert.equal(res.error.code, -32601)
  })

  await test('JSON-RPC：坏参数 -32602', async () => {
    const res = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'robot' } } })
    assert.equal(res.error.code, -32602)
  })

  await test('JSON-RPC：解析错误 -32700', async () => {
    const { response } = await post(rpc, '{not json')
    const payload = await response.json()
    assert.equal(payload.error.code, -32700)
    assert.equal(payload.id, null)
  })

  await test('JSON-RPC：批量请求拒绝 -32600', async () => {
    const { response } = await post(rpc, [{ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: {} }])
    const payload = await response.json()
    assert.equal(payload.error.code, -32600)
  })

  await test('pushNotificationConfig → -32003', async () => {
    const res = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'tasks/pushNotificationConfig/set', params: {} })
    assert.equal(res.error.code, -32003)
  })

  await test('未知路径 404', async () => {
    const response = await fetch(`${base.replace(/\/$/, '')}/nope`)
    assert.equal(response.status, 404)
  })

  // ── 运维端点（client 面板数据源）─────────────────────────────────

  await test('/admin/status：状态摘要', async () => {
    const response = await fetch(`${base.replace(/\/$/, '')}/admin/status`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('a2a-version'), '0.3.0')
    const status = await response.json()
    assert.equal(status.running, true)
    assert.equal(status.mode, 'agent')
    assert.equal(status.protocolVersion, '0.3.0')
    assert.equal(status.auth, false)
    assert.equal(status.card.name, 'Smoke Agent')
    assert.ok(typeof status.tasks.total === 'number')
  })

  await test('/admin/tasks：任务摘要（倒序、限条数、含状态）', async () => {
    const first = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('t1', { contextId: 'ctx-admin' }) })
    const second = await postJson(rpc, { jsonrpc: '2.0', id: 2, method: 'message/send', params: messageSendParams('t2', { contextId: 'ctx-admin' }) })
    const response = await fetch(`${base.replace(/\/$/, '')}/admin/tasks?limit=2`)
    const { tasks } = await response.json()
    assert.equal(tasks.length, 2)
    assert.equal(tasks[0].id, second.result.id, '倒序：最新在前')
    assert.equal(tasks[1].id, first.result.id)
    assert.equal(tasks[0].state, 'completed')
    assert.equal(tasks[0].contextId, 'ctx-admin')
    assert.equal(tasks[0].artifacts, 1)
    // 假 runner 不调 recordHistory：history 只有服务端记录的 user 消息。
    assert.equal(tasks[0].history, 1)
  })

  // ── A2aClient 回环 ────────────────────────────────────────────────

  const client = new A2aClient({ baseUrl: base, timeoutMs: 5000 })

  await test('A2aClient.card：发现远端卡片', async () => {
    const card = await client.card()
    assert.equal(card.name, 'Smoke Agent')
    assert.equal(card.protocolVersion, '0.3.0')
  })

  await test('A2aClient.sendForText：同步路径', async () => {
    const { task, text } = await client.sendForText('sync call', { preferStream: false })
    assert.equal(task.status.state, 'completed')
    assert.match(text, /^echo: sync call \(#\d+\)$/)
  })

  await test('A2aClient.sendForText：流式路径（SSE）', async () => {
    const seen = []
    const { task, text } = await client.sendForText('stream call', {
      preferStream: true,
      contextId: 'ctx-client-stream',
      onEvent: (e) => seen.push(e.kind),
    })
    assert.equal(task.status.state, 'completed')
    assert.match(text, /^echo: stream call \(#1\)$/)
    assert.ok(seen.includes('status-update'), `事件应含 status-update: ${seen}`)
    assert.ok(seen.includes('artifact-update'), `事件应含 artifact-update: ${seen}`)
  })

  await test('A2aClient.send：默认 metadata.kind=message，未配置 peerName 时不含 from', async () => {
    const fake = await startCapture(() => completedTask())
    try {
      const captureClient = new A2aClient({ baseUrl: fake.url, timeoutMs: 5000 })
      await captureClient.send('metadata default')
      const metadata = fake.messages[0].params.message.metadata
      assert.equal(metadata.kind, 'message')
      assert.equal('from' in metadata, false)
    } finally {
      await fake.close()
    }
  })

  await test('A2aClient：peerName 写入 metadata.from，kind 选项透传', async () => {
    const fake = await startCapture(() => completedTask())
    try {
      const captureClient = new A2aClient({ baseUrl: fake.url, peerName: 'dsh-peer', timeoutMs: 5000 })
      await captureClient.send('request it', { kind: 'request' })
      assert.deepEqual(fake.messages[0].params.message.metadata, { kind: 'request', from: 'dsh-peer' })
    } finally {
      await fake.close()
    }
  })

  await test('A2aClient.sendStream：metadata 携带 from/kind', async () => {
    const fake = await startCapture(() => completedTask())
    try {
      const captureClient = new A2aClient({ baseUrl: fake.url, peerName: 'dsh-peer', timeoutMs: 5000 })
      await captureClient.sendStream('stream metadata', () => {}, { kind: 'result' })
      assert.deepEqual(fake.messages[0].params.message.metadata, { kind: 'result', from: 'dsh-peer' })
    } finally {
      await fake.close()
    }
  })

  await test('A2aClient.card：接受 v1.0 supportedInterfaces 形态（无顶层 url）', async () => {
    const fake = await startCapture(() => completedTask())
    try {
      fake.setCard({
        name: 'v1-peer',
        description: 'v1 card',
        version: '1.0.0',
        supportedInterfaces: [{ url: 'http://127.0.0.1:9999/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        capabilities: { streaming: false, pushNotifications: true, stateTransitionHistory: false },
        skills: [],
      })
      const captureClient = new A2aClient({ baseUrl: fake.url, timeoutMs: 5000 })
      const card = await captureClient.card()
      assert.equal(card.url, 'http://127.0.0.1:9999/rpc')
      assert.equal(card.name, 'v1-peer')
    } finally {
      await fake.close()
    }
  })

  await test('A2aClient.card：url 与 supportedInterfaces 都缺失时报明确错误', async () => {
    const fake = await startCapture(() => completedTask())
    try {
      fake.setCard({ name: 'broken', version: '1.0.0' })
      const captureClient = new A2aClient({ baseUrl: fake.url, timeoutMs: 5000 })
      await assert.rejects(() => captureClient.card(), /url|supportedInterfaces/i)
    } finally {
      await fake.close()
    }
  })

  await test('A2aClient.getTask / cancelTask 错误映射', async () => {
    await assert.rejects(() => client.getTask('ghost'), (error) => error.code === -32001)
    await assert.rejects(() => client.cancelTask('ghost'), (error) => error.code === -32001)
  })

  await openServer.server.stop()

  // ── Bearer 鉴权服务器 ─────────────────────────────────────────────

  const authServer = await startServer({ bearerToken: 'secret-token' })
  const authBase = authServer.url
  const authClient = new A2aClient({ baseUrl: authBase, bearerToken: 'secret-token', timeoutMs: 5000 })

  await test('鉴权：无令牌 401', async () => {
    const { status } = await post(authBase, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('hi') })
    assert.equal(status, 401)
  })

  await test('鉴权：错误令牌 401', async () => {
    const { status } = await post(authBase, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('hi') }, { Authorization: 'Bearer wrong' })
    assert.equal(status, 401)
  })

  await test('鉴权：正确令牌通过', async () => {
    const { task, text } = await authClient.sendForText('auth ok', { preferStream: false })
    assert.equal(task.status.state, 'completed')
    assert.match(text, /^echo: auth ok/)
  })

  await test('鉴权：卡片宣告 bearerAuth 方案', async () => {
    const card = await authClient.card()
    assert.ok(card.securitySchemes?.bearerAuth !== undefined)
    assert.deepEqual(card.security, [{ bearerAuth: [] }])
  })

  await test('鉴权：卡片本身公开可读', async () => {
    const response = await fetch(`${authBase.replace(/\/$/, '')}/.well-known/agent-card.json`)
    assert.equal(response.status, 200)
  })

  await test('鉴权：/admin/* 同样受 Bearer 保护', async () => {
    const noAuth = await fetch(`${authBase.replace(/\/$/, '')}/admin/status`)
    assert.equal(noAuth.status, 401)
    const withAuth = await fetch(`${authBase.replace(/\/$/, '')}/admin/status`, { headers: { Authorization: 'Bearer secret-token' } })
    assert.equal(withAuth.status, 200)
    const status = await withAuth.json()
    assert.equal(status.auth, true)
  })

  await authServer.server.stop()

  // ── matchesAllowlist 纯函数 ───────────────────────────────────────

  await test('matchesAllowlist：通配与前缀', () => {
    assert.equal(matchesAllowlist(['*'], 'http://anywhere:1/'), true)
    assert.equal(matchesAllowlist(['http://127.0.0.1:7310/'], 'http://127.0.0.1:7310/'), true)
    assert.equal(matchesAllowlist(['http://127.0.0.1:7310/'], 'http://127.0.0.1:9999/'), false)
    assert.equal(matchesAllowlist(['https://a2a.example.com/'], 'https://a2a.example.com/.well-known/agent-card.json'), true)
    assert.equal(matchesAllowlist(['https://*.example.com/'], 'https://agents.example.com/'), true)
    assert.equal(matchesAllowlist(['https://*.example.com/'], 'https://example.com/'), true)
    assert.equal(matchesAllowlist(['https://*.example.com/'], 'https://evil.net/'), false)
    assert.equal(matchesAllowlist(['*:7310'], 'http://10.0.0.5:7310/'), true)
    assert.equal(matchesAllowlist(['*:7310'], 'http://10.0.0.5:7311/'), false)
    assert.equal(matchesAllowlist([], 'http://any/'), false)
    assert.equal(matchesAllowlist(['*'], 'not a url'), false)
  })

  // ── 汇总 ─────────────────────────────────────────────────────────

  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
  if (failures.length > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('冒烟测试框架异常', error)
  process.exitCode = 1
})
