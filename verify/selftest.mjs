/*
 * ============================================================================
 * 本文件由 AI 辅助生成（AI-generated / AI-assisted）。
 *
 * 免责声明：
 *   本项目不对正确性、稳定性、适销性或特定用途适用性作任何明示或默示担保。
 *   使用本插件造成的任何直接或间接损失，作者与团队均不承担责任。
 *   请自行评估风险，并优先遵守所在地区的法律法规与服务商协议。
 *   完整声明见仓库根目录的 DISCLAIMER.md。
 * ============================================================================
 */
// dsh-session-delete 离线自测：不连 DSH，只用桩环境把主机半 + 浏览器半跑一遍。
// 跑法（DSH 自带 Node）：node verify/selftest.mjs   → 退出码 0 = 全绿
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'

// 默认自测开发目录；`--root <dir>` 指到别处（库里跑 releases\<版本> 用）。
const rootFlag = process.argv.indexOf('--root')
const root = rootFlag >= 0
  ? resolve(process.cwd(), process.argv[rootFlag + 1])
  : dirname(dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')))
console.log('[0] 被测目录: ' + root)
const read = rel => readFileSync(join(root, rel), 'utf8')
const failures = []
const ok = (name, condition, detail) => {
  if (condition) console.log('  ✓ ' + name)
  else { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')) }
}

// ============ 1. 包声明 ============
const pkg = JSON.parse(read('package.json'))
const clientCode = read(pkg.exports['./client'].replace('./', ''))
const patch = read('cordis.patch.yml')
console.log('[1] package.json / cordis.patch.yml')
ok('dsh.client.platform = web', pkg.dsh?.client?.platform === 'web')
ok('dsh.client.immediately = true', pkg.dsh?.client?.immediately === true)
ok('bundle patch 指向 cordis.patch.yml', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
ok('patch 行 name = 包名', patch.includes('name: ' + pkg.name), patch.trim())
ok('client 半存在', clientCode.includes('window.__ModuleLoader__.load'))
ok('client 模块 id = 包名', new RegExp("id:\\s*'" + pkg.name + "'").test(clientCode))

// ============ 2. 主机半 ============
console.log('[2] src/index.js 主机半')
const host = await import(pathToFileURL(join(root, 'src', 'index.js')).href)
ok('导出 apply', typeof host.apply === 'function')
ok('注入 webServer/sessionPersistence/sessions/agents',
  JSON.stringify(host.inject) === JSON.stringify(['webServer', 'sessionPersistence', 'sessions', 'agents']),
  JSON.stringify(host.inject))

{
  const routes = []
  let released = 0
  const agentStub = {
    create: async ({ sessionId }) => ({ agent: { id: sessionId }, dispose: async () => {} }),
    resume: async ({ resumeSessionId }) => ({ agent: { id: resumeSessionId }, dispose: async () => {} }),
    enter: () => undefined,
    get: () => undefined,
  }
  const ctx = {
    sessionPersistence: { config: { root: join(tmpdir(), 'sdel-selftest-sessions') } },
    agents: agentStub,
    sessions: { get: () => undefined, enter: () => undefined },
    webServer: { register: route => { routes.push(route); return () => {} } },
    effect: fn => { const c = fn(); if (c) released++ },
    get: () => undefined,
  }
  host.apply(ctx)
  ok('注册了一条路由', routes.length === 1, JSON.stringify(routes.map(r => r.path)))
  const route = routes[0]
  ok('路由 kind=exact', route?.kind === 'exact')
  ok('路由 path = /plugins/dsh-session-delete/delete',
    route?.path === '/plugins/dsh-session-delete/delete', route?.path)

  // GET 必须 405（只允许 POST）
  const capture = async (req) => {
    let status = 0, body = null
    const res = { writeHead: (code) => { status = code }, end: (text) => { body = JSON.parse(text) } }
    await route.handler(req, res)
    return { status, body }
  }
  const get = await capture({ method: 'GET', headers: {} })
  ok('GET → 405 method-not-allowed', get.status === 405 && get.body?.error?.code === 'method-not-allowed', JSON.stringify(get))
  const bad = await capture({
    method: 'POST',
    headers: {
      host: '127.0.0.1:1',
      origin: 'http://127.0.0.1:1',
      'content-type': 'application/json',
      'x-dsh-session-delete-confirmation': 'delete-session',
    },
    [Symbol.asyncIterator]: async function * () { yield Buffer.from('{"sessionId":""}') },
  })
  ok('空 sessionId → 400 invalid-session-id', bad.status === 400 && bad.body?.error?.code === 'invalid-session-id', JSON.stringify(bad))
  const noconfirm = await capture({
    method: 'POST',
    headers: { host: '127.0.0.1:1', origin: 'http://evil.example', 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function * () { yield Buffer.from('{"sessionId":"abc"}') },
  })
  ok('跨站/缺确认头 → 403 forbidden', noconfirm.status === 403, JSON.stringify(noconfirm))
  const badmode = await capture({
    method: 'POST',
    headers: {
      host: '127.0.0.1:1',
      origin: 'http://127.0.0.1:1',
      'content-type': 'application/json',
      'x-dsh-session-delete-confirmation': 'delete-session',
    },
    [Symbol.asyncIterator]: async function * () { yield Buffer.from('{"sessionId":"abc","mode":"nuke"}') },
  })
  ok('非法 mode → 400 invalid-mode', badmode.status === 400 && badmode.body?.error?.code === 'invalid-mode', JSON.stringify(badmode))
  // 回归：2026-11-13 实测硬删被这句笔误拦死（mode !== 'hide' 把 permanent 也拒了）
  const permProbe = await capture({
    method: 'POST',
    headers: {
      host: '127.0.0.1:1',
      origin: 'http://127.0.0.1:1',
      'content-type': 'application/json',
      'x-dsh-session-delete-confirmation': 'delete-session',
    },
    [Symbol.asyncIterator]: async function * () { yield Buffer.from('{"sessionId":"abc","mode":"permanent"}') },
  })
  ok('mode:permanent 不被误拒（404 路径继续走，不是 400 invalid-mode）',
    !(permProbe.status === 400 && permProbe.body?.error?.code === 'invalid-mode'), JSON.stringify(permProbe))
  const hideProbe = await capture({
    method: 'POST',
    headers: {
      host: '127.0.0.1:1',
      origin: 'http://127.0.0.1:1',
      'content-type': 'application/json',
      'x-dsh-session-delete-confirmation': 'delete-session',
    },
    [Symbol.asyncIterator]: async function * () { yield Buffer.from('{"sessionId":"abc","mode":"hide"}') },
  })
  ok('mode:hide 同样不被误拒',
    !(hideProbe.status === 400 && hideProbe.body?.error?.code === 'invalid-mode'), JSON.stringify(hideProbe))
}

// hide 模式：retireDirectory 被调用、removeDirectory 绝不被调用（真实临时目录，走完整保守流程）
{
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-sd-hide-'))
  const transcript = join(sessionRoot, 'proj', 'S-9', 'session.jsonl')
  mkdirSync(join(sessionRoot, 'proj', 'S-9'), { recursive: true })
  writeFileSync(transcript, '{"hello":"zstd stand-in"}\n')
  const header = { id: 'S-9', version: 1, createdAt: 't', cwd: 'C:\\w', parentSession: undefined, seedLength: 0, origin: undefined, delegationDepth: 0, agentPreset: undefined, isSeeded: false }
  let retired = null
  let removed = 0
  let result
  try {
    result = await host.deleteSessionSafely({
      sessions: { get: () => undefined },
      agents: { get: () => undefined },
      agentHandles: { reserve: () => () => {}, dispose: async () => true },
      sessionPersistence: {
        supportsRawArtifacts: true,
        list: async () => [header],
        inspect: async () => ({ meta: header }),
        locate: () => ({ kind: 'jsonl', path: transcript }),
        readRaw: async () => ({ meta: header }),
      },
      retireDirectory: async (dir, info) => { retired = { dir, info } },
      removeDirectory: async () => { removed++ },
    }, { sessionRoot, sessionId: 'S-9', mode: 'hide' })
  } catch (error) { result = { threw: error } }
  ok('hide 模式调 retireDirectory 且不调 removeDirectory', retired !== null && removed === 0, JSON.stringify({ retired, removed, result }))
  ok('retireDirectory 收到项目名', retired?.info?.project === 'proj', JSON.stringify(retired?.info))
  // retire 桩把目录搬走才算成功；这里桩只记账不真搬 → 保守 storage-partial，绝不谎报成功
  ok('retire 未完成时保守报 storage-partial', result?.ok === false && result?.error?.code === 'storage-partial', JSON.stringify(result))
  rmSync(sessionRoot, { recursive: true, force: true })
}

// 损坏 transcript（open 抛 SessionFormatError/corrupt）：物理兜底必须接管，且不碰文件内容
{
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } = await import('node:fs')
  const build = () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-sd-corrupt-'))
    const transcript = join(sessionRoot, 'proj', 'S-9', 'session.v4.jsonl.zstd')
    mkdirSync(join(sessionRoot, 'proj', 'S-9'), { recursive: true })
    writeFileSync(transcript, 'corrupt bytes')
    return { sessionRoot, transcript }
  }
  const header = { id: 'S-9', version: 1, createdAt: 't', cwd: 'C:\\w', parentSession: undefined, seedLength: 0, origin: undefined, delegationDepth: 0, agentPreset: undefined, isSeeded: false }
  const corruptDeps = extra => ({
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    agentHandles: { reserve: () => () => {}, dispose: async () => true },
    sessionPersistence: {
      name: 'session-persistence-jsonl',
      open: async () => { throw new Error('session "S-9": stored log is corrupt: SessionFormatError: system/message requires a protected first surface head') },
      stat: async () => ({ size: 13 }),
      resolveCurrentLog: async () => { throw new Error('corrupt') },
      list: async () => [{ header }],
    },
    ...extra,
  })
  // 硬删：物理兜底把目录删掉
  {
    const { sessionRoot } = build()
    const result = await host.deleteSessionSafely(corruptDeps({}), { sessionRoot, sessionId: 'S-9', mode: 'permanent' })
    ok('损坏会话硬删走物理兜底成功', result?.ok === true && result?.value?.deleted === true && result?.value?.corruptRecovery === true, JSON.stringify(result))
    rmSync(sessionRoot, { recursive: true, force: true })
  }
  // 软删：retireDirectory 收到正确项目名，文件内容零改动
  {
    const { sessionRoot, transcript } = build()
    const before = statSync(transcript).size
    let retired = null
    let hiddenDir = null
    const { rename: fsRename, mkdir: fsMkdir } = await import('node:fs/promises')
    const result = await host.deleteSessionSafely(corruptDeps({
      retireDirectory: async (dir, info) => {
        retired = { dir, info }
        hiddenDir = join(tmpdir(), 'dsh-sd-corrupt-hidden-' + Math.random().toString(36).slice(2))
        await fsMkdir(hiddenDir, { recursive: true })
        await fsRename(dir, join(hiddenDir, 'S-9'))
      },
    }), { sessionRoot, sessionId: 'S-9', mode: 'hide' })
    ok('损坏会话软删调 retireDirectory', result?.ok === true && result?.value?.hidden === true && retired?.info?.project === 'proj', JSON.stringify({ result, retired }))
    ok('损坏会话文件内容零改动', statSync(join(hiddenDir, 'S-9', 'session.v4.jsonl.zstd')).size === before)
    rmSync(sessionRoot, { recursive: true, force: true })
    rmSync(hiddenDir, { recursive: true, force: true })
  }
  // 拿不准（目录不存在）→ 维持保守失败，不谎报
  {
    const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-sd-corrupt-'))
    const result = await host.deleteSessionSafely(corruptDeps({}), { sessionRoot, sessionId: 'S-9', mode: 'permanent' })
    ok('损坏但物理布局对不上 → 仍 storage-state-unknown', result?.ok === false && result?.error?.code === 'storage-state-unknown', JSON.stringify(result))
    rmSync(sessionRoot, { recursive: true, force: true })
  }
}

// 没有 sessionPersistence 根目录时不得抛异常（否则整条插件树会被它拖挂）
{
  let threw = null
  const ctx = { sessionPersistence: undefined, agents: {}, sessions: {}, webServer: { register: () => () => {} }, effect: fn => fn(), get: () => undefined }
  try { host.apply(ctx) } catch (error) { threw = error }
  ok('缺 sessionPersistence 时只告警不抛', threw === null, threw?.message)
}

// ============ 3. 浏览器半（vm 桩环境） ============
console.log('[3] lib/client.js 浏览器半')
const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
const ReactStub = {
  createElement: h,
  useSyncExternalStore: (_sub, snap) => snap(),
}
const captured = {}
const fetchCalls = []
const probeCalls = { n: 0 }
let probeMode = 'new' // 'new' → 探测回 400 invalid-mode；'legacy' → 回 409（旧版主机半）
const styles = []
const sandbox = {
  window: { __ModuleLoader__: { load: mod => { captured.module = mod } } },
  document: { createElement: tag => { const el = { tag, id: '', textContent: '', remove() {} }; styles.push(el); return el }, head: { appendChild() {} } },
  console: { warn() {}, log() {}, error() {} },
  AbortController: class { constructor() { this.signal = { aborted: false } } abort() { this.signal.aborted = true } },
  fetch: async (url, init) => {
    // 能力探测（假 sessionId + 非法 mode）：新版主机半回 400 invalid-mode。
    if (init && init.body === JSON.stringify({ sessionId: '__dsh-session-delete-probe__', mode: '__probe__' })) {
      probeCalls.n++
      return probeMode === 'new'
        ? { ok: false, status: 400, json: async () => ({ ok: false, error: { code: 'invalid-mode' } }) }
        : { ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'session-not-found' } }) }
    }
    fetchCalls.push({ url, init })
    const wantFail = fetchCalls.length > 2
    return wantFail
      ? { ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'storage-state-unknown', message: '删除状态未确认' } }) }
      : { ok: true, status: 200, json: async () => ({ ok: true }) }
  },
  Promise, Set, Map, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Symbol, Buffer: undefined,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
