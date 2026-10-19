# dsh-a2a

DSH（DeepSeek Harness）的 **A2A（Agent2Agent）协议**插件。

DSH 内置的互操作走 ACP + MCP，不包含 A2A；本插件补上这块拼图，**双向**打通 A2A 生态（Google ADK、a2ajava / a2a-python SDK、各类 agent 网关）：

- **服务器方向（入站）**：把 DSH agent 暴露为标准 A2A 服务器
  - Agent Card：`/.well-known/agent-card.json`（0.3.x）与 `/.well-known/agent.json`（0.2.x 兼容）
  - JSON-RPC 2.0：`message/send`（同步）、`message/stream`（SSE 流式）、`tasks/get`、`tasks/cancel`、`tasks/resubscribe`（断线续订）、`agent/authenticatedExtendedCard`
  - 任务生命周期 `submitted → working → completed/failed/canceled`，支持 `input-required` 暂停与 taskId 多轮续答
  - 版本协商（`A2A-Version` / `X-A2A-Version` 头）、可选 Bearer 鉴权、CORS、单轮超时、任务 TTL 回收
- **客户端方向（出站）**：注册 `a2a_*` 模型工具，让任意 DSH agent 直接呼叫远端 A2A agent
  - `a2a_discover` / `a2a_send` / `a2a_task_status` / `a2a_cancel`
  - 地址白名单（`clientAllowPatterns`）控制 agent 可呼叫的目标
- **可视化运维面板**（Web client 半，v0.2.0）：Plugins → @zyfgood/dsh-a2a 的配置卡与设置 Plugins 分区的 A2A 标签页
  - 服务器状态：运行中/模式/地址/协议版本/鉴权 + curl 验证命令一键复制
  - 实时任务板：最近任务的状态徽标/上下文/产物数，非终态任务一键取消（5s 自动刷新）
  - 远端 agent 目录：保存常用远端地址，浏览器直连拉取其 Agent Card（名称/版本/技能）
  - 数据来自 A2A 服务器自带的 `/admin/status`、`/admin/tasks` 端点（Bearer 门禁同 JSON-RPC）

