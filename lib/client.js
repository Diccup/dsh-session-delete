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
// dsh-session-delete 1.1.0 — 浏览器半（DSH 0.2.2-rc.1 官方槽位，纯 JS，无 JSX）
//
// 只做一件事：在左侧对话列表里删掉一个对话。
//   1) sidebar.workspaces.session.menu.item   —— 条目 “...” 菜单里的“删除对话”行（红色）
//   2) shell.overlay                          —— 确认弹层，里面二选一：
//        · 软删（隐藏）= POST mode:'hide'：主机把会话目录整体搬出宿主扫描根，
//          进同级 sessions-hidden\ 隐藏区。界面/搜索/归档列表都找不到它，
//          文件内容零改动（rename 不写字节），zstd 历史原样可查、可搬回。
//          —— 和宿主自带“归档”不是一回事：归档只是列表分层，取消归档就回来；
//          隐藏后宿主彻底看不见。
//        · 硬删（永久）= POST mode:'permanent'：连历史文件一并删除，不可恢复。
// 1.0.0 的行尾 hover 垃圾桶按钮已按需求方要求去掉，只留下拉菜单这一处入口。
// 不写 DOM、不替换工作区、不加第二个应用根。
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory: function (require) {
    var React = require('react')
    var ui = null
    try { ui = require('@deepseek-ai/dsh-client-ui-primitives') } catch (error) { ui = null }

    var h = React.createElement
    var ROUTE = '/plugins/dsh-session-delete/delete'
    var CSS_ID = 'dsh-session-delete-style'

    // ---------- 共享状态（菜单条目与弹层共用，弹层只有一个） ----------
    var listeners = new Set()
    var state = { target: null, mode: 'hide', busy: false, error: '' }
    var disposed = false
    var controller = new AbortController()

    // 主机半能力探测：DSH 不重启的话，进程里跑的还是旧版主机半 —— 旧版不认识
    // mode，会把软删当硬删执行（2026-11-13 实测：非法 mode 不报 400）。
    // 探测 = 用假 id 发一枪：新版必回 400 invalid-mode（假 id 碰不到任何文件），
    // 旧版回 200/409。探测结果没出来之前，两个确认键都先按住。
    var PROBE_BODY = JSON.stringify({ sessionId: '__dsh-session-delete-probe__', mode: '__probe__' })
    var hostSupport = null   // null=未知/未探, true=新版, false=旧版（软删禁用）
    var probing = false
    function probeHost() {
      if (disposed || probing || hostSupport !== null) return
      probing = true
      fetch(ROUTE, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-dsh-session-delete-confirmation': 'delete-session',
        },
        body: PROBE_BODY,
      }).then(function (response) {
        return response.json().catch(function () { return null }).then(function (result) {
          return { status: response.status, result: result }
        })
      }).then(function (outcome) {
        probing = false
        if (disposed) return
        hostSupport = outcome.status === 400 && outcome.result && outcome.result.error
          && outcome.result.error.code === 'invalid-mode'
        publish({})
      }).catch(function () {
        probing = false
        // 网络失败：留未知，下次开弹层再探；确认键保持按住，宁慢不错删。
      })
    }

    function publish(patch) {
      if (disposed) return
      state = Object.assign({}, state, patch)
      listeners.forEach(function (notify) { notify() })
    }
    function subscribe(notify) {
      listeners.add(notify)
      return function () { listeners.delete(notify) }
    }
    function snapshot() { return state }

    // ---------- 文案（跟随宿主语言，取不到就中文） ----------
    var lang = 'zh'
    function readLang(ctx) {
      try {
        var active = ctx.locale && ctx.locale.getSnapshot && ctx.locale.getSnapshot().active
        if (typeof active === 'string') lang = active
      } catch (error) { /* 语言服务不可用：保持默认 */ }
    }
    function text(zh, en) { return lang.indexOf('zh') === 0 ? zh : en }

    // ---------- 删除动作 ----------
    function service(ctx, key) {
      try { return typeof ctx.get === 'function' ? ctx.get(key) : undefined } catch (error) { return undefined }
    }

    // 软删/硬删共用一条请求路径，mode 决定主机侧搬走还是删掉。
    async function performDelete(ctx, mode) {
      if (disposed || state.busy || !state.target) return
      var target = state.target
      var hide = mode === 'hide'
      publish({ busy: true, error: '' })
      try {
        var response = await fetch(ROUTE, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'x-dsh-session-delete-confirmation': 'delete-session',
          },
          body: JSON.stringify({ sessionId: target.id, mode: mode }),
        })
        var result = await response.json().catch(function () { return null })
        if (!response.ok || !result || result.ok !== true) {
          var message = (result && result.error && result.error.message) || ('HTTP ' + response.status)
          throw new Error(message)
        }
        if (disposed) return

        // 动的正好是当前打开的对话：只清这一个视图，绝不动别的视图。
        var workspace = service(ctx, 'uiWorkspace')
        try {
          var selected = workspace && workspace.selection && workspace.selection.getSnapshot
            && workspace.selection.getSnapshot().sessionId
          if (selected === target.id && typeof workspace.clearMain === 'function') workspace.clearMain()
        } catch (error) { /* 主机事件通常已经把该行移走了 */ }

        // 刷新是锦上添花：老 store 才有 refresh()，新版靠主机事件推送。
        var stores = [service(ctx, 'sessions'), service(ctx, 'workspaces')]
        var refreshes = await Promise.allSettled(stores.map(function (store) {
          return store && typeof store.refresh === 'function' ? store.refresh() : Promise.resolve()
        }))
        publish({ target: null, error: '' })
        refreshes.forEach(function (item) {
          if (item.status === 'rejected') console.warn('[dsh-session-delete] 已处理，列表刷新失败：', item.reason)
        })
      } catch (error) {
        if (disposed) return
        publish({ busy: false, error: (error && error.message) || String(error) })
      } finally {
        if (!disposed) publish({ busy: false })
      }
    }

    function requestOpen(target) {
      if (disposed || state.busy) return
      publish({ target: target, mode: 'hide', error: '' })
      probeHost()
    }

    // ---------- 图标 ----------
    function icon() {
      if (ui && typeof ui.IconTrashOutlineRegular === 'function') {
        try { return h(ui.IconTrashOutlineRegular, { size: 16 }) } catch (error) { /* 落到自带图标 */ }
      }
      // 宿主图标取不到时自带一只垃圾桶：只吃 currentColor，不引外部资源。
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', 'aria-hidden': 'true',
        style: { display: 'block' },
      },
        h('path', { d: 'M4 7h16' }),
        h('path', { d: 'M9.5 7V4.5h5V7' }),
        h('path', { d: 'M6.5 7 7.6 20h8.8L17.5 7' }),
        h('path', { d: 'M10 11v5.5M14 11v5.5' }))
    }

    // ---------- 条目：“...” 菜单里的删除行（唯一入口） ----------
    function MenuRow(props) {
      var sessionId = props.sessionId
      var displayTitle = props.displayTitle
      var setMenuOpen = null
      try {
        var pair = props.useMenuOpenState ? props.useMenuOpenState() : null
        setMenuOpen = pair && pair[1]
      } catch (error) { setMenuOpen = null }
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dsh-sd-menu-row dsh-sd-danger',
        onClick: function () {
          if (typeof setMenuOpen === 'function') { try { setMenuOpen(false) } catch (error) {} }
          requestOpen({ id: sessionId, title: displayTitle || sessionId })
        },
      }, icon(), h('span', null, text('删除对话', 'Delete session')))
    }

    // ---------- 弹层：软删 / 硬删 二选一确认 ----------
    function ModeOption(current, mode, label, desc, disabled, selected) {
      return h('label', {
        className: 'dsh-sd-option' + (selected ? ' dsh-sd-option-on' : '') + (disabled ? ' dsh-sd-option-off' : ''),
      },
        h('input', {
          type: 'radio',
          name: 'dsh-sd-mode',
          value: mode,
          checked: selected,
          disabled: current.busy || disabled,
          onChange: function () { publish({ mode: mode, error: '' }) },
        }),
        h('span', { className: 'dsh-sd-option-text' },
          h('span', { className: 'dsh-sd-option-label' }, label),
          h('span', { className: 'dsh-sd-option-desc' }, desc)))
    }

    function ConfirmOverlay(ctx) {
      var current = React.useSyncExternalStore(subscribe, snapshot, snapshot)
      if (!current.target) return null
      function close() { if (!current.busy) publish({ target: null, error: '' }) }
      // 旧版主机半不认识 mode：软删会被它当硬删执行，必须锁死，只留硬删。
      var legacy = hostSupport === false
      var unknown = hostSupport === null
      // 渲染期不改 store：legacy 时直接按硬删渲染（选项已 disabled，用户点不到 hide）。
      var permanent = legacy || current.mode === 'permanent'
      return h('div', {
        className: 'dsh-sd-backdrop',
        onMouseDown: function (event) { if (event.target === event.currentTarget) close() },
      },
        h('div', {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': text('删除对话', 'Delete session'),
          className: 'dsh-sd-panel',
        },
          h('div', { className: 'dsh-sd-title' }, text('删除这个对话？', 'Delete this session?')),
          h('p', { className: 'dsh-sd-subtitle' }, current.target.title),
          ModeOption(current, 'hide',
            text('软删（隐藏）', 'Soft delete (hide)'),
            legacy
              ? text('当前运行的主机半是旧版，会把隐藏当永久删除执行——完全退出 DSH 重开后此选项可用。',
                'The running host half is legacy and would treat hide as permanent deletion. Restart DSH to enable this option.')
              : text('对话目录搬出宿主存储区，列表、搜索、归档里都再也找不到；文件内容零改动，ZSTD 历史原样可查。',
                'The session directory moves out of host storage: gone from lists, search, and archive. Files untouched, ZSTD history still readable.'),
            legacy, !legacy && current.mode === 'hide'),
          ModeOption(current, 'permanent',
            text('硬删（永久）', 'Hard delete (permanent)'),
            text('连同本机历史文件一起删除，无法恢复。',
              'Removes local history files too. Cannot be recovered.'), false, permanent),
          h('p', { className: 'dsh-sd-note' },
            text('该对话若正在运行，会先停止它。',
              'Running work for this session is stopped first.')),
          current.error ? h('p', { role: 'alert', className: 'dsh-sd-error' }, current.error) : null,
          h('div', { className: 'dsh-sd-actions' },
            h('button', {
              type: 'button', className: 'dsh-sd-btn', disabled: current.busy, onClick: close,
            }, text('取消', 'Cancel')),
            h('button', {
              type: 'button',
              className: permanent ? 'dsh-sd-btn dsh-sd-btn-danger' : 'dsh-sd-btn dsh-sd-btn-primary',
              disabled: current.busy || unknown,
              onClick: function () { void performDelete(ctx, current.mode) },
            }, current.busy
              ? (permanent ? text('正在删除…', 'Deleting…') : text('正在隐藏…', 'Hiding…'))
              : unknown
                ? text('正在确认主机能力…', 'Checking host capability…')
                : (permanent ? text('确认永久删除', 'Confirm permanent deletion')
                  : text('确认软删（隐藏）', 'Confirm soft delete'))))))
    }

    // ---------- 注册 ----------
    return {
      inject: ['slots', 'locale'],
      apply: function (ctx) {
        readLang(ctx)

        ctx.effect(function () {
          var style = document.createElement('style')
          style.id = CSS_ID
          style.textContent = [
            '.dsh-sd-menu-row{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:0;border-radius:var(--dsw-radius-md,6px);background:transparent;color:var(--dsw-alias-label-primary,#eee);font:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}',
            '.dsh-sd-menu-row:hover{background:var(--dsw-alias-bg-hover,rgba(128,128,128,.14))}',
            // danger 必须排在 menu-row 之后：同优先级选择器，后来者赢，菜单行才是红的。
            '.dsh-sd-danger{color:var(--dsw-alias-state-error-primary,#e5484d) !important}',
            '.dsh-sd-backdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.45);pointer-events:auto;z-index:2147483000}',
            '.dsh-sd-panel{box-sizing:border-box;width:min(460px,100%);display:grid;gap:10px;padding:18px;border-radius:var(--dsw-radius-xl,12px);border:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-bg-base,#1f1f1f);color:var(--dsw-alias-label-primary,#eee);box-shadow:0 18px 48px rgba(0,0,0,.45)}',
            '.dsh-sd-title{font-size:16px;line-height:24px;font-weight:500}',
            '.dsh-sd-subtitle{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#eee);overflow-wrap:anywhere}',
            '.dsh-sd-option{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));cursor:pointer}',
            '.dsh-sd-option-on{border-color:var(--dsw-alias-border-l3,rgba(128,128,128,.55));background:var(--dsw-alias-bg-hover,rgba(128,128,128,.10))}',
            '.dsh-sd-option-off{opacity:.55;cursor:not-allowed}',
            '.dsh-sd-option input{margin:4px 0 0;accent-color:var(--dsw-alias-accent-primary,#4f8cff)}',
            '.dsh-sd-option-text{display:grid;gap:2px}',
            '.dsh-sd-option-label{font-size:14px;line-height:22px}',
            '.dsh-sd-option-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}',
            '.dsh-sd-note{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}',
            '.dsh-sd-error{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary,#e5484d)}',
            '.dsh-sd-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}',
            '.dsh-sd-btn{padding:6px 14px;border-radius:var(--dsw-radius-md,6px);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-primary,#eee);font:inherit;font-size:14px;line-height:22px;cursor:pointer}',
            '.dsh-sd-btn:hover:not(:disabled){background:var(--dsw-alias-bg-hover,rgba(128,128,128,.14))}',
            '.dsh-sd-btn:disabled{opacity:.55;cursor:default}',
            '.dsh-sd-btn-danger{border-color:var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-state-error-primary,#e5484d)}',
            '.dsh-sd-btn-primary{border-color:var(--dsw-alias-accent-primary,#4f8cff);color:var(--dsw-alias-accent-primary,#4f8cff)}',
          ].join('')
          document.head.appendChild(style)
          return function () { style.remove() }
        }, 'dsh-session-delete: dialog style')

        ctx.effect(function () {
          return function () {
            disposed = true
            controller.abort()
            listeners.clear()
          }
        }, 'dsh-session-delete: deletion overlay lifecycle')

        ctx.slots.inject('sidebar.workspaces.session.menu.item', function () {
          ctx.slots.register({
            name: 'sidebar.workspaces.session.menu.item',
            id: 'dsh-session-delete.delete',
            // 宿主菜单 order：置顶100/重命名200/分叉300/复制ID 450/归档600（已核源码）。
            // 700 = 排最后，符合"危险操作放末尾"的惯例（维护方 2026-11-13 点名）。
            order: 700,
          }, MenuRow)
        })

        ctx.slots.inject('shell.overlay', function () {
          ctx.slots.register({
            name: 'shell.overlay',
            id: 'dsh-session-delete.confirm',
          }, function () { return ConfirmOverlay(ctx) })
        })
      },
    }
  },
})