try { vm.runInContext(clientCode, sandbox) } catch (error) { failures.push('client 半解析执行: ' + error.message); console.log('  ✗ client 半解析执行: ' + error.message) }

const requireStub = name => {
  if (name === 'react') return ReactStub
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { IconTrashOutlineRegular: p => h('svg', p) }
  throw new Error('unknown module ' + name)
}
const mod = captured.module
ok('模块已注册', !!mod && mod.id === 'dsh-session-delete', mod?.id)

const injections = []
const registered = []
let cleared = 0
const cleanups = []
const clientCtx = {
  locale: { getSnapshot: () => ({ active: 'zh' }) },
  effect: fn => { const c = fn(); if (typeof c === 'function') cleanups.push(c) },
  get: key => {
    if (key === 'uiWorkspace') return { selection: { getSnapshot: () => ({ sessionId: 'S-1' }) }, clearMain: () => { cleared++ } }
    if (key === 'sessions') return { refresh: async () => {} }
    if (key === 'workspaces') return { refresh: async () => {} }
    return undefined
  },
  slots: {
    inject: (name, factory) => { injections.push(name); factory() },
    register: (options, component) => { registered.push({ options, component }); return options.id },
  },
}
try {
  const clientMod = mod.factory(requireStub)
  ok('客户端模块声明 inject slots', JSON.stringify(clientMod.inject) === JSON.stringify(['slots', 'locale']), JSON.stringify(clientMod.inject))
  clientMod.apply(clientCtx)
} catch (error) { failures.push('client apply 抛错: ' + error.message); console.log('  ✗ client apply 抛错: ' + error.message) }

