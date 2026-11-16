> [!IMPORTANT]
> **本项目由 AI 辅助生成（AI-generated / AI-assisted）。**
> 代码与文档均经人工审阅与本机验证，但**可能**存在缺陷或不准确之处，使用前请自行复核。
>
> **免责声明：本项目不对正确性、稳定性、适销性或特定用途适用性作任何明示或默示担保。
> 使用本插件造成的任何直接或间接损失，作者与团队均不承担责任。
> 请自行评估风险，并优先遵守所在地区的法律法规与服务商协议。**
> 完整声明见 [DISCLAIMER.md](./DISCLAIMER.md)。

# dsh-session-delete 1.1.0 —— 左侧对话列表的“删除对话”（软删/硬删二选一）

只做一件事：**在左侧对话列表里删掉一个对话**。没有搜索、没有设置页。

## 界面上会出现什么

1. 行尾 “…” 菜单里一行红色**“删除对话”**（`sidebar.workspaces.session.menu.item`，order 700）——唯一入口，排在宿主"归档会话"（600）之后 = 菜单最后一行。
   1.0.0 的行尾 hover 垃圾桶按钮已按维护方 2026-11-13 要求去掉（对话名字右边那个不留）。
   红色靠两点：`.dsh-sd-danger` 排在 `.dsh-sd-menu-row` 之后 + `!important` 兜底宿主菜单样式。
   **注意**：DSH 不重启的话，进程里的主机半还是旧版（不认识 mode，会把软删当硬删）。
   浏览器半开弹层时先用假 id 探测一次（`mode:'__probe__'` → 新版必回 400 invalid-mode，不碰任何文件）：
   旧版则软删选项灰掉禁用、自动按硬删渲染；探测没回来前确认键按住。**完全退出 DSH 重开一次，软删才可用。**
2. 点它 → 弹出**二选一确认框**（`shell.overlay`），显示对话标题，默认选中软删：
   - **软删（隐藏）**：`POST`（`mode:'hide'`）。主机把会话目录整体 rename 出宿主扫描根，
     进同级 `%USERPROFILE%\.dsh\sessions-hidden\<项目>\<会话>\`。宿主只扫 `sessions\` 的子目录
     （0.2.2-rc.1 `dsh-session-persistence-jsonl` 的 `listProjectDirs` 已核），所以列表、搜索、
     归档界面**全都找不到它**；rename 不写字节，**zstd 历史文件零改动**，随时用
     `verify/restore-session.mjs` 搬回。**这不是宿主的“归档”**——归档只是列表分层、取消归档就回来；
     隐藏后宿主彻底看不见，只剩查文件一条路。
   - **硬删（永久）**：`POST`（`mode:'permanent'`），连历史文件一并删除，不可恢复。
3. 失败时原因留在框里，不静默。

硬删真正执行前，主机侧仍走 `src\host\delete-session.mjs` 那套保守流程：先停运行中的 agent、身份复核（`sameHeader`）、路径 confinement（拒绝符号链接与穿越）、只认 `{kind:'jsonl'}` 存储、暂存后再清理，失败语义为 `storage-partial` / `storage-state-unknown`（**不会**当成删除成功）。

## 怎么装

DSH **不扫** `plugins\` 目录 —— 光把文件夹放进去、不注册，永远不会加载。
三条都要做，缺一不加载：

```text
① 把整个包拷到  %USERPROFILE%\.dsh\plugins\dsh-session-delete\
② 在 profile 的 package.json 里加一行：
     "dsh-session-delete": "link:C:/Users/<你的用户名>/.dsh/plugins/dsh-session-delete"
③ 在 profile 的 package.json 的 dsh.profile.bundles 数组末尾加 "dsh-session-delete"
   并且**移除** "dsh-chat-manager" —— 它注册同一条路由，两个一起开必撞
然后在 profile 目录跑一次 pnpm install，让它建好 node_modules 链接
```

> profile 目录看 `~\.dsh\profiles\` 下有哪些文件夹，通常就一个。
> 装完**多数情况不用重启** —— 2026-11-07 实测左侧垃圾桶当场就出现。
> 哪天装完看不见，再完全退出 DSH 重开一次。
>
> 备好旧版备份再装更稳：
> ```powershell
> Copy-Item -Recurse -Force $env:USERPROFILE\.dsh\plugins\dsh-session-delete `
>            $env:USERPROFILE\.dsh\plugins\_bak\dsh-session-delete-<日期>
> ```

