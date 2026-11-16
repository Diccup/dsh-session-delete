# Changelog

本文件记录 dsh-session-delete 的显著变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0] - 2026-11-16

### 新增

- **软删（隐藏）模式**：会话目录整体 rename 出宿主扫描根，进 `sessions-hidden\<项目>\`。
  zstd 历史文件零改动，可用 `verify/restore-session.mjs` 随时搬回。
- 损坏 transcript 的物理兜底 `physicallyRemoveCorruptSession`：
  仅当错误含 corrupt / SessionFormatError 时触发，且要求扫描根下目录名 === sessionId
  的唯一匹配、内含 `session*.jsonl(.zstd)`、暂存搬移 + sameFile 身份复核全过才动手。
- 二选一确认弹层（软删默认选中）。

### 变更

- **发布版可移植化**：`verify/restore-session.mjs` 的会话根改由 `DSH_SESSION_ROOT`
  或当前用户家目录推导；离线自测的假会话根改走系统临时目录。
  （此前写死开发机路径，别人机器上找不到会话目录。）

## [1.0.0] - 2026-11-07

### 新增

- 首个版本：左侧对话列表行尾菜单里的"删除对话"，硬删（永久）一种模式。