const slotNames = injections.slice()
ok('挂了 menu.item 槽', slotNames.includes('sidebar.workspaces.session.menu.item'))
ok('挂了 shell.overlay 槽', slotNames.includes('shell.overlay'))
ok('不再挂 hover 垃圾桶行（1.1.0 按需求方要求去掉）', !slotNames.includes('sidebar.workspaces.session.row.action'), JSON.stringify(slotNames))
const byId = Object.fromEntries(registered.map(r => [r.options.id, r]))
ok('两个条目都注册了', registered.length === 2, JSON.stringify(registered.map(r => r.options.id)))

const menuItem = byId['dsh-session-delete.delete']
const overlay = byId['dsh-session-delete.confirm']
ok('menu.item order=700（排在宿主归档 600 之后 = 最后一行）', menuItem?.options.order === 700)

// 渲染：条目不抛
const render = (entry, props) => entry.component(props)
let rendered
try {
  rendered = {
    menu: render(menuItem, { sessionId: 'S-1', displayTitle: '测试对话', useMenuOpenState: () => [false, () => {}] }),
    dialogClosed: render(overlay, {}),
  }
  ok('条目渲染成功', true)
} catch (error) { ok('条目渲染成功', false, error.message) }
ok('默认无弹层', rendered?.dialogClosed === null)

