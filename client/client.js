/**
 * dsh-a2a client（浏览器半）：A2A 运维面板。
 *
 * 免构建：本文件手写为 window.__ModuleLoader__ 工厂包裹的 ESM 模块，
 * react 由宿主模块表注入为 external。注册两个座位：
 * - `plugins.bundle.config`（key = 包名 dsh-a2a）：插件页里本 bundle 的
 *   配置卡（Plugins → dsh-a2a → 卡片）；
 * - `settings.plugins.tab`：设置 Plugins 分区的独立标签页。
 *
 * 面板内容（数据来自 A2A 服务器自带的 /admin/* 端点，浏览器直连）：
 * - 服务器状态：运行中/模式/地址/协议版本/鉴权 + Agent Card 预览与
 *   curl 快速验证命令（复制）；
 * - 实时任务板：最近任务（状态徽标/上下文/时间），非终态可一键取消；
 * - 远端 agent 目录：保存常用远端 A2A 地址，浏览器直连拉取其
 *   Agent Card（显示名称/版本/技能），地址存 localStorage。
 *
 * 旧宿主优雅降级：依赖的 slot 不存在时 slots.inject 静默等待，
 * 面板不渲染、不报错。
 */
window.__ModuleLoader__.load({
  id: '@zyfgood/dsh-a2a',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement
    const useState = react.useState
    const useEffect = react.useEffect
    const useCallback = react.useCallback

    const NS = 'dsh-a2a'
    const PACKAGE = '@zyfgood/dsh-a2a'
    const DEFAULT_BASE = 'http://127.0.0.1:7310/'

    const dict = {
      zh: {
        title: 'A2A 运维面板',
        baseUrl: 'A2A 服务地址',
        refresh: '刷新',
        statusRunning: '运行中',
        statusDown: '未连接',
        mode: '模式',
        protocol: '协议',
        auth: '鉴权',
        authOn: '需要 Bearer 令牌',
        authOff: '开放访问',
        tasks: '最近任务',
        tasksEmpty: '暂无任务',
        taskState: { submitted: '已提交', working: '执行中', 'input-required': '待补充输入', completed: '已完成', failed: '失败', canceled: '已取消', rejected: '已拒绝' },
        cancel: '取消',
        canceling: '取消中…',
        context: '上下文',
        artifacts: '产物',
        remoteTitle: '远端 agent 目录',
        remoteAdd: '添加远端地址',
        remoteFetch: '拉取卡片',
        remoteEmpty: '尚未添加远端 agent',
        cardPreview: 'Agent Card',
        curlHint: 'curl 验证',
        copy: '复制',
        copied: '已复制',
        fetchError: '请求失败',
        token: 'Bearer 令牌（可选）',
        autoRefresh: '自动刷新',
      },
      en: {
        title: 'A2A Ops Panel',
        baseUrl: 'A2A server URL',
        refresh: 'Refresh',
        statusRunning: 'Running',
        statusDown: 'Not connected',
        mode: 'Mode',
        protocol: 'Protocol',
        auth: 'Auth',
        authOn: 'Bearer token required',
        authOff: 'Open access',
        tasks: 'Recent tasks',
        tasksEmpty: 'No tasks yet',
        taskState: { submitted: 'Submitted', working: 'Working', 'input-required': 'Input required', completed: 'Completed', failed: 'Failed', canceled: 'Canceled', rejected: 'Rejected' },
        cancel: 'Cancel',
        canceling: 'Canceling…',
        context: 'context',
        artifacts: 'artifacts',
        remoteTitle: 'Remote agent directory',
        remoteAdd: 'Add remote URL',
        remoteFetch: 'Fetch card',
        remoteEmpty: 'No remote agents yet',
        cardPreview: 'Agent Card',
        curlHint: 'curl check',
        copy: 'Copy',
        copied: 'Copied',
        fetchError: 'Request failed',
        token: 'Bearer token (optional)',
        autoRefresh: 'Auto refresh',
      },
    }

    const store = {
      get remotes() {
        try {
          const raw = window.localStorage.getItem('dsh-a2a:remotes')
          return raw === null ? [] : JSON.parse(raw)
        } catch { return [] }
      },
      set remotes(value) {
        try { window.localStorage.setItem('dsh-a2a:remotes', JSON.stringify(value)) } catch { /* ignore */ }
      },
    }

    function joinUrl(base, path) {
      const trimmed = base.endsWith('/') ? base : `${base}/`
      return `${trimmed.replace(/\/$/, '')}${path}`
    }

    async function jsonFetch(url, token, init) {
      const headers = { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...((init && init.headers) || {}) }
      const response = await window.fetch(url, { ...init, headers })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    // ── 状态区 ────────────────────────────────────────────────────────

    function StatusSection({ t, base, token, onNeedRefresh }) {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState('')
      const [copied, setCopied] = useState('')
      const load = useCallback(() => jsonFetch(joinUrl(base, '/admin/status'), token).then((s) => { setStatus(s); setError('') }).catch((e) => { setStatus(null); setError(String(e.message || e)) }), [base, token])
      useEffect(() => { void load() }, [load])
      const curl = `curl ${joinUrl(base, '/.well-known/agent-card.json')}`
      const copy = (text, what) => {
        void navigator.clipboard.writeText(text).then(() => { setCopied(what); setTimeout(() => setCopied(''), 1500) }).catch(() => {})
      }
      const row = (label, value) => h('div', { key: label, style: { display: 'flex', gap: 8, fontSize: 12, lineHeight: '20px' } },
        h('span', { style: { minWidth: 64, opacity: 0.65 } }, label),
        h('span', { style: { fontWeight: 500 } }, value))
      return h('section', null,
        h('h4', { style: { margin: '14px 0 6px', fontSize: 13 } }, `${t('title')} · ${status ? t('statusRunning') : t('statusDown')}${error ? `（${t('fetchError')}: ${error.slice(0, 80)}）` : ''}`),
        status && h('div', null,
          row(t('mode'), String(status.mode)),
          row(t('protocol'), `${status.protocolVersion} · JSON-RPC ${status.publicUrl}`),
          row(t('auth'), status.auth ? t('authOn') : t('authOff')),
          row('tasks', `${status.tasks.active} active / ${status.tasks.total}`),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' } },
            h('code', { style: { fontSize: 11, padding: '4px 8px', background: 'rgba(127,127,127,.12)', borderRadius: 4, overflow: 'auto', maxWidth: '100%' } }, curl),
            h('button', { type: 'button', onClick: () => copy(curl, 'curl') }, copied === 'curl' ? t('copied') : t('copy')))),
        !status && h('div', { style: { fontSize: 12, opacity: 0.7, margin: '6px 0' } }, `${t('baseUrl')}: ${base}`))
    }

    // ── 任务板 ────────────────────────────────────────────────────────

    function TasksSection({ t, base, token }) {
      const [tasks, setTasks] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const load = useCallback(() => jsonFetch(`${joinUrl(base, '/admin/tasks')}?limit=50`, token).then((r) => { setTasks(r.tasks); setError('') }).catch((e) => { setTasks(null); setError(String(e.message || e)) }), [base, token])
      useEffect(() => {
        void load()
        const timer = window.setInterval(() => { void load() }, 5000)
        return () => window.clearInterval(timer)
      }, [load])
      const cancel = (id) => {
        setBusy(id)
        void jsonFetch(joinUrl(base, '/'), token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: `cancel-${id.slice(0, 8)}`, method: 'tasks/cancel', params: { taskId: id } }) })
          .then(() => load()).catch(() => {}).finally(() => setBusy(''))
      }
      const badgeStyle = (state) => ({
        submitted: { opacity: 0.7 }, working: { color: '#d97706' }, 'input-required': { color: '#7c3aed' },
        completed: { color: '#15803d' }, failed: { color: '#b91c1c' }, canceled: { opacity: 0.6 }, rejected: { color: '#b91c1c' },
      })[state] || {}
      return h('section', null,
        h('h4', { style: { margin: '14px 0 6px', fontSize: 13 } }, t('tasks')),
        error && h('div', { style: { fontSize: 12, color: '#b91c1c' } }, `${t('fetchError')}: ${error.slice(0, 80)}`),
        tasks && tasks.length === 0 && h('div', { style: { fontSize: 12, opacity: 0.6 } }, t('tasksEmpty')),
        tasks && tasks.length > 0 && h('table', { style: { width: '100%', fontSize: 12, borderCollapse: 'collapse' } },
          h('tbody', null, tasks.map((task) => h('tr', { key: task.id, style: { borderBottom: '1px solid rgba(127,127,127,.15)' } },
            h('td', { style: { padding: '4px 6px 4px 0' } }, h('span', { style: badgeStyle(task.state) }, t('taskState')[task.state] || task.state)),
            h('td', { style: { padding: '4px 6px', opacity: 0.75, fontFamily: 'monospace' } }, `${task.id.slice(0, 8)} · ${t('context')} ${task.contextId.slice(0, 12)}`),
            h('td', { style: { padding: '4px 6px', opacity: 0.6 } }, `${task.artifacts} ${t('artifacts')}`),
            h('td', { style: { padding: '4px 0', textAlign: 'right' } },
              !['completed', 'failed', 'canceled', 'rejected'].includes(task.state)
              && h('button', { type: 'button', disabled: busy === task.id, onClick: () => cancel(task.id) }, busy === task.id ? t('canceling') : t('cancel'))))))),
      )
    }

    // ── 远端 agent 目录 ───────────────────────────────────────────────

    function RemoteDirectory({ t, token }) {
      const [remotes, setRemotes] = useState(store.remotes)
      const [draft, setDraft] = useState('')
      const [cards, setCards] = useState({})
      const save = (next) => { store.remotes = next; setRemotes(next) }
      const fetchCard = (base) => {
        void jsonFetch(joinUrl(base, '/.well-known/agent-card.json'), token)
          .then((card) => setCards((prev) => ({ ...prev, [base]: { card } })))
          .catch((e) => setCards((prev) => ({ ...prev, [base]: { error: String(e.message || e) } })))
      }
      return h('section', null,
        h('h4', { style: { margin: '14px 0 6px', fontSize: 13 } }, t('remoteTitle')),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('input', {
            style: { flex: 1, fontSize: 12, padding: '4px 8px' },
            placeholder: 'https://a2a.example.com/ 或 http://10.0.0.5:7310/',
            value: draft,
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && draft.trim() !== '') {
                const base = draft.trim()
                if (!remotes.includes(base)) save([...remotes, base])
                setDraft('')
                fetchCard(base)
              }
            },
          }),
          h('button', {
            type: 'button',
            onClick: () => {
              if (draft.trim() === '') return
              const base = draft.trim()
              if (!remotes.includes(base)) save([...remotes, base])
              setDraft('')
              fetchCard(base)
            },
          }, t('remoteAdd'))),
        remotes.length === 0 && h('div', { style: { fontSize: 12, opacity: 0.6, marginTop: 6 } }, t('remoteEmpty')),
        h('ul', { style: { listStyle: 'none', padding: 0, margin: '8px 0 0' } }, remotes.map((base) => {
          const entry = cards[base]
          return h('li', { key: base, style: { padding: '6px 0', borderBottom: '1px solid rgba(127,127,127,.15)', fontSize: 12 } },
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h('code', { style: { fontSize: 11 } }, base),
              h('button', { type: 'button', onClick: () => fetchCard(base) }, t('remoteFetch')),
              h('button', { type: 'button', onClick: () => save(remotes.filter((r) => r !== base)) }, '×')),
            entry && entry.card && h('div', { style: { opacity: 0.8, marginTop: 4 } },
              `${entry.card.name} v${entry.card.version} · ${entry.card.protocolVersion} · ${(entry.card.skills || []).map((s) => s.name).join('、') || '（无技能）'}`),
            entry && entry.error && h('div', { style: { color: '#b91c1c', marginTop: 4 } }, `${t('fetchError')}: ${entry.error}`))
        })))
    }

    // ── 面板 ─────────────────────────────────────────────────────────

    function Panel() {
      const [lang, setLang] = useState((navigator.language || 'zh').startsWith('zh') ? 'zh' : 'en')
      const t = (key) => { const d = dict[lang] || dict.zh; return d[key] !== undefined ? d[key] : dict.zh[key] !== undefined ? dict.zh[key] : key }
      const [base, setBase] = useState(() => {
        try { return window.localStorage.getItem('dsh-a2a:base') || DEFAULT_BASE } catch { return DEFAULT_BASE }
      })
      const [token, setToken] = useState(() => {
        try { return window.sessionStorage.getItem('dsh-a2a:token') || '' } catch { return '' }
      })
      const onBase = (value) => { setBase(value); try { window.localStorage.setItem('dsh-a2a:base', value) } catch { /* ignore */ } }
      const onToken = (value) => { setToken(value); try { window.sessionStorage.setItem('dsh-a2a:token', value) } catch { /* ignore */ } }
      const [nonce, setNonce] = useState(0)
      return h('div', { style: { fontSize: 13, lineHeight: 1.5 } },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('label', { style: { fontSize: 12 } }, t('baseUrl'),
            h('input', { style: { fontSize: 12, padding: '4px 8px', marginLeft: 6, width: 240 }, value: base, onChange: (e) => onBase(e.target.value) })),
          h('label', { style: { fontSize: 12 } }, t('token'),
            h('input', { type: 'password', style: { fontSize: 12, padding: '4px 8px', marginLeft: 6, width: 140 }, value: token, onChange: (e) => onToken(e.target.value) })),
          h('button', { type: 'button', onClick: () => setNonce((n) => n + 1) }, t('refresh')),
          h('button', { type: 'button', onClick: () => setLang(lang === 'zh' ? 'en' : 'zh') }, lang === 'zh' ? 'EN' : '中')),
        h(StatusSection, { key: `s-${nonce}-${base}`, t, base, token }),
        h(TasksSection, { key: `t-${nonce}-${base}`, t, base, token }),
        h(RemoteDirectory, { t, token }))
    }

    // ── 插件入口 ─────────────────────────────────────────────────────

    const name = 'dsh-a2a-client'
    const inject = ['slots', 'locale']

    function apply(ctx) {
      // 语言跟随宿主 locale（若可用），失败静默。
      try {
        if (ctx.locale && typeof ctx.locale.getSnapshot === 'function') {
          const snap = ctx.locale.getSnapshot()
          if (snap && typeof snap.active === 'string') { /* Panel 自身也带切换，这里不强改 */ }
        }
      } catch { /* ignore */ }

      const build = () => h(Panel)

      // 座位一：Plugins → dsh-a2a bundle 页的配置卡（0.1.7+）。
      const bundleCtx = ctx
      bundleCtx.slots.inject('plugins.bundle.config', () => bundleCtx.slots.register({
        name: 'plugins.bundle.config',
        key: PACKAGE,
        locale: NS,
      }, (ownerProps) => (ownerProps && ownerProps.view === 'summary') ? null : build()))

      // 座位二：设置 Plugins 分区的独立标签页。
      const tabCtx = ctx
      tabCtx.slots.inject('settings.plugins.tab', () => tabCtx.slots.register({
        name: 'settings.plugins.tab',
        id: NS,
        order: 70,
        label: () => 'A2A',
        locale: NS,
      }, build))
    }

    return { name, inject, apply }
  },
})
