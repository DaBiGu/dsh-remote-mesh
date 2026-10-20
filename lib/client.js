/**
 * remote-workspaces — browser half.
 *
 * Adds a `remote-workspaces` entry to the sidebar and a main panel behind it.
 * The panel lists every configured machine with its live status, its
 * workspaces, and its conversations; it can open a peer's whole DSH GUI on a
 * local loopback port, embed that GUI in place, forward a remote port so a page
 * deployed over there previews in this browser, and hand a prompt to the *other*
 * machine's agent so that machine keeps working while this one watches.
 *
 * All of it talks to the host half over the authenticated
 * `/remote-workspaces` Connection channel, so the Host/Origin fence and the
 * browser-session cookie apply exactly as they do for the built-in panels.
 *
 * Built as a lazy-CJS browser bundle: the shell registers the factory and only
 * runs it on first use.
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-mesh',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    /** The Connection RPC channel the host half registered. */
    const CHANNEL = '/remote-workspaces'
    /** Sidebar entry id, and the matching main-panel key. */
    const PANEL_ID = 'remote-workspaces'
    /** CSS is injected once per document; the shell may remount panels freely. */
    const CSS_TAG = 'dsh-remote-mesh/styles'
    /** How long a failed call stays visible before the next poll clears it. */
    const POLL_FALLBACK_MS = 15000

    /** Locale namespace this panel owns. */
    const LOCALE_NS = 'remote-mesh'

    /**
     * English copy. The key is the Chinese source text, so a missing translation
     * degrades to Chinese instead of to a raw key, and `%s` marks each
     * interpolation position in both dictionaries.
     */
    const EN = {
      '这个页面是上一次 dsh web 加载的，启动令牌已经失效——刷新页面（F5）后重试即可。':
        'This page was loaded by an earlier dsh web process and its boot token has expired — refresh (F5) and try again.',
      '请求没通过 loopback / 同源检查（403）。请用 http://127.0.0.1:<端口>/ 打开这个界面。':
        'The request failed the loopback / same-origin check (403). Open this panel from http://127.0.0.1:<port>/.',
      '%s 失败：HTTP %s': '%s failed: HTTP %s',
      '%ss 前': '%ss ago',
      '%sm 前': '%sm ago',
      '%sh 前': '%sh ago',
      '%sd 前': '%sd ago',
      '用量不可见：%s': 'Usage unavailable: %s',
      '用量不可见': 'Usage unavailable',
      '今日 %s': 'Today %s',
      '输入 %s': 'in %s',
      '输出 %s': 'out %s',
      '缓存 %s': 'cache %s',
      '%s 次调用': '%s calls',
      '累计 %s（%s 天）': 'lifetime %s (%s days)',
      '余额 %s': 'balance %s',
      '还没有可打开的地址': 'No address to open yet',
      '浏览器拦截了新标签页，地址是 %s%s': 'The browser blocked the new tab. The address is %s%s',
      '已连接': 'Connected',
      '连接中': 'Connecting',
      '未连接': 'Offline',
      '运行中': 'running',
      '收起内容': 'Hide',
      '读对话': 'Read',
      '收起': 'Hide',
      '让远端继续': 'Continue remotely',
      '正在通过 Mesh 读取远端对话…': 'Reading the remote conversation over the mesh…',
      '这个对话里还没有可显示的消息。': 'This conversation has no messages to show yet.',
      '你': 'You',
      '远端': 'Remote',
      '交给 %s 上的这个对话继续做，写完按发送': 'Hand this to the conversation on %s; write your message and send.',
      '已发送…': 'Sent…',
      '发送到远端 agent': 'Send to the remote agent',
      '远端 agent 会在它那台机器上执行工具，结果写进这个对话。':
        'The remote agent runs tools on its own machine and writes the result into this conversation.',
      '远端没有报告自己的 GUI 端口，稍后再试': 'The remote side did not report its GUI port; try again shortly',
      '直连 %s:%s': 'direct %s:%s',
      '经公网中继': 'over the relay',
      '%s 个对话运行中': '%s conversations running',
      '打开远程 GUI': 'Open remote GUI',
      '在此处打开': 'Open here',
      '刷新': 'Refresh',
      '逐段探测：中继 / 链路 / 远端 API / 远端 dsh web 端口 / 本机代理 / 端口转发':
        'Probes every hop: relay / link / remote API / remote dsh web port / local proxy / port forward',
      '探测中…': 'Probing…',
      '诊断': 'Diagnose',
      '收起诊断': 'Hide diagnosis',
      '断开并移除 %s？': 'Disconnect and remove %s?',
      '确认移除': 'Remove anyway',
      '取消': 'Cancel',
      '移除': 'Remove',
      '诊断（%s）': 'Diagnosis (%s)',
      '从上往下看第一个 ✘ 就是断在哪一段：中继 → 链路 → 远端 API → 远端 dsh web 端口 → 本机代理 → 转发。':
        'The first ✘ from the top is where it breaks: relay → link → remote API → remote dsh web port → local proxy → forward.',
      '连接失败：%s': 'Connection failed: %s',
      '读取远端清单失败：%s': 'Could not read the remote snapshot: %s',
      '%s · %s · DSH 端口 %s': '%s · %s · DSH port %s',
      '清单': 'Snapshot',
      '%s 个对话 · %s 个工作区 · %s更新': '%s conversations · %s workspaces · updated %s',
      '用量': 'Usage',
      '由对方机器自己统计并随清单一起同步过来的消费与 token 用量':
        'Spend and token usage counted by the other machine and synced with its snapshot',
      '对方没有上报用量': 'The other machine reports no usage',
      '本机代理': 'Local proxy',
      '点击「打开远程 GUI」后分配': 'Assigned when you open the remote GUI',
      '还没有读到远端清单。': 'No remote snapshot yet.',
      '工作区 (%s)': 'Workspaces (%s)',
      '远端没有登记工作区。': 'The remote side has no workspaces.',
      '%s 对话': '%s conversations',
      '在这个工作区里开一个新对话并交给远端 agent':
        'Start a new conversation in this workspace and hand it to the remote agent',
      '派活': 'Assign',
      '对话 (%s%s)': 'Conversations (%s%s)',
      '远端还没有对话。': 'The remote side has no conversations yet.',
      '交给远端 agent 一件新活': 'Hand a new task to the remote agent',
      '交给远端 agent 一件新活 · %s': 'New task for the remote agent · %s',
      '例如：把 src/index.html 的首页改好，然后在 5173 端口起一个静态服务器':
        'e.g. rewrite the home page in src/index.html, then serve it statically on port 5173',
      '发送': 'Send',
      '远端会在这个工作区里新开一个对话执行，完成后在左侧「对话」里能看到。':
        'The remote side runs it in a new conversation inside this workspace; you will see it under “Conversations”.',
      '端口转发（在本机浏览器调试远端页面）': 'Port forwards (debug a remote page in this browser)',
      '远端没有声明可转发端口。': 'The remote side declares no forwardable ports.',
      '远端端口': 'Remote port',
      '映射到本机': 'Map to local',
      '本机端口自动分配，映射完成后在下方列表里点「打开」。':
        'The local port is assigned automatically; once mapped, click “Open” in the list below.',
      '%s · 远端 %s → 本机 %s': '%s · remote %s → local %s',
      '打开': 'Open',
      '删除': 'Delete',
      '本机 %s · %s': 'Local %s · %s',
      '中继 %s': 'Relay %s',
      '全部刷新': 'Refresh all',
      '添加电脑': 'Add computer',
      '收起设置': 'Hide settings',
      '设置': 'Settings',
      '正在读取 remote-workspaces 状态…': 'Reading remote-workspaces state…',
      '本机节点 %s，直连监听 %s:%s，GUI 端口 %s。配置文件 %s':
        'This node %s, direct listener %s:%s, GUI port %s. Config file %s',
      '本机用量：%s': 'Local usage: %s',
      '新标签页打开': 'Open in new tab',
      '关闭内嵌': 'Close embedded view',
      '本机设置': 'This machine',
      '本机名称': 'Machine name',
      '直连监听地址': 'Direct listen address',
      '直连监听端口': 'Direct listen port',
      '公网中继 WebSocket 地址': 'Public relay WebSocket URL',
      '中继密钥（留空保持）': 'Relay secret (leave blank to keep)',
      '自签证书的 CA 文件路径（可选）': 'CA file path for a self-signed certificate (optional)',
      '不校验证书（自签时用，会打印警告）': 'Skip certificate verification (self-signed setups; logs a warning)',
      '保存并重连': 'Save and reconnect',
      '改成局域网直连时把监听地址设为 0.0.0.0，并确保防火墙只放行你的内网。':
        'For LAN-direct mode set the listen address to 0.0.0.0 and keep the firewall limited to your own network.',
      '方式一：粘贴另一台机器生成的配对码（推荐）':
        'Option 1: paste a pairing code generated on the other machine (recommended)',
      '在另一台机器上点「生成配对码」，把那一串粘到这里':
        'On the other machine click “Generate pairing code” and paste the string here',
      '配对完成：两边都已互相加入，可以直接用了。':
        'Pairing complete: both sides joined each other and it is ready to use.',
      '本机已加入，但没能回头通知对方（%s）。请在对方机器上也生成一次配对码并在这里粘贴，让两边互相可见。':
        'This machine joined, but could not notify the other side back (%s). Generate a pairing code on the other machine too and paste it here so both sides see each other.',
      '接收并加入': 'Accept and join',
      '这台机器没有返回配对码。': 'This machine returned no pairing code.',
      '生成配对码': 'Generate pairing code',
      '配对码含集群密钥与中继配置，等于把这两台机器放进同一个私有网络，不要外发。':
        'A pairing code carries the cluster key and relay settings — it puts both machines in one private network. Do not share it.',
      '复制配对码': 'Copy pairing code',
      '方式二：手动填写': 'Option 2: fill it in by hand',
      '远端节点 id': 'Remote node id',
      '显示名': 'Display name',
      '台式机': 'Desktop PC',
      '通道': 'Transport',
      '公网中继': 'Relay',
      '局域网直连': 'LAN direct',
      '地址': 'Address',
      '端口': 'Port',
      '添加': 'Add',
      '还没有配置其它电脑。点「添加电脑」，在另一台机器上装好本插件后用配对码加入即可。':
        'No other computers configured yet. Click “Add computer”, install this plugin on the other machine, and join with a pairing code.',
      '端口转发': 'Port forwards',
      '端口转发（本机 → 这台机器）': 'Port forwards (local → this machine)',
      'remote-workspaces 日志': 'remote-workspaces log',
      'remote-workspaces': 'Remote workspaces',
      'remote-workspaces: %s': 'Remote workspaces: %s',
    }

    /** Chinese copy: the key set itself, so every lookup resolves. */
    const ZH = Object.fromEntries(Object.keys(EN).map((key) => [key, key]))

    /** Replaced by the bound translate seat once the locale service is injected. */
    let translate = (key) => key

    /**
     * Translate one piece of UI copy through the active locale.
     *
     * Accepts a plain string or a tagged template. For a template the static
     * parts are joined with `%s`, that becomes the dictionary key, and the
     * translated `%s` slots are then refilled in order — so a translation may
     * reorder the sentence without knowing anything about the arguments.
     * @param {string|TemplateStringsArray} strings - Literal or template parts.
     * @param {...any} values - Interpolated values, in order.
     * @returns {string} The copy in the active locale.
     */
    function tr(strings, ...values) {
      const key = typeof strings === 'string' ? strings : strings.join('%s')
      const template = translate(key)
      if (values.length === 0) return template
      let index = 0
      return template.replace(/%s/g, () => String(values[index++]))
    }

    const CSS = `
.rm-root{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px}
.rm-scroll{overflow:auto;padding:20px 24px 40px;display:flex;flex-direction:column;gap:16px;min-height:0}
.rm-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.rm-title{font-size:16px;font-weight:600;margin:0}
.rm-sub{color:var(--dsw-alias-label-secondary);font-size:12px}
.rm-spacer{flex:1}
.rm-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);border-radius:999px;padding:2px 10px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.rm-chip-ok{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.rm-chip-bad{color:var(--dsw-alias-state-error-primary,#b42318)}
.rm-btn{appearance:none;font:inherit;font-size:12px;line-height:1.5;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:4px 12px}
.rm-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.rm-btn:disabled{opacity:.45;cursor:default}
.rm-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:transparent}
.rm-btn-danger{color:var(--dsw-alias-state-error-primary,#b42318);border-color:var(--dsw-alias-state-error-primary,#b42318)}
.rm-ok{color:#22a06b;flex:none;width:14px}
.rm-bad{color:var(--dsw-alias-state-error-primary,#b42318);flex:none;width:14px}
.rm-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;overflow:hidden}
.rm-card-head{display:flex;align-items:center;gap:10px;padding:12px 16px;flex-wrap:wrap}
.rm-card-body{border-top:1px solid var(--dsw-alias-border-l2);padding:12px 16px;display:flex;flex-direction:column;gap:14px}
.rm-name{font-weight:600;font-size:14px}
.rm-dot{width:8px;height:8px;border-radius:50%;flex:none}
.rm-dot-online{background:#22a06b}
.rm-dot-connecting{background:#d9a400}
.rm-dot-offline{background:#9aa0a6}
.rm-dot-idle{background:#c4c7cb}
.rm-section{display:flex;flex-direction:column;gap:6px}
.rm-section-title{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary);font-weight:600}
.rm-row{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;min-width:0}
.rm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rm-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.rm-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rm-row-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rm-badge{font-size:10px;border-radius:999px;padding:1px 7px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);flex:none}
.rm-badge-run{color:#22a06b;border:1px solid #22a06b55}
.rm-list{max-height:220px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px}
.rm-msgs{max-height:300px;overflow:auto;display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px;margin:4px 8px 10px}
.rm-msg{display:flex;gap:8px;padding:6px 8px;border-radius:8px}
.rm-msg-user{background:var(--dsw-alias-bg-module-platform)}
.rm-msg-role{font-size:10px;color:var(--dsw-alias-label-tertiary);flex:none;width:36px;padding-top:2px;text-transform:uppercase;letter-spacing:.04em}
.rm-msg-text{white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.6;min-width:0}
.rm-msg-time{font-size:10px;color:var(--dsw-alias-label-tertiary);flex:none;padding-top:2px}
.rm-input,.rm-textarea,.rm-select{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 10px;min-width:0}
.rm-textarea{min-height:64px;resize:vertical;width:100%;box-sizing:border-box}
.rm-input:focus,.rm-textarea:focus,.rm-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.rm-form{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
.rm-field{display:flex;flex-direction:column;gap:4px}
.rm-field-label{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.rm-error{color:var(--dsw-alias-state-error-primary,#b42318);font-size:12px}
.rm-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.rm-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;word-break:break-all;max-height:120px;overflow:auto}
.rm-frame-wrap{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-3)}
.rm-frame-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.rm-frame{width:100%;height:min(70vh,720px);border:0;background:#fff}
.rm-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:6px 2px}
.rm-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.rm-kv b{font-weight:500;color:var(--dsw-alias-label-tertiary)}
.rm-log{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;white-space:pre-wrap;max-height:200px;overflow:auto;color:var(--dsw-alias-label-secondary)}
.rm-toggle{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;user-select:none}
`

    /**
     * Inject the panel stylesheet once.
     * @returns {void}
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-remote-mesh'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * Call one host method, unwrapping the RemoteResult envelope.
     *
     * The request is posted directly rather than through
     * `ctx.connection.rpc.call` because the host half may be serving this
     * channel off the raw webserver, where the per-process boot token — read
     * from the index injection — is what authorises the call. Both carriers
     * accept the identical envelope, so one code path covers both.
     * @param {any} ctx - Client context.
     * @param {string} endpoint - Method name.
     * @param {Record<string, unknown>} [payload] - Method payload.
     * @returns {Promise<any>} the resolved value.
     */
    async function call(ctx, endpoint, payload) {
      const boot = (typeof globalThis !== 'undefined' && globalThis.__DSH_REMOTE_MESH__) || {}
      const rpcId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      const response = await fetch(`${CHANNEL}/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-remote-mesh-token': boot.token || '' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: payload ?? {} }),
      })
      if (response.status === 401) {
        // The page's injected boot token belongs to the process that served it.
        // After a `dsh web` restart an old tab keeps sending the dead token, and
        // "401" on its own tells the operator nothing.
        throw new Error(tr('这个页面是上一次 dsh web 加载的，启动令牌已经失效——刷新页面（F5）后重试即可。'))
      }
      if (response.status === 403) {
        throw new Error(tr('请求没通过 loopback / 同源检查（403）。请用 http://127.0.0.1:<端口>/ 打开这个界面。'))
      }
      if (!response.ok) throw new Error(tr`${endpoint} 失败：HTTP ${response.status}`)
      const envelope = await response.json()
      const result = envelope && envelope.result
      if (result !== null && typeof result === 'object' && result.ok === true) return result.value
      const error = (result !== null && typeof result === 'object' && result.error) || {}
      throw new Error(error.message || `remote-workspaces ${endpoint} failed`)
    }

    /**
     * @param {number|undefined} timestamp - Unix epoch milliseconds.
     * @returns {string} a short relative description.
     */
    function ago(timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return ''
      const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
      if (seconds < 60) return tr`${seconds}s 前`
      if (seconds < 3600) return tr`${Math.round(seconds / 60)}m 前`
      if (seconds < 86400) return tr`${Math.round(seconds / 3600)}h 前`
      return tr`${Math.round(seconds / 86400)}d 前`
    }

    /**
     * Format a money amount: symbols for the currencies the usage plugin
     * reports, the bare code plus amount for anything else.
     * @param {string} currency - ISO currency code from the usage summary.
     * @param {number} amount - Amount in that currency.
     * @returns {string} the formatted figure, or '' when there is none.
     */
    function money(currency, amount) {
      if (typeof amount !== 'number' || !Number.isFinite(amount)) return ''
      const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : ''
      const text = amount >= 1000 ? amount.toFixed(2) : amount.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
      return symbol === '' ? `${currency} ${text}` : `${symbol}${text}`
    }

    /**
     * Compact a token count: one row has room for a few characters, and exact
     * digits stop being readable long before they stop being long.
     * @param {number} count - Token count.
     * @returns {string} `1.23M`-style text.
     */
    function tokenText(count) {
      if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return '0'
      if (count >= 1e9) return `${(count / 1e9).toFixed(2)}B`
      if (count >= 1e6) return `${(count / 1e6).toFixed(2)}M`
      if (count >= 1e3) return `${(count / 1e3).toFixed(1)}k`
      return String(count)
    }

    /**
     * Describe a usage summary in one line: today's spend and its token mix, the
     * day's call count, the retained total, and the provider balance.
     * @param {Record<string, any>} usage - The `usage` block of a snapshot.
     * @returns {string} the description, or a reason when usage is unavailable.
     */
    function usageDetail(usage) {
      if (usage === null || usage === undefined) return ''
      if (usage.available !== true) return usage.reason ? tr`用量不可见：${usage.reason}` : tr('用量不可见')
      const today = usage.today || {}
      const total = usage.total || {}
      const currency = usage.currency || 'CNY'
      const parts = [tr`今日 ${money(currency, today.cost) || money(currency, 0)}`]
      if (today.totalTokens > 0) {
        const tokens = [tr`输入 ${tokenText(today.inputTokens)}`, tr`输出 ${tokenText(today.outputTokens)}`]
        if (today.cacheReadTokens > 0) tokens.push(tr`缓存 ${tokenText(today.cacheReadTokens)}`)
        parts.push(tokens.join(' / '))
      }
      if (today.calls > 0) parts.push(tr`${today.calls} 次调用`)
      if (total.cost > 0) parts.push(tr`累计 ${money(currency, total.cost)}（${total.days || 0} 天）`)
      if (usage.balance) parts.push(tr`余额 ${money(usage.balance.currency || currency, usage.balance.amount)}`)
      return parts.join(' · ')
    }

    /**
     * @param {string} value - Text to place on the clipboard.
     * @returns {Promise<boolean>} whether the copy succeeded.
     */
    async function copyText(value) {
      try {
        await navigator.clipboard.writeText(value)
        return true
      } catch {
        return false
      }
    }

    /**
     * Open a URL in a new tab, keeping the popup tied to the click.
     * @param {string} url - Address to open.
     * @returns {boolean} whether a tab was obtained.
     */
    function openTab(url) {
      const win = window.open('about:blank', '_blank')
      if (win === null || win === undefined) return false
      try {
        win.opener = null
      } catch {
        /* cross-origin about:blank is same-origin, but never assume */
      }
      win.location.replace(url)
      return true
    }

    /**
     * Open a tab, and when the browser refuses, tell the user where the page
     * lives instead of doing nothing at all.
     *
     * A blocked popup turns "打开" into a silent no-op, which reads as "the
     * button is broken". Copying the address and saying so costs nothing and
     * leaves the link one paste away.
     * @param {string} url - Address to open.
     * @returns {Promise<string|null>} the explanation, or null when a tab opened.
     */
    async function openTabOrExplain(url) {
      if (url === undefined || url === null || url === '') return tr('还没有可打开的地址')
      if (openTab(url)) return null
      const copied = await copyText(url)
      return tr`浏览器拦截了新标签页，地址是 ${url}${copied ? '（已复制）' : ''}`
    }

    /**
     * @param {string} status - Peer status.
     * @returns {string} the dot modifier class.
     */
    function dotClass(status) {
      if (status === 'online') return 'rm-dot rm-dot-online'
      if (status === 'connecting') return 'rm-dot rm-dot-connecting'
      if (status === 'idle') return 'rm-dot rm-dot-idle'
      return 'rm-dot rm-dot-offline'
    }

    /**
     * @param {string} status - Peer status.
     * @returns {string} a human label.
     */
    function statusLabel(status) {
      if (status === 'online') return tr('已连接')
      if (status === 'connecting') return tr('连接中')
      if (status === 'offline') return tr('未连接')
      return status
    }

    /** A globe glyph for the sidebar entry. */
    function GlobeIcon(props) {
      const size = props && props.size ? props.size : 18
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('path', { d: 'M3 12h18M12 3c2.6 3 2.6 15 0 18M12 3c-2.6 3-2.6 15 0 18' }),
      )
    }

    /** A monitor glyph for a per-machine sidebar entry. */
    function MachineIcon(props) {
      const size = props && props.size ? props.size : 18
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' },
        h('rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }),
        h('path', { d: 'M8 20h8M12 16v4' }),
      )
    }

    /**
     * One remote conversation row with its continue-with-the-remote-agent box.
     * @param {{ctx: any, peer: any, session: any, onChanged: () => void}} props - Row inputs.
     * @returns {import('react').ReactElement} the row.
     */
    function ConversationRow({ ctx, peer, session, onChanged }) {
      const [open, setOpen] = useState(false)
      const [reading, setReading] = useState(false)
      const [messages, setMessages] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const [text, setText] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      // Read the remote conversation's actual messages over the mesh, so the
      // panel is useful without opening a second GUI window.
      const toggleMessages = useCallback(async () => {
        if (reading) {
          setReading(false)
          return
        }
        setReading(true)
        if (messages !== null) return
        try {
          const answer = await call(ctx, 'conversation', { peerId: peer.id, sessionId: session.id, limit: 40 })
          setMessages(Array.isArray(answer.messages) ? answer.messages : [])
          setLoadError(null)
        } catch (failure) {
          setLoadError(String(failure && failure.message ? failure.message : failure))
        }
      }, [reading, messages, ctx, peer.id, session.id])

      const send = useCallback(async () => {
        if (text.trim() === '') return
        setBusy(true)
        setError(null)
        try {
          await call(ctx, 'agent.prompt', { peerId: peer.id, sessionId: session.id, text, mode: 'queue' })
          setText('')
          setOpen(false)
          setMessages(null)
          onChanged()
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        } finally {
          setBusy(false)
        }
      }, [ctx, peer.id, session.id, text, onChanged])

      const title = session.title && session.title !== '' ? session.title : session.id
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'rm-row' },
          h(
            'div',
            { className: 'rm-row-main' },
            h('div', { className: 'rm-row-title', title }, title),
            h('div', { className: 'rm-row-meta' }, [session.cwd || '', ago(session.updatedAt)].filter(Boolean).join(' · ')),
          ),
          session.running === true ? h('span', { className: 'rm-badge rm-badge-run' }, tr('运行中')) : null,
          h('button', { className: 'rm-btn', onClick: toggleMessages }, reading ? tr('收起内容') : tr('读对话')),
          h('button', { className: 'rm-btn', onClick: () => setOpen(!open) }, open ? tr('收起') : tr('让远端继续')),
        ),
        reading
          ? h(
              'div',
              { className: 'rm-msgs' },
              loadError !== null ? h('div', { className: 'rm-error' }, loadError) : null,
              loadError === null && messages === null ? h('div', { className: 'rm-empty' }, tr('正在通过 Mesh 读取远端对话…')) : null,
              loadError === null && messages !== null && messages.length === 0
                ? h('div', { className: 'rm-empty' }, tr('这个对话里还没有可显示的消息。'))
                : null,
              (messages || []).map((message, index) =>
                h(
                  'div',
                  { className: message.role === 'user' ? 'rm-msg rm-msg-user' : 'rm-msg', key: `${index}-${message.time ?? ''}` },
                  h('span', { className: 'rm-msg-role' }, message.role === 'user' ? tr('你') : tr('远端')),
                  h('span', { className: 'rm-msg-text' }, message.text),
                  h('span', { className: 'rm-msg-time' }, ago(message.time)),
                ),
              ),
            )
          : null,
        open
          ? h(
              'div',
              { style: { padding: '4px 8px 10px' } },
              h('textarea', {
                className: 'rm-textarea',
                placeholder: tr`交给 ${peer.displayName || peer.id} 上的这个对话继续做，写完按发送`,
                value: text,
                onChange: (event) => setText(event.target.value),
              }),
              h(
                'div',
                { className: 'rm-form', style: { marginTop: 6 } },
                h('button', { className: 'rm-btn rm-btn-primary', disabled: busy || text.trim() === '', onClick: send }, busy ? tr('已发送…') : tr('发送到远端 agent')),
                h('span', { className: 'rm-note' }, tr('远端 agent 会在它那台机器上执行工具，结果写进这个对话。')),
              ),
              error === null ? null : h('div', { className: 'rm-error', style: { marginTop: 6 } }, error),
            )
          : null,
      )
    }

    /**
     * One machine's card: status, actions, workspaces, conversations and the
     * remote-agent prompt box.
     * @param {{ctx: any, peer: any, onChanged: () => void, onEmbed: (frame: any) => void}} props - Card inputs.
     * @returns {import('react').ReactElement} the card.
     */
    function PeerCard({ ctx, peer, onChanged, onEmbed }) {
      const [busy, setBusy] = useState(null)
      const [error, setError] = useState(null)
      const [forwardPort, setForwardPort] = useState('')
      const [newTask, setNewTask] = useState('')
      const [newTaskWorkspace, setNewTaskWorkspace] = useState(undefined)
      const [showNew, setShowNew] = useState(false)
      const [confirmRemove, setConfirmRemove] = useState(false)
      const [diagnosis, setDiagnosis] = useState(null)
      const [diagnosing, setDiagnosing] = useState(false)

      // The peer's own usage, exactly as its snapshot reported it. A peer without
      // the usage plugin answers `available: false` and the rows degrade to one
      // explanatory line instead of a row of zeros.
      const peerUsage = peer.usage
      const usageText = usageDetail(peerUsage)

      const run = useCallback(
        async (label, work) => {
          setBusy(label)
          setError(null)
          try {
            await work()
            onChanged()
          } catch (failure) {
            setError(String(failure && failure.message ? failure.message : failure))
          } finally {
            setBusy(null)
          }
        },
        [onChanged],
      )

      const openRemote = useCallback(
        (embed) =>
          run(embed ? 'embed' : 'open', async () => {
            const address = await call(ctx, 'open.peer', { peerId: peer.id })
            const url = address.tokenUrl || address.url
            if (embed) {
              onEmbed({ peerId: peer.id, name: peer.displayName || peer.id, url, cleanUrl: address.url, port: address.port })
              return
            }
            if (url === undefined || url === null) throw new Error(tr('远端没有报告自己的 GUI 端口，稍后再试'))
            const blocked = await openTabOrExplain(url)
            if (blocked !== null) throw new Error(blocked)
          }),
        [ctx, peer.id, peer.displayName, run, onEmbed],
      )

      const forwards = (peer.snapshot && peer.snapshot.forwards) || []
      const workspaces = peer.workspaces || []
      const sessions = peer.sessions || []
      const active = busy !== null

      return h(
        'div',
        { className: 'rm-card' },
        h(
          'div',
          { className: 'rm-card-head' },
          h('span', { className: dotClass(peer.status) }),
          h('span', { className: 'rm-name' }, peer.displayName || peer.id),
          h('span', { className: 'rm-sub' }, peer.id),
          h('span', { className: 'rm-chip' }, peer.transport === 'direct' ? tr`直连 ${peer.host || ''}:${peer.port || ''}` : tr('经公网中继')),
          h('span', { className: 'rm-chip' + (peer.status === 'online' ? ' rm-chip-ok' : ' rm-chip-bad') }, statusLabel(peer.status)),
          peer.runningCount > 0 ? h('span', { className: 'rm-badge rm-badge-run' }, tr`${peer.runningCount} 个对话运行中`) : null,
          h('span', { className: 'rm-spacer' }),
          h('button', { className: 'rm-btn rm-btn-primary', disabled: active, onClick: () => openRemote(false) }, tr('打开远程 GUI')),
          h('button', { className: 'rm-btn', disabled: active, onClick: () => openRemote(true) }, tr('在此处打开')),
          h('button', { className: 'rm-btn', disabled: active, onClick: () => run('refresh', () => call(ctx, 'refresh', { peerId: peer.id })) }, tr('刷新')),
          h(
            'button',
            {
              className: 'rm-btn',
              disabled: active,
              title: tr('逐段探测：中继 / 链路 / 远端 API / 远端 dsh web 端口 / 本机代理 / 端口转发'),
              onClick: async () => {
                if (diagnosis !== null) {
                  setDiagnosis(null)
                  return
                }
                setDiagnosing(true)
                try {
                  const report = await call(ctx, 'diagnose', { peerId: peer.id })
                  setDiagnosis(report)
                  setError(null)
                } catch (failure) {
                  setError(String(failure && failure.message ? failure.message : failure))
                } finally {
                  setDiagnosing(false)
                }
              },
            },
            diagnosing ? tr('探测中…') : diagnosis === null ? tr('诊断') : tr('收起诊断'),
          ),
          // Two-step inline confirm instead of window.confirm: a native dialog
          // blocks a non-interactive client outright (and is suppressed in some
          // embedded browsers), which turns a guard into a dead button.
          confirmRemove
            ? h(
                'span',
                { className: 'rm-form' },
                h('span', { className: 'rm-note' }, tr`断开并移除 ${peer.displayName || peer.id}？`),
                h('button', { className: 'rm-btn rm-btn-danger', disabled: active, onClick: () => run('remove', () => call(ctx, 'peer.remove', { id: peer.id })) }, tr('确认移除')),
                h('button', { className: 'rm-btn', onClick: () => setConfirmRemove(false) }, tr('取消')),
              )
            : h('button', { className: 'rm-btn', disabled: active, onClick: () => setConfirmRemove(true) }, tr('移除')),
        ),
        h(
          'div',
          { className: 'rm-card-body' },
          error === null ? null : h('div', { className: 'rm-error' }, error),
          diagnosis === null
            ? null
            : h(
                'div',
                { className: 'rm-section' },
                h('div', { className: 'rm-section-title' }, tr`诊断（${new Date(diagnosis.at).toLocaleTimeString()}）`),
                h(
                  'div',
                  { className: 'rm-list' },
                  (diagnosis.checks || []).map((step, index) =>
                    h(
                      'div',
                      { className: 'rm-row', key: `${index}-${step.name}` },
                      h('span', { className: step.ok === true ? 'rm-ok' : 'rm-bad' }, step.ok === true ? '✔' : '✘'),
                      h(
                        'div',
                        { className: 'rm-row-main' },
                        h('div', { className: 'rm-row-title' }, step.name),
                        h('div', { className: 'rm-row-meta', title: String(step.detail ?? '') }, String(step.detail ?? '')),
                      ),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'rm-note' },
                  tr('从上往下看第一个 ✘ 就是断在哪一段：中继 → 链路 → 远端 API → 远端 dsh web 端口 → 本机代理 → 转发。'),
                ),
              ),
          peer.status === 'offline' && peer.error ? h('div', { className: 'rm-error' }, tr`连接失败：${peer.error}`) : null,
          peer.snapshotError ? h('div', { className: 'rm-error' }, tr`读取远端清单失败：${peer.snapshotError}`) : null,
          peer.snapshotAt
            ? h(
                'div',
                { className: 'rm-kv' },
                h('b', null, tr('远端')),
                h('span', null, tr`${(peer.machine && peer.machine.hostname) || '?'} · ${(peer.machine && peer.machine.platform) || '?'} · DSH 端口 ${peer.webPort || '?'}`),
                h('b', null, tr('清单')),
                h('span', null, tr`${peer.sessionCount || 0} 个对话 · ${workspaces.length} 个工作区 · ${ago(peer.snapshotAt)}更新`),
                h('b', null, tr('用量')),
                h('span', { title: tr('由对方机器自己统计并随清单一起同步过来的消费与 token 用量') }, usageText || tr('对方没有上报用量')),
                h('b', null, tr('本机代理')),
                h('span', null, peer.proxyPort ? `http://127.0.0.1:${peer.proxyPort}/` : tr('点击「打开远程 GUI」后分配')),
              )
            : h('div', { className: 'rm-empty' }, tr('还没有读到远端清单。')),

          h(
            'div',
            { className: 'rm-section' },
            h('div', { className: 'rm-section-title' }, tr`工作区 (${workspaces.length})`),
            workspaces.length === 0
              ? h('div', { className: 'rm-empty' }, tr('远端没有登记工作区。'))
              : h(
                  'div',
                  null,
                  workspaces.slice(0, 12).map((workspace) =>
                    h(
                      'div',
                      { className: 'rm-row', key: workspace.id },
                      h('div', { className: 'rm-row-main' }, h('div', { className: 'rm-row-title' }, workspace.title || workspace.path), h('div', { className: 'rm-row-meta', title: workspace.path }, workspace.path)),
                      h('span', { className: 'rm-badge' }, tr`${(workspace.sessionIds || []).length} 对话`),
                      h(
                        'button',
                        {
                          className: 'rm-btn',
                          disabled: active,
                          title: tr('在这个工作区里开一个新对话并交给远端 agent'),
                          onClick: () => {
                            setNewTaskWorkspace({ id: workspace.id, title: workspace.title || workspace.path })
                            setNewTask('')
                            setShowNew(true)
                          },
                        },
                        tr('派活'),
                      ),
                    ),
                  ),
                ),
          ),

          h(
            'div',
            { className: 'rm-section' },
            h('div', { className: 'rm-section-title' }, tr`对话 (${sessions.length}${peer.sessionCount > sessions.length ? ` / ${peer.sessionCount}` : ''})`),
            sessions.length === 0
              ? h('div', { className: 'rm-empty' }, tr('远端还没有对话。'))
              : h(
                  'div',
                  { className: 'rm-list' },
                  sessions.slice(0, 40).map((session) => h(ConversationRow, { key: session.id, ctx, peer, session, onChanged })),
                ),
          ),

          showNew
            ? h(
                'div',
                { className: 'rm-section' },
                h(
                  'div',
                  { className: 'rm-section-title' },
                  newTaskWorkspace === undefined
                    ? tr('交给远端 agent 一件新活')
                    : tr`交给远端 agent 一件新活 · ${newTaskWorkspace.title || newTaskWorkspace.id}`,
                ),
                h('textarea', {
                  className: 'rm-textarea',
                  placeholder: tr('例如：把 src/index.html 的首页改好，然后在 5173 端口起一个静态服务器'),
                  value: newTask,
                  onChange: (event) => setNewTask(event.target.value),
                }),
                h(
                  'div',
                  { className: 'rm-form' },
                  h(
                    'button',
                    {
                      className: 'rm-btn rm-btn-primary',
                      disabled: active || newTask.trim() === '',
                      onClick: () =>
                        run('prompt', async () => {
                          const answer = await call(ctx, 'agent.prompt', {
                            peerId: peer.id,
                            text: newTask,
                            mode: 'queue',
                            ...(newTaskWorkspace === undefined ? {} : { workspaceId: newTaskWorkspace.id }),
                          })
                          setNewTask('')
                          setShowNew(false)
                          setNewTaskWorkspace(undefined)
                          return answer
                        }),
                    },
                    busy === 'prompt' ? tr('已发送…') : tr('发送'),
                  ),
                  h('button', { className: 'rm-btn', onClick: () => { setShowNew(false); setNewTaskWorkspace(undefined) } }, tr('取消')),
                  h('span', { className: 'rm-note' }, tr('远端会在这个工作区里新开一个对话执行，完成后在左侧「对话」里能看到。')),
                ),
              )
            : null,

          h(
            'div',
            { className: 'rm-section' },
            h('div', { className: 'rm-section-title' }, tr('端口转发（在本机浏览器调试远端页面）')),
            forwards.length === 0 ? h('div', { className: 'rm-empty' }, tr('远端没有声明可转发端口。')) : null,
            h(
              'div',
              { className: 'rm-form' },
              h('div', { className: 'rm-field' }, h('span', { className: 'rm-field-label' }, tr('远端端口')), h('input', { className: 'rm-input', style: { width: 90 }, placeholder: '5173', value: forwardPort, onChange: (event) => setForwardPort(event.target.value.replace(/[^0-9]/g, '')) })),
              h(
                'button',
                {
                  className: 'rm-btn',
                  disabled: active || forwardPort === '',
                  onClick: () =>
                    run('forward', async () => {
                      await call(ctx, 'forward.add', { peerId: peer.id, remotePort: Number(forwardPort), label: '' })
                      setForwardPort('')
                    }),
                },
                tr('映射到本机'),
              ),
              h('span', { className: 'rm-note' }, tr('本机端口自动分配，映射完成后在下方列表里点「打开」。')),
            ),
          ),
        ),
      )
    }

    /**
     * A standalone port-forward row, listed outside the peer cards so a mapped
     * page stays one click away.
     * @param {{ctx: any, forward: any, onChanged: () => void}} props - Row inputs.
     * @returns {import('react').ReactElement} the row.
     */
    function ForwardRow({ ctx, forward, onChanged }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'rm-row' },
          h(
            'div',
            { className: 'rm-row-main' },
            h('div', { className: 'rm-row-title' }, tr`${forward.peerName} · 远端 ${forward.remotePort} → 本机 ${forward.localPort ?? '未启动'}`),
            h('div', { className: 'rm-row-meta' }, forward.url || ''),
          ),
          h(
            'button',
            {
              className: 'rm-btn',
              disabled: busy || !forward.url,
              onClick: async () => {
                setError(await openTabOrExplain(forward.url))
              },
            },
            tr('打开'),
          ),
          h(
            'button',
            {
              className: 'rm-btn',
              disabled: busy,
              onClick: async () => {
                setBusy(true)
                try {
                  await call(ctx, 'forward.remove', { id: forward.id })
                  onChanged()
                } finally {
                  setBusy(false)
                }
              },
            },
            tr('删除'),
          ),
        ),
        error === null ? null : h('div', { className: 'rm-error' }, error),
      )
    }

    /**
     * The `remote-workspaces` panel. With `onlyPeer` set it renders just that
     * machine, which is what the per-machine sidebar entries point at.
     * @param {{ctx: any, onlyPeer?: string}} props - Panel inputs.
     * @returns {import('react').ReactElement} the panel.
     */
    function WorkspacesPanel({ ctx, onlyPeer }) {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [frame, setFrame] = useState(null)
      const [showAdd, setShowAdd] = useState(false)
      const [pairCode, setPairCode] = useState('')
      const [pairNote, setPairNote] = useState('')
      const [pasteCode, setPasteCode] = useState('')
      const [newPeer, setNewPeer] = useState({ id: '', name: '', transport: 'relay', host: '127.0.0.1', port: '' })
      const [settings, setSettings] = useState({ machineName: '', relayUrl: '', relaySecret: '', relayCa: '', relayAllowSelfSigned: false, listenHost: '', listenPort: '' })
      const [showSettings, setShowSettings] = useState(false)
      const alive = useRef(true)

      const load = useCallback(
        async (endpoint, payload) => {
          try {
            const value = await call(ctx, endpoint || 'state', payload)
            // Only a full state payload may become the panel state. Several
            // methods return something else (a pairing code, a receipt), and
            // treating one of those as state silently wipes the panel out.
            if (alive.current && value && typeof value === 'object' && value.self) setState(value)
            if (alive.current) setError(null)
            return value
          } catch (failure) {
            if (alive.current) setError(String(failure && failure.message ? failure.message : failure))
            return null
          }
        },
        [ctx],
      )

      useEffect(() => {
        alive.current = true
        void load('watch')
        const timer = setInterval(() => {
          void load('state')
        }, POLL_FALLBACK_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
          void call(ctx, 'unwatch', {}).catch(() => {})
        }
      }, [ctx, load])

      useEffect(() => {
        if (state === null) return
        setSettings((previous) => ({
          machineName: previous.machineName === '' ? (state.self && state.self.name) || '' : previous.machineName,
          relayUrl: previous.relayUrl === '' ? (state.self && state.self.relay && state.self.relay.url) || '' : previous.relayUrl,
          relaySecret: previous.relaySecret,
          relayCa: previous.relayCa === '' ? (state.self && state.self.relay && state.self.relay.ca) || '' : previous.relayCa,
          relayAllowSelfSigned: previous.relayAllowSelfSigned === true
            ? true
            : Boolean(state.self && state.self.relay && state.self.relay.allowSelfSigned),
          listenHost: previous.listenHost === '' ? (state.self && state.self.listenHost) || '' : previous.listenHost,
          listenPort: previous.listenPort === '' ? String((state.self && state.self.listenPort) || '') : previous.listenPort,
        }))
      }, [state])

      const peers = state === null ? [] : (state.peers || []).filter((peer) => (onlyPeer === undefined ? true : peer.id === onlyPeer))
      const forwards = state === null ? [] : (state.forwards || []).filter((forward) => (onlyPeer === undefined ? true : forward.peerId === onlyPeer))
      const self = state === null ? null : state.self

      return h(
        'div',
        { className: 'rm-root' },
        h(
          'div',
          { className: 'rm-scroll' },
          h(
            'div',
            { className: 'rm-head' },
            h(GlobeIcon, { size: 20 }),
            h('h2', { className: 'rm-title' }, onlyPeer === undefined ? tr('remote-workspaces') : tr`remote-workspaces: ${(peers[0] && peers[0].displayName) || onlyPeer}`),
            self === null ? null : h('span', { className: 'rm-chip' }, tr`本机 ${self.name} · ${self.id}`),
            self === null ? null : h('span', { className: 'rm-chip' + (state.relayStatus === 'online' ? ' rm-chip-ok' : state.relayStatus === 'disabled' ? '' : ' rm-chip-bad') }, tr`中继 ${state.relayStatus}`),
            h('span', { className: 'rm-spacer' }),
            h('button', { className: 'rm-btn', onClick: () => load('refresh') }, tr('全部刷新')),
            h('button', { className: 'rm-btn', onClick: () => setShowAdd(!showAdd) }, showAdd ? tr('收起') : tr('添加电脑')),
            h('button', { className: 'rm-btn', onClick: () => setShowSettings(!showSettings) }, showSettings ? tr('收起设置') : tr('设置')),
          ),
          error === null ? null : h('div', { className: 'rm-error' }, error),
          self === null
            ? h('div', { className: 'rm-empty' }, tr('正在读取 remote-workspaces 状态…'))
            : h(
                'div',
                { className: 'rm-note' },
                tr`本机节点 ${self.id}，直连监听 ${self.listenHost}:${self.listenPort}，GUI 端口 ${self.webPort}。配置文件 ${state.paths && state.paths.configFile ? state.paths.configFile : ''}`,
              ),
          self === null || self.usage === undefined
            ? null
            : h('div', { className: 'rm-note' }, tr`本机用量：${usageDetail(self.usage)}`),

          frame === null
            ? null
            : h(
                'div',
                { className: 'rm-frame-wrap' },
                h(
                  'div',
                  { className: 'rm-frame-bar' },
                  h('b', null, frame.name),
                  h('span', { className: 'rm-chip rm-chip-ok' }, `http://127.0.0.1:${frame.port}/`),
                  h('span', { className: 'rm-spacer' }),
                  h('button', {
                    className: 'rm-btn',
                    onClick: async () => {
                      setError(await openTabOrExplain(frame.cleanUrl || frame.url))
                    },
                  }, tr('新标签页打开')),
                  h('button', { className: 'rm-btn', onClick: () => setFrame(null) }, tr('关闭内嵌')),
                ),
                h('iframe', { className: 'rm-frame', src: frame.url, allow: 'clipboard-read; clipboard-write' }),
              ),

          showSettings && self !== null
            ? h(
                'div',
                { className: 'rm-card' },
                h('div', { className: 'rm-card-head' }, h('span', { className: 'rm-name' }, tr('本机设置'))),
                h(
                  'div',
                  { className: 'rm-card-body' },
                  h(
                    'div',
                    { className: 'rm-form' },
                    h('div', { className: 'rm-field' }, h('span', { className: 'rm-field-label' }, tr('本机名称')), h('input', { className: 'rm-input', value: settings.machineName, onChange: (event) => setSettings({ ...settings, machineName: event.target.value }) })),
                    h('div', { className: 'rm-field' }, h('span', { className: 'rm-field-label' }, tr('直连监听地址')), h('input', { className: 'rm-input', value: settings.listenHost, onChange: (event) => setSettings({ ...settings, listenHost: event.target.value }) })),
                    h('div', { className: 'rm-field' }, h('span', { className: 'rm-field-label' }, tr('直连监听端口')), h('input', { className: 'rm-input', style: { width: 90 }, value: settings.listenPort, onChange: (event) => setSettings({ ...settings, listenPort: event.target.value.replace(/[^0-9]/g, '') }) })),
                  ),
                  h(
                    'div',
                    { className: 'rm-form' },
                    h('div', { className: 'rm-field', style: { flex: 1, minWidth: 260 } }, h('span', { className: 'rm-field-label' }, tr('公网中继 WebSocket 地址')), h('input', { className: 'rm-input', placeholder: 'wss://your-domain/__dsh-mesh/relay', value: settings.relayUrl, onChange: (event) => setSettings({ ...settings, relayUrl: event.target.value }) })),
                    h('div', { className: 'rm-field' }, h('span', { className: 'rm-field-label' }, tr('中继密钥（留空保持）')), h('input', { className: 'rm-input', type: 'password', value: settings.relaySecret, onChange: (event) => setSettings({ ...settings, relaySecret: event.target.value }) })),
                  ),
                  h(
                    'div',
                    { className: 'rm-form' },
                    h('div', { className: 'rm-field', style: { flex: 1, minWidth: 260 } }, h('span', { className: 'rm-field-label' }, tr('自签证书的 CA 文件路径（可选）')), h('input', { className: 'rm-input', placeholder: 'C:\\Certify\\Assets\\mesh-chain.pem', value: settings.relayCa, onChange: (event) => setSettings({ ...settings, relayCa: event.target.value }) })),
                    h(
                      'label',
                      { className: 'rm-note', style: { display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 4 } },
                      h('input', { type: 'checkbox', checked: settings.relayAllowSelfSigned, onChange: (event) => setSettings({ ...settings, relayAllowSelfSigned: event.target.checked }) }),
                      tr('不校验证书（自签时用，会打印警告）'),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'rm-form' },
                    h(
                      'button',
                      {
                        className: 'rm-btn rm-btn-primary',
                        onClick: async () => {
                          await load('settings.set', {
                            machineName: settings.machineName,
                            listenHost: settings.listenHost,
                            listenPort: Number(settings.listenPort) || undefined,
                            relayUrl: settings.relayUrl,
                            relayCa: settings.relayCa,
                            relayAllowSelfSigned: settings.relayAllowSelfSigned,
                            ...(settings.relaySecret === '' ? {} : { relaySecret: settings.relaySecret }),
                          })
                          setSettings({ ...settings, relaySecret: '' })
                        },
                      },
                      tr('保存并重连'),
                    ),
                    h('span', { className: 'rm-note' }, tr('改成局域网直连时把监听地址设为 0.0.0.0，并确保防火墙只放行你的内网。')),
                  ),
                ),
              )
            : null,

          showAdd
            ? h(
                'div',
                { className: 'rm-card' },
                h('div', { className: 'rm-card-head' }, h('span', { className: 'rm-name' }, tr('添加电脑'))),
                h(
                  'div',
                  { className: 'rm-card-body' },
                  h('div', { className: 'rm-section-title' }, tr('方式一：粘贴另一台机器生成的配对码（推荐）')),
                  h('div', { className: 'rm-form' }, h('input', { className: 'rm-input', style: { flex: 1, minWidth: 280 }, placeholder: tr('在另一台机器上点「生成配对码」，把那一串粘到这里'), value: pasteCode, onChange: (event) => setPasteCode(event.target.value) })),
                  h(
                    'div',
                    { className: 'rm-form' },
                    h(
                      'button',
                      {
                        className: 'rm-btn rm-btn-primary',
                        disabled: pasteCode.trim() === '',
                        onClick: async () => {
                          const value = await load('pair.accept', { code: pasteCode.trim() })
                          if (!value) return
                          setPasteCode('')
                          setPairNote(
                            value.announced === true
                              ? tr('配对完成：两边都已互相加入，可以直接用了。')
                              : tr`本机已加入，但没能回头通知对方（${value.announceError || '对方暂时不可达'}）。请在对方机器上也生成一次配对码并在这里粘贴，让两边互相可见。`,
                          )
                        },
                      },
                      tr('接收并加入'),
                    ),
                    h(
                      'button',
                      {
                        className: 'rm-btn',
                        onClick: async () => {
                          // Deliberately not `load`: a pairing code is not panel
                          // state.
                          try {
                            const value = await call(ctx, 'pair.create')
                            if (value && typeof value.code === 'string') setPairCode(value.code)
                            else setPairNote(tr('这台机器没有返回配对码。'))
                          } catch (failure) {
                            setPairNote(String(failure && failure.message ? failure.message : failure))
                          }
                        },
                      },
                      tr('生成配对码'),
                    ),
                    h('span', { className: 'rm-note' }, tr('配对码含集群密钥与中继配置，等于把这两台机器放进同一个私有网络，不要外发。')),
                  ),
                  pairCode === '' ? null : h('div', { className: 'rm-code' }, pairCode),
                  pairCode === '' ? null : h('button', { className: 'rm-btn', onClick: () => copyText(pairCode) }, tr('复制配对码')),
                  pairNote === '' ? null : h('div', { className: 'rm-note', style: { marginTop: 6 } }, pairNote),
                  h('div', { className: 'rm-section-title', style: { marginTop: 12 } }, tr('方式二：手动填写')),
                  h(
                    'div',
                    { className: 'rm-form' },
                    h('div', { className: 'rm-field' }, h('span', { className: 'rm-field-label' }, tr('远端节点 id')), h('input', { className: 'rm-input', placeholder: 'desktop-ab12', value: newPeer.id, onChange: (event) => setNewPeer({ ...newPeer, id: event.target.value }) })),
                    h('div', { className: 'rm-field' }, h('span', { className: 'rm-field-label' }, tr('显示名')), h('input', { className: 'rm-input', placeholder: tr('台式机'), value: newPeer.name, onChange: (event) => setNewPeer({ ...newPeer, name: event.target.value }) })),
                    h('div', { className: 'rm-field' }, h('span', { className: 'rm-field-label' }, tr('通道')), h('select', { className: 'rm-select', value: newPeer.transport, onChange: (event) => setNewPeer({ ...newPeer, transport: event.target.value }) }, h('option', { value: 'relay' }, tr('公网中继')), h('option', { value: 'direct' }, tr('局域网直连')))),
                    newPeer.transport === 'direct' ? h('div', { className: 'rm-field' }, h('span', { className: 'rm-field-label' }, tr('地址')), h('input', { className: 'rm-input', value: newPeer.host, onChange: (event) => setNewPeer({ ...newPeer, host: event.target.value }) })) : null,
                    newPeer.transport === 'direct' ? h('div', { className: 'rm-field' }, h('span', { className: 'rm-field-label' }, tr('端口')), h('input', { className: 'rm-input', style: { width: 90 }, value: newPeer.port, onChange: (event) => setNewPeer({ ...newPeer, port: event.target.value.replace(/[^0-9]/g, '') }) })) : null,
                    h(
                      'button',
                      {
                        className: 'rm-btn rm-btn-primary',
                        disabled: newPeer.id.trim() === '',
                        onClick: async () => {
                          const value = await load('peer.add', { id: newPeer.id.trim(), name: newPeer.name.trim() || newPeer.id.trim(), transport: newPeer.transport, host: newPeer.host.trim(), port: Number(newPeer.port) || undefined })
                          if (value) setNewPeer({ id: '', name: '', transport: 'relay', host: '127.0.0.1', port: '' })
                        },
                      },
                      tr('添加'),
                    ),
                  ),
                ),
              )
            : null,

          peers.length === 0
            ? h('div', { className: 'rm-empty' }, tr('还没有配置其它电脑。点「添加电脑」，在另一台机器上装好本插件后用配对码加入即可。'))
            : peers.map((peer) => h(PeerCard, { key: peer.id, ctx, peer, onChanged: () => load('state'), onEmbed: setFrame })),

          // Show the forwards on a per-machine panel too: mapping a port there
          // and then seeing nothing is exactly the wrong feedback. (`forwards`
          // is already filtered to this machine when `onlyPeer` is set.)
          forwards.length > 0
            ? h(
                'div',
                { className: 'rm-card' },
                h('div', { className: 'rm-card-head' }, h('span', { className: 'rm-name' }, onlyPeer === undefined ? tr('端口转发') : tr('端口转发（本机 → 这台机器）'))),
                h('div', { className: 'rm-card-body' }, h('div', { className: 'rm-list' }, forwards.map((forward) => h(ForwardRow, { key: forward.id, ctx, forward, onChanged: () => load('state') })))),
              )
            : null,

          state !== null && state.logs && state.logs.length > 0
            ? h(
                'details',
                null,
                h('summary', { className: 'rm-toggle' }, tr('remote-workspaces 日志')),
                h('div', { className: 'rm-log' }, state.logs.join('\n')),
              )
            : null,
        ),
      )
    }

    /**
     * Mount the sidebar entry, the manager panel, and one entry per configured
     * machine. Per-machine entries follow the peer list, so a machine added at
     * runtime gets its own `remote-workspaces: <name>` row without a reload.
     * @param {any} ctx - Client root context.
     * @returns {void}
     */
    function apply(ctx) {
      ensureStyles()

      // Localisation: the dictionaries follow the shell's global setting, and
      // `bind` re-translates on render so a language switch needs no reload.
      // A shell without the locale service keeps the Chinese source text.
      if (ctx.locale !== undefined) {
        try {
          translate = ctx.locale.bind(LOCALE_NS)
          ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh: ZH, en: EN }), 'remote-mesh: locale dictionaries')
        } catch (error) {
          console.error('[remote-workspaces] cannot attach the locale dictionaries:', error)
        }
      }

      // The manager entry first: it is the panel that can add machines.
      try {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 900, label: () => tr('remote-workspaces') }, (props) => h(GlobeIcon, props)),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(WorkspacesPanel, { ctx })))
      } catch (error) {
        console.error('[remote-workspaces] cannot register the remote-workspaces panel:', error)
        return
      }

      /**
       * Per-machine sidebar rows. Registration is idempotent: the map holds one
       * disposer per peer id and the peer list decides membership.
       * @type {Map<string, () => void>}
       */
      const entries = new Map()
      let stopped = false

      const sync = async () => {
        if (stopped) return
        let state
        try {
          state = await call(ctx, 'state')
        } catch {
          return
        }
        const peers = (state && state.peers) || []
        const wanted = new Map(peers.filter((peer) => peer.enabled !== false).map((peer) => [peer.id, peer]))
        // Two machines can share a hostname — that is the default display name —
        // and then two sidebar rows read identically. Append a short id only for
        // the names that actually collide, so the common case stays clean.
        const nameCounts = new Map()
        for (const peer of wanted.values()) {
          const display = peer.displayName || peer.id
          nameCounts.set(display, (nameCounts.get(display) ?? 0) + 1)
        }
        const labelFor = (peer) => {
          const display = peer.displayName || peer.id
          return nameCounts.get(display) > 1 ? `${display} (${peer.id.slice(-4)})` : display
        }
        for (const [id, entry] of [...entries]) {
          if (wanted.has(id)) continue
          try {
            entry.dispose()
          } catch {
            /* the slot may already be gone */
          }
          entries.delete(id)
        }
        let index = 0
        for (const peer of wanted.values()) {
          index += 1
          const name = labelFor(peer)
          const existing = entries.get(peer.id)
          if (existing !== undefined) {
            // The label is a thunk the sidebar re-reads on every projection, so
            // a rename shows up without re-registering the row. (It has to live
            // in a plain object: a function's own `name` is read-only.)
            existing.label.value = name
            continue
          }
          const id = `${PANEL_ID}:${peer.id}`
          // A mutable holder, not the peer snapshot: the row outlives many syncs.
          const label = { value: name }
          try {
            const disposeEntry = ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register({ name: 'sidebar.panellist', id, order: 1000 + index, label: () => tr`remote-workspaces: ${label.value}` }, (props) => h(MachineIcon, props)),
            )
            const disposePanel = ctx.slots.inject('main', () =>
              ctx.slots.register({ name: 'main', key: id }, () => h(WorkspacesPanel, { ctx, onlyPeer: peer.id })),
            )
            entries.set(peer.id, {
              label,
              dispose: () => {
                disposeEntry()
                disposePanel()
              },
            })
          } catch (error) {
            console.error('[remote-workspaces] cannot register a sidebar row for', peer.id, error)
          }
        }
      }

      void sync()
      const timer = setInterval(() => void sync(), 20000)
      ctx.effect(
        () => () => {
          stopped = true
          clearInterval(timer)
          for (const entry of entries.values()) {
            try {
              entry.dispose()
            } catch {
              /* the slot may already be gone */
            }
          }
          entries.clear()
        },
        'remote-workspaces: per-machine sidebar entries',
      )
    }

    exports.apply = apply
    exports.inject = ['connection', 'slots', 'locale']
    return module.exports
  },
})