// 点菜单行 → 弹层出现（并发能力探测），默认选中软删（隐藏）
rendered.menu.props.onClick()
await new Promise(resolve => setImmediate(resolve))
await new Promise(resolve => setImmediate(resolve))
ok('开弹层先发能力探测', probeCalls.n === 1, String(probeCalls.n))
ok('菜单行是红色', rendered.menu.props.className.includes('dsh-sd-danger'), rendered.menu.props.className)
{
  const css = styles[0]?.textContent ?? ''
  const menuPos = css.indexOf('.dsh-sd-menu-row{')
  const dangerPos = css.indexOf('.dsh-sd-danger{')
  ok('CSS 里 danger 排在 menu-row 之后（层叠覆盖才红）', menuPos >= 0 && dangerPos > menuPos, JSON.stringify({ menuPos, dangerPos }))
  ok('danger 带 !important 兜底宿主菜单样式', /\.dsh-sd-danger\{[^}]*!important/.test(css))
}
const dialog = render(overlay, {})
ok('点击后弹层出现', dialog?.type === 'div' && JSON.stringify(dialog).includes('删除这个对话'))
const radios = (function collect(node, out) {
  if (!node || typeof node !== 'object') return out
  if (node.props?.type === 'radio') out.push(node)
  for (const child of node.children ?? []) collect(child, out)
  return out
})(dialog, [])
ok('弹层有 软删/硬删 两个单选项', radios.length === 2, JSON.stringify(radios.map(r => r.props.value)))
ok('默认选中隐藏（软删）', radios.some(r => r.props.value === 'hide' && r.props.checked)
  && radios.some(r => r.props.value === 'permanent' && !r.props.checked))
