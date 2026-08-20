/**
 * dsh-super-injector 插件管理 UI（settings.section 页面）。
 * 功能：已注入插件列表 + 一键卸载 + 添加（路径输入/拖放提示）——
 *   - 直接注入：目录已是插件包（package.json + lib/）→ 立即注入
 *   - 内化：任意文件夹 → 新建 agent 会话 → AI 把内容变成插件
 * 通信：同源 fetch → host webServer API（/super-injector/api）
 *
 * ⚠️ 契约修复（2026-08）：DSH 的 settings.section 要求 register(options, Comp)
 * 的**第二参数是真正的 React 组件**。原实现把组件塞进 options.component 且
 * 返回非 React 对象 → 渲染时组件为 undefined → React 错误 #130 → 设置页
 * 「插件」空白。此处按契约注册真组件，并改为 locale 感知：导航名随界面语言
 * （中文「超级模组」/ 英文 "Super Mods"），不再与官方「插件」页硬编码重名。
 * 页面正文（列表/按钮/提示/统计）亦全部走字典，避免 en 界面「导航英、正文中」。
 */
import * as React from 'react'
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'

type Translate = (key: string, params?: Record<string, unknown>) => string

type ClientContext = {
  slots: SlotsService
  effect(callback: () => unknown, label?: string): void
  locale: {
    register(namespace: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): unknown
    bind(namespace: string): Translate
  }
}

export const inject = ['slots', 'locale']

const NS = 'dsh-super-injector'
const API = '/super-injector/api'

/** 字典（zh 为源，en 镜像；插值占位 {name} 由 t(key, params) 填充）。 */
const zh: Record<string, string> = {
  nav: '超级模组',
  title: '超级模组管理（dsh-super-injector）',
  stats: 'inject {injectOk}✓/{injectFail}✗ · reload {reloadOk}✓ · uninject {uninjectOk}✓/{uninjectFail}✗ · 共 {total} 个注入插件',
  addHint: '拖入文件夹，或输入路径——「内化」= 新建会话让 AI 把内容变成插件；「注入」= 目录已是插件包直接注入',
  ingestTitle: '内化插件',
  injectTitle: '直接注入',
  btnIngest: '内化（AI 造插件）',
  btnInject: '直接注入',
  busy: '处理中…',
  dropNotice: '浏览器无法读取拖入文件夹的绝对路径——请粘贴路径或使用选择器',
  inputPh: 'D:/path/to/folder',
  emptyList: '（暂无注入插件——拖入文件夹或输入路径开始）',
  stateActive: '运行中',
  stateInactive: '未激活',
  btnUninstall: '卸载',
  uninstalling: '卸载中…',
  pathRequired: '请先输入文件夹路径',
  uninstallFail: '卸载请求失败: {err}',
  loadFail: '加载失败: {err}',
  requestFail: '请求失败: {err}',
}
const en: Record<string, string> = {
  nav: 'Super Mods',
  title: 'Super Mods Manager (dsh-super-injector)',
  stats: 'inject {injectOk}✓/{injectFail}✗ · reload {reloadOk}✓ · uninject {uninjectOk}✓/{uninjectFail}✗ · {total} injected mods in total',
  addHint: 'Drop a folder or paste a path — "Ingest" starts a session for AI to turn it into a plugin; "Inject" mounts it directly if it already is a plugin package',
  ingestTitle: 'Ingest as plugin',
  injectTitle: 'Inject directly',
  btnIngest: 'Ingest (AI builds it)',
  btnInject: 'Inject directly',
  busy: 'Working…',
  dropNotice: 'Browsers cannot read a dropped folder\'s absolute path — paste the path or use a picker instead',
  inputPh: 'D:/path/to/folder',
  emptyList: '(No injected mods yet — drop a folder or enter a path to start)',
  stateActive: 'Active',
  stateInactive: 'Inactive',
  btnUninstall: 'Uninstall',
  uninstalling: 'Removing…',
  pathRequired: 'Enter a folder path first',
  uninstallFail: 'Uninstall request failed: {err}',
  loadFail: 'Failed to load: {err}',
  requestFail: 'Request failed: {err}',
}

const styles = `
.spi-page{font-family:ui-monospace,monospace;font-size:12px;line-height:1.6;padding:14px 16px;max-width:720px}
.spi-page h3{margin:0 0 8px;font-size:13px}
.spi-add{border:1.5px dashed var(--theme-border,#555);border-radius:8px;padding:12px;margin-bottom:14px;text-align:center;color:var(--theme-text-secondary,#999)}
.spi-add.drag{border-color:var(--theme-accent,#4a9eff);background:rgba(74,158,255,.08)}
.spi-row{display:flex;gap:6px;margin-top:10px}
.spi-input{flex:1;background:var(--theme-input-bg,#111);color:var(--theme-text,#ddd);border:1px solid var(--theme-border,#333);border-radius:6px;padding:6px 8px;font-size:12px}
.spi-btn{background:var(--theme-accent,#4a9eff);color:#fff;border:none;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px;white-space:nowrap}
.spi-btn.ghost{background:transparent;border:1px solid var(--theme-border,#444);color:var(--theme-text,#ccc)}
.spi-btn.danger{background:transparent;border:1px solid #d33;color:#d33}
.spi-btn:disabled{opacity:.45;cursor:not-allowed}
.spi-list{list-style:none;margin:0;padding:0}
.spi-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--theme-border,#333);border-radius:8px;margin-bottom:6px}
.spi-item .name{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.spi-item .dir{color:var(--theme-text-secondary,#888);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40%}
.spi-item .st{font-size:10px;padding:2px 6px;border-radius:10px}
.spi-item .st.on{background:rgba(46,204,113,.15);color:#2ecc71}
.spi-item .st.off{background:rgba(255,193,7,.12);color:#f1c40f}
.spi-msg{margin-top:10px;padding:8px 10px;border-radius:6px;background:var(--theme-input-bg,#111);border:1px solid var(--theme-border,#333);white-space:pre-wrap;max-height:180px;overflow:auto;font-size:11px}
.spi-stats{color:var(--theme-text-secondary,#888);font-size:11px;margin:0 0 10px}
`