### 回退（退回 1.0.0 纯硬删版）

```powershell
Remove-Item -Recurse -Force $env:USERPROFILE\.dsh\plugins\dsh-session-delete
Copy-Item  -Recurse -Force $env:USERPROFILE\.dsh\plugins\_bak\dsh-session-delete-<日期> $env:USERPROFILE\.dsh\plugins\dsh-session-delete
```

## 自测（不连 DSH）

```powershell
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" verify\selftest.mjs
```

49 条断言全绿：包声明、路由注册与 405/403/400/非法 mode 边界、hide 模式只调 retireDirectory 不调 rm（真实临时目录走完整保守流程）、槽位挂载（含"不再挂 hover 垃圾桶行"与"菜单行红色"）、软删发 `POST mode:'hide'`、硬删发 `POST mode:'permanent'`（均带 `x-dsh-session-delete-confirmation: delete-session`）、动的正好是当前打开的对话才清空视图、失败留原因、**取不到宿主 primitives 图标时退化自带 svg**、卸载后条目静默。

## 找回被软删（隐藏）的对话

```powershell
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" verify\restore-session.mjs            # 列出隐藏区
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" verify\restore-session.mjs <会话目录名> # 搬回原位
```

## 为什么上一版在界面上看不见（本次排查结论）

| 症状 | 证据 |
|---|---|
| 10/31 那次装完就没了 | `.plugin-manager\logs\operation-mU9Dhi\pnpm.log`：`- dsh-session-delete`，依赖被删；profile `package.json` 的 deps/bundles 里现在也没有它 → 根本没加载 |
| 就算装回去也不显示 | 旧 `lib/client.js` 是 **ESM（`export function ...`）**，而 `./client` 导出指向它；宿主把浏览器半当脚本装载，`export` 直接语法不过 → 三个槽位一个都没注册。根 `lib/client.js` 还 `require("dsh-session-delete/client")`，而这个包名不在 `dsh.client.inject` 授权表里，同样起不来 |
| 版本对不上 | 本机是 DSH `0.2.2-rc.1`（`DeepSeek Harness.exe` FileVersion 0.2.2-rc.1），`dsh-chat-manager` 只测到 `0.2.2-alpha.3` |
| 槽位本身没变 | 从 app.asar 取出的 `dsh-client-ui-workspace@0.2.2-rc.1` 仍声明 `sidebar.workspaces.session.menu.item` / `.row.action` / `shell.overlay`；`dsh-cordis-client-runner` 的服务目录里 `slots/locale/sessions/workspaces/uiWorkspace` 都在 |

本版按 0.2.2-rc.1 的实际契约重写：`window.__ModuleLoader__.load({ id: 'dsh-session-delete', factory })`（id = 包名），`dsh.client = { platform:"web", immediately:true, inject:["@deepseek-ai/dsh-client-ui-primitives"] }`，弹层不依赖宿主私有组件（自带 CSS，只用宿主 CSS 变量 + 兜底值），图标取不到时退化成字形。

## 风险

- **损坏 transcript 的会话**（2026-11-13 实测：`session-<某会话>…` stored log is corrupt: SessionFormatError）：持久化句柄打不开，原保守流程只能停在 `storage-state-unknown`。本版加物理兜底 `physicallyRemoveCorruptSession`：仅当错误含 corrupt/SessionFormatError 时触发，要求在扫描根下**目录名 === sessionId 的唯一匹配**、内含 `session*.jsonl(.zstd)`、暂存搬移 + sameFile 身份复核全过才动手；任何一步拿不准回到原保守失败。硬删=删目录，软删=同样暂存后搬去隐藏区，文件字节零改动。
- 主机半是 Node 侧代码，**改了必须完全退出 DSH 重开**才生效（2026-11-13 教训：维护方实测时进程里跑的还是旧版，浏览器半的能力探测因此会锁死软删选项）。浏览器半改动刷新页面即可。
- 删掉的对话不可恢复（软删可用 `verify/restore-session.mjs` 找回）。当前正在聊的这条也能被删（确认后本视图清空，回到欢迎页）。