ok('新版主机半：软删可用', radios.every(r => !r.props.disabled), JSON.stringify(radios.map(r => r.props.disabled)))

const findActions = node => {
  if (!node || typeof node !== 'object') return null
  if (node.props?.className === 'dsh-sd-actions') return node
  for (const child of node.children ?? []) { const hit = findActions(child); if (hit) return hit }
  return null
}

// —— 软删路径：默认模式下点确认 → POST mode:'hide'，绝不走归档 ——
let primary = (findActions(dialog)?.children ?? []).filter(Boolean).find(c => c.props?.className?.includes('dsh-sd-btn-primary'))
ok('软删模式下确认键是普通主按钮', !!primary)
primary.props.onClick()
await new Promise(resolve => setImmediate(resolve))
await new Promise(resolve => setImmediate(resolve))
ok('软删发了 POST mode:hide',
  fetchCalls.length === 1 && fetchCalls[0]?.init?.body === JSON.stringify({ sessionId: 'S-1', mode: 'hide' }),
  JSON.stringify(fetchCalls.map(f => f.init?.body)))
ok('软删成功后弹层关闭', render(overlay, {}) === null)

// —— 硬删路径：切到 permanent 后点确认 → POST mode:'permanent' 带确认头 ——
render(overlay, {})
menuItem.component({ sessionId: 'S-1', displayTitle: '测试对话' }).props.onClick()
const dialogP = render(overlay, {})
const permRadio = (function collect(node, out) {
  if (!node || typeof node !== 'object') return out
  if (node.props?.type === 'radio' && node.props.value === 'permanent') out.push(node)
  for (const child of node.children ?? []) collect(child, out)
  return out
})(dialogP, [])[0]
ok('弹层能选到硬删', !!permRadio)
permRadio.props.onChange()
const dialogP2 = render(overlay, {})
const danger = (findActions(dialogP2)?.children ?? []).filter(Boolean).find(c => c.props?.className?.includes('danger'))
const cancel = (findActions(dialogP2)?.children ?? []).filter(Boolean).find(c => c.props?.className === 'dsh-sd-btn')
ok('硬删模式下有取消 + 红色危险确认两个按钮', !!danger && !!cancel)
danger.props.onClick()
await new Promise(resolve => setImmediate(resolve))
await new Promise(resolve => setImmediate(resolve))
ok('发了删除请求', fetchCalls.length === 2, JSON.stringify(fetchCalls.map(f => f.url)))
ok('请求打到主机路由', fetchCalls[1]?.url === '/plugins/dsh-session-delete/delete', fetchCalls[1]?.url)
ok('带确认头', fetchCalls[1]?.init?.headers?.['x-dsh-session-delete-confirmation'] === 'delete-session')
ok('body 是 {sessionId,mode:permanent}', fetchCalls[1]?.init?.body === JSON.stringify({ sessionId: 'S-1', mode: 'permanent' }), fetchCalls[1]?.init?.body)
ok('删的是当前打开的对话时清空视图', cleared === 2, String(cleared))