function fetchJson(path: string, init?: RequestInit): Promise<any> {
  return fetch(API + path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  }).then((r) => r.json())
}

/** 真正的 React 函数组件：settings.section 经 register(options, Comp) 渲染；
 *  t 通过注册的 inject face 注入。 */
function SuperInjectorPage({ t }: { t: Translate }) {
  // entries === undefined → 仍在加载
  const [entries, setEntries] = React.useState<any[]>()
  const [statsText, setStatsText] = React.useState('')
  const [msg, setMsg] = React.useState('')
  const [isErr, setIsErr] = React.useState(false)
  const [path, setPath] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [drag, setDrag] = React.useState(false)
  const [placeholder, setPlaceholder] = React.useState(t('inputPh'))
  const [uninstallName, setUninstallName] = React.useState('')

  const refresh = React.useCallback(() => {
    fetchJson('/list').then((d) => {
      if (!d?.ok) { setMsg(JSON.stringify(d)); setIsErr(true); return }
      const { entries: es, stats: s } = d
      setEntries(es)
      setStatsText(t('stats', {
        injectOk: s?.inject?.ok ?? 0,
        injectFail: s?.inject?.fail ?? 0,
        reloadOk: s?.reload?.ok ?? 0,
        uninjectOk: s?.uninject?.ok ?? 0,
        uninjectFail: s?.uninject?.fail ?? 0,
        total: es.length,
      }))
      setMsg('')
      setIsErr(false)
    }).catch((err) => { setMsg(t('loadFail', { err: String(err) })); setIsErr(true) })
  }, [t])
  React.useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, 60000)
    return () => window.clearInterval(timer)
  }, [refresh, t])

  const say = (text: string, err = false): void => { setMsg(text); setIsErr(err) }

  const doAction = (apiPath: string, title: string): void => {
    const dir = path.trim()
    if (!dir) { say(t('pathRequired'), true); return }
    setBusy(true)
    fetchJson(apiPath, { method: 'POST', body: JSON.stringify({ dir, title }) })
      .then((r) => { say(r?.result ?? JSON.stringify(r), !r?.ok); if (r?.ok) setTimeout(refresh, 1200) })
      .catch((err) => say(t('requestFail', { err: String(err) }), true))
      .finally(() => setBusy(false))
  }

  const uninstall = (name: unknown): void => {
    setUninstallName(String(name))
    fetchJson('/uninstall', { method: 'POST', body: JSON.stringify({ match: name }) })
      .then((r) => say(r?.result ?? JSON.stringify(r), !r?.ok))
      .catch((err) => say(t('uninstallFail', { err: String(err) }), true))
      .finally(() => { setTimeout(() => { setUninstallName(''); refresh() }, 600) })
  }

  return React.createElement('div', { className: 'spi-page' },
    React.createElement('style', null, styles),
    React.createElement('h3', null, t('title')),
    React.createElement('p', { className: 'spi-stats' }, statsText),
    React.createElement('div', {
        className: 'spi-add' + (drag ? ' drag' : ''),
        onDragOver: (e) => { e.preventDefault(); setDrag(true) },
        onDragLeave: () => setDrag(false),
        onDrop: (e) => { e.preventDefault(); setDrag(false); setPlaceholder(t('dropNotice')) },
      },
      t('addHint'),
      React.createElement('div', { className: 'spi-row' },
        React.createElement('input', { className: 'spi-input', placeholder: placeholder, value: path, onChange: (e) => setPath(e.target.value) }),
        React.createElement('button', { className: 'spi-btn', disabled: busy, onClick: () => doAction('/ingest', t('ingestTitle')) }, busy ? t('busy') : t('btnIngest')),
        React.createElement('button', { className: 'spi-btn ghost', disabled: busy, onClick: () => doAction('/inject', t('injectTitle')) }, busy ? t('busy') : t('btnInject')),
      ),
    ),
    React.createElement('ul', { className: 'spi-list' },
      entries === undefined ? null
      : entries.length === 0
        ? React.createElement('li', { className: 'spi-item' }, t('emptyList'))
        : entries.map((e) => React.createElement('li', { className: 'spi-item', key: String(e.name) },
            React.createElement('span', { className: 'name' }, String(e.name)),
            React.createElement('span', { className: 'dir' }, String(e.dir)),
            React.createElement('span', { className: 'st ' + (e.active ? 'on' : 'off') }, e.active ? t('stateActive') : t('stateInactive')),
            React.createElement('button', { className: 'spi-btn danger', disabled: uninstallName !== '', onClick: () => uninstall(e.name) }, uninstallName === String(e.name) ? t('uninstalling') : t('btnUninstall')),
          )),
    ),
    msg ? React.createElement('div', { className: 'spi-msg', style: { display: 'block', borderColor: isErr ? '#d33' : 'var(--theme-border,#333)' } }, msg) : null,
  )
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-super-injector: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: 'super-injector-plugins',
      order: 50,
      label: () => t('nav'),
      locale: NS,
      inject: () => ({ t }),
    }, SuperInjectorPage),
  ), 'super-injector: settings page')
}