零运行时依赖（纯 Node ≥20 stdlib + 全局 fetch），与 [dsh-feishu-bot](https://github.com/zyfgood/dsh-feishu-bot) 同一插件体系。

## 一、安装

```bash
# 官方 CLI 一键安装（npm 渠道，推荐；bundle patch 自动挂载）
dsh plugin --profile <name> add @zyfgood/dsh-a2a

# 或 GitHub
dsh plugin --profile <name> add github:zyfgood/dsh-a2a

# 或本地路径
dsh plugin --profile <name> add file:D:/DSHProjects/dsh-a2a
```

> npm 裸名 `dsh-a2a` 是另一个无关项目（TtTRz/dsh-a2a），本插件发布在 `@zyfgood` scope 下，安装时请带 scope。

重启 profile 后生效。默认监听 `127.0.0.1:7310`。

> `lib/` 预构建产物随仓库发布，安装即用，无需构建脚本（无 pnpm ≥10 的 `allowBuilds` 步骤）。

## 二、快速验证

```bash
# 1) Agent Card（0.3 路径）
curl http://127.0.0.1:7310/.well-known/agent-card.json

# 2) 发一条消息（同步）
curl -X POST http://127.0.0.1:7310/ -H "Content-Type: application/json" -d '{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message/send",
  "params": {
    "message": {
      "kind": "message",
      "role": "user",
      "parts": [{"kind": "text", "text": "你好，介绍一下你自己"}],
      "messageId": "m-1",
      "contextId": "ctx-demo"
    }
  }
}'
```

返回的 `result` 是 A2A Task：`status.state === "completed"`，回复文本在 `artifacts[0].parts[0].text`。同一 `contextId` 再次调用会复用同一个 DSH agent 会话（多轮记忆）。

流式：

```bash
curl -N -X POST http://127.0.0.1:7310/ \
  -H "Content-Type: application/json" -H "Accept: text/event-stream" -d '{
  "jsonrpc": "2.0", "id": 2, "method": "message/stream",
  "params": {"message": {"kind": "message", "role": "user",
    "parts": [{"kind": "text", "text": "流式演示"}], "messageId": "m-2", "contextId": "ctx-demo"}}
}'
```

SSE 依次推送 `status-update(working)` → `artifact-update` → `status-update(completed, final=true)` 后自然收流。

## 三、配置项

profile 的 `cordis.patch.yml`（或本包 `cordis.patch.yml` 默认层）：

```yaml
- id: a2a
  name: '@zyfgood/dsh-a2a'
  config:
    port: 7310
    mode: agent
```

| 配置 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 监听地址；公网暴露改 `0.0.0.0` 并配合鉴权 |
| `port` | `7310` | 监听端口（`0` = 系统分配） |
| `publicUrl` | 按监听地址推导 | 写入 Agent Card 的 `url`；反代/TLS 部署时必须配置为外部可达地址 |
| `bearerToken` | 无 | Bearer 鉴权令牌，支持 `env:VAR`；配置后卡片宣告 `bearerAuth` |
| `agentName` / `agentDescription` / `agentVersion` | `DSH Agent` / … | Agent Card 元信息 |
| `peerName` | 同 `agentName` | 本端 peer 名：出站消息写入 `metadata.from`，供对端把回话路由回来 |
| `skills` | 内置一条 dsh-agent 技能 | Agent Card 技能清单 |
| `mode` | `agent` | 入站处理模式：`agent` / `llm` / `echo`（见下） |
| `provider` / `model` | — | 模型来源：`llm` 模式直答，`agent` 模式创建会话时写入；未配置时回退宿主默认模型（GUI 的默认模型，即 profile 的 `agent-default-model` 分节） |
| `systemPrompt` / `maxHistory` | — | `llm` 模式参数（`ctx.llm` 直答，短期记忆按 `maxHistory`） |
| `agentId` | 自动 | `agent` 模式：固定复用 `ctx.agents` 中某会话；不配置则按 contextId 自动创建 |
| `agentPreset` | GUI 默认预设 | 自动创建会话的 preset（决定 agent 可用的工具集） |
| `workspace` | `process.cwd()` | 自动创建会话的工作目录 |
| `persistSessions` | `true` | contextId → 会话映射落盘（`$DSH_HOME/a2a/`），重启后自动恢复上下文 |
| `turnTimeoutMs` | `600000` | 单轮执行上限，超时任务置 `failed` |
| `taskTtlMs` | `3600000` | 已完结任务内存保留时长（之后 TTL 回收） |
| `tools` | `true` | 是否注册 `a2a_*` 出站工具 |
| `clientAllowPatterns` | `['*']` | 出站白名单：`'*'`、`https://a2a.example.com/`、`https://*.example.com/`、`'*:7310'` |
| `clientTimeoutMs` | `120000` | 出站调用超时 |

### 三种入站模式

- **`agent`（默认）**：每个 A2A `contextId` 对应一个持久 DSH agent 会话（完整工具/技能/工作目录），跨任务续答；映射可落盘跨重启恢复。会话忙时新消息走 `steer`（下一 step 边界消费）。
- **`llm`**：`ctx.llm` 直答（自包含轻量模式，不建 agent 会话，短期记忆按 `maxHistory`）。
- **`echo`**：回显原文，验证链路。

## 四、出站：agent 调用远端 A2A

插件默认注册 4 个模型工具（`tools: false` 关闭）：

| 工具 | 对应协议方法 | 用途 |
|---|---|---|
| `a2a_discover` | `GET /.well-known/agent-card.json` | 拉取远端 Agent Card（能力/技能/鉴权） |
| `a2a_send` | `message/stream`（自动降级 `message/send` + 轮询） | 发消息并等待远端最终回复；`kind` 参数（`message`/`request`/`result`，默认 `message`）对应出站 `metadata.kind` |
| `a2a_task_status` | `tasks/get` | 查询远端任务状态 |
| `a2a_cancel` | `tasks/cancel` | 取消远端任务 |

对话示例：「用 a2a_send 呼叫 http://其它机器:7310/ 的 agent，问它有哪些技能，把结果汇总给我」。

## 五、开发

```bash
pnpm verify   # 本地 typecheck（shims/ 提供 @deepseek-ai 结构类型）
pnpm test     # 构建 DSH 无关核心 + 40 项端到端冒烟测试
pnpm build:local  # 本地全量构建 lib/（shims 类型校验，产物与宿主构建一致）
pnpm build    # 完整构建（需要宿主环境提供 @deepseek-ai/* peer 依赖）
```

代码结构：

```
src/
├── index.ts       插件入口：Config schema + apply()
├── protocol.ts    A2A 类型 / JSON-RPC / Agent Card（纯函数，零依赖）
├── store.ts       任务存储 + SSE 事件中枢（事件缓冲、订阅、TTL）
├── server.ts      HTTP 服务器：card / message/send / message/stream(SSE) / tasks/* / admin/*
├── bridge.ts      DSH 桥接：echo / llm / agent 三种 TaskRunner
├── client.ts      出站 A2A 客户端（fetch + SSE 解析）
├── tools.ts       a2a_* 模型工具注册
└── persistence.ts contextId → 会话映射落盘
client/
└── client.js      浏览器半：A2A 运维面板（免构建 ModuleLoader 工厂，react 为宿主 external）
```

设计说明：

- `protocol` / `store` / `server` / `client` 不依赖任何 DSH 包，可独立构建与测试；DSH 桥接收敛在 `bridge.ts` / `tools.ts` / `index.ts`。
- **agent 模式必须有模型**：agent-loop 不自动兜底 provider/model，缺失时提示词组装里的 `{{model}}` 无值，每轮立即报错（表现为「无文本输出」）。插件因此按「配置 provider/model → 回退 `ctx.agentDefaultModel.currentSelection()`」解析，两者都拿不到时直接返回明确的失败说明；本轮若以 `turn/end reason=error` 结束，错误原因会被回给客户端而不是笼统占位符。改 profile 的默认模型后，新建的 A2A 会话即生效（已存在的会话沿用原模型，删 `$DSH_HOME/a2a/context-sessions.json` 条目可重建）。
- 任务 id 参数：规范写法 `params.id` 与本插件旧约定 `params.taskId` 都接受（`tasks/get` / `tasks/cancel` / `tasks/resubscribe`）。
- 出站元数据：`message.metadata` 恒带 `kind`（默认 `message`，`a2a_send` 的 `kind` 参数可指定 `request`/`result`）；配置 `peerName` 后附带 `from`，供对端（如 pi-a2a）路由回话。
- 卡片解析兼容：顶层 `url`（0.2/0.3）与 A2A v1.0 的 `supportedInterfaces[].url` 两种形态都接受，仅 v1.0 形态的卡片也能发现。
- `input-required` 事件带 `final=true` 关闭当轮 SSE，但任务保持非终态，客户端可凭 `taskId` 续答（续答复用同一任务与 history）。
- `tasks/cancel` 立即广播 `canceled(final=true)`；agent 模式下正在运行的一轮会在 500ms 轮询粒度感知退出并尽力 `interrupt`，不会阻塞后续轮次。
- 与 A2A 0.2.x 客户端的兼容：旧 card 路径照常服务；0.2 客户端不发送版本头时按同版本处理。
- 不支持的协议面按规范返回明确错误码：push notification `-32003`、批量 JSON-RPC `-32600`。

## 六、与 DSH 内置能力的关系

| 需求 | 用什么 |
|---|---|
| 程序化驱动 DSH agent（进程外） | 内置 ACP（`dsh-acp`，`pnpm dsh --profile acp`） |
| 挂载外部工具/资源 | 内置 MCP 客户端 |
| 跨 agent 生态互操作（Google ADK / A2A SDK） | **本插件** |

## License

MIT