// 失败路径：错误文案回到弹层
render(overlay, {})
menuItem.component({ sessionId: 'S-2', displayTitle: '另一个' }).props.onClick()
const dialog2 = render(overlay, {})
const permRadio2 = (function collect(node, out) {
  if (!node || typeof node !== 'object') return out
  if (node.props?.type === 'radio' && node.props.value === 'permanent') out.push(node)
  for (const child of node.children ?? []) collect(child, out)
  return out
})(dialog2, [])[0]
permRadio2.props.onChange()
const dialog2b = render(overlay, {})
const dangerBtn = (findActions(dialog2b)?.children ?? []).filter(Boolean).find(c => c.props?.className?.includes('danger'))
dangerBtn.props.onClick()
await new Promise(resolve => setImmediate(resolve))
await new Promise(resolve => setImmediate(resolve))
await new Promise(resolve => setImmediate(resolve))
const dialog3 = render(overlay, {})
ok('失败时弹层留在原地并显示原因', JSON.stringify(dialog3).includes('删除状态未确认'), JSON.stringify(dialog3).slice(0, 160))

// ============ 4. 取不到宿主图标时仍要能渲染 ============
console.log('[4] 图标退化路径')
{
  const captured2 = {}
  const sandbox2 = Object.assign({}, sandbox, {
    window: { __ModuleLoader__: { load: mod2 => { captured2.module = mod2 } } },
  })
  sandbox2.globalThis = sandbox2
  vm.createContext(sandbox2)
  vm.runInContext(clientCode, sandbox2)
  const requireNoUi = name => { if (name === 'react') return ReactStub; throw new Error('module not found: ' + name) }
  const mod2 = captured2.module
  const clientMod2 = (() => { try { return mod2.factory(requireNoUi) } catch (e) { failures.push('无 primitives 时 factory 抛错: ' + e.message); return null } })()
  ok('没有 primitives 也能产出模块', !!clientMod2)
  if (clientMod2) {
    const reg2 = []
    const ctx2 = {
      locale: { getSnapshot: () => ({ active: 'en' }) },
      effect: fn => { const c = fn(); return typeof c === 'function' ? c : undefined },
      get: () => undefined,
      slots: { inject: (name, f) => f(), register: (options, component) => { reg2.push({ options, component }) } },
    }
    let threw = null
    try { clientMod2.apply(ctx2) } catch (error) { threw = error }
    ok('没有 primitives 时 apply 不抛', threw === null, threw?.message)
    const menu2 = reg2.find(r => r.options.id === 'dsh-session-delete.delete')
    const rendered2 = menu2?.component({ sessionId: 'S-9', displayTitle: 'x' })
    ok('退化路径菜单行仍是 menuitem', rendered2?.props?.role === 'menuitem')
    ok('退化图标自带 svg', JSON.stringify(rendered2)?.includes('"svg"'), JSON.stringify(rendered2)?.slice(0, 80))
  }
}

// —— 旧版主机半场景：探测回 409 → 软删选项锁死、默认硬删 ——
{
  probeMode = 'legacy'
  const captured3 = {}
  const sandbox3 = Object.assign({}, sandbox, {
    window: { __ModuleLoader__: { load: m3 => { captured3.module = m3 } } },
  })
  sandbox3.globalThis = sandbox3
  vm.createContext(sandbox3)
  vm.runInContext(clientCode, sandbox3)
  const reg3 = []
  const ctx3 = {
    locale: { getSnapshot: () => ({ active: 'zh' }) },
    effect: () => undefined,
    get: () => undefined,
    slots: { inject: (name, f) => f(), register: (options, component) => { reg3.push({ options, component }) } },
  }
  captured3.module.factory(requireStub).apply(ctx3)
  const menu3 = reg3.find(r => r.options.id === 'dsh-session-delete.delete')
  const overlay3 = reg3.find(r => r.options.id === 'dsh-session-delete.confirm')
  menu3.component({ sessionId: 'S-7', displayTitle: '旧版测试' }).props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  const dialog3b = overlay3.component({})
  const radios3 = (function collect(node, out) {
    if (!node || typeof node !== 'object') return out
    if (node.props?.type === 'radio') out.push(node)
    for (const child of node.children ?? []) collect(child, out)
    return out
  })(dialog3b, [])
  ok('旧版主机半：软删选项被禁用', radios3.some(r => r.props.value === 'hide' && r.props.disabled === true), JSON.stringify(radios3.map(r => [r.props.value, r.props.disabled])))
  ok('旧版主机半：自动按硬删渲染（红色危险键）', radios3.some(r => r.props.value === 'permanent' && r.props.checked)
    && JSON.stringify(dialog3b).includes('dsh-sd-btn-danger'))
  probeMode = 'new'
}

// 卸载路径：cleanup 不抛，卸载后条目静默
{
  let threw = null
  try { cleanups.forEach(fn => fn()) } catch (error) { threw = error }
  ok('卸载 cleanup 不抛', threw === null, threw?.message)
  const beforeFetch = fetchCalls.length
  try { menuItem.component({ sessionId: 'S-3', displayTitle: 'X' }).props.onClick() } catch (error) { threw = error }
  ok('卸载后点击不再改变状态', threw === null && fetchCalls.length === beforeFetch, threw?.message)
}

console.log('')
if (failures.length) { console.log('FAIL ' + failures.length + ' 项：\n  - ' + failures.join('\n  - ')); process.exit(1) }
console.log('ALL PASS')
