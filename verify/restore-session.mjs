#!/usr/bin/env node
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
// restore-session.mjs — 把软删（hide）藏进 sessions-hidden\ 的会话目录搬回宿主扫描根。
// 文件内容全程零改动：只是 rename 整目录。
//
// 跑法（DSH 自带 Node）：
//   node restore-session.mjs                 → 列出隐藏区里所有可恢复的会话目录
//   node restore-session.mjs <会话目录名>    → 搬回原项目路径（同名冲突则拒绝，不动任何文件）
//
// 例：node restore-session.mjs 01J9XYZABC
// 退出码：0 成功 / 1 找不到 / 2 目标冲突未动 / 3 参数或环境错误
import { lstat, readdir, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

// ★ 发布版可移植化（2026-11-16）：原写死 `C:\Users\Diccup\.dsh\sessions`。
//   现在按当前用户家目录推，也可用环境变量 DSH_SESSION_ROOT 覆盖。
const sessionRoot = resolve(
  process.env.DSH_SESSION_ROOT ?? join(homedir(), '.dsh', 'sessions'),
)
const hiddenRoot = join(dirname(sessionRoot), 'sessions-hidden')
const wanted = process.argv[2]

const projects = []
try {
  for (const entry of await readdir(hiddenRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) projects.push(entry.name)
  }
} catch (error) {
  if (error?.code === 'ENOENT') { console.log('隐藏区为空：' + hiddenRoot); process.exit(1) }
  throw error
}

if (wanted === undefined) {
  let any = false
  for (const project of projects) {
    for (const entry of await readdir(join(hiddenRoot, project), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      any = true
      console.log(`${project}/${entry.name}`)
    }
  }
  if (!any) console.log('隐藏区为空：' + hiddenRoot)
  else console.log('\n恢复：node restore-session.mjs <会话目录名>')
  process.exit(0)
}

// 在隐藏区里找 <会话目录名>（可带 .时间戳 后缀，hide 重名时加的）
let found = null
for (const project of projects) {
  const entries = await readdir(join(hiddenRoot, project), { withFileTypes: true })
  const hit = entries.find(e => e.isDirectory() && (e.name === wanted || e.name.startsWith(wanted + '.')))
  if (hit) { found = { project, name: hit.name }; break }
}
if (found === null) { console.error('找不到：' + wanted); process.exit(1) }

// 原项目名是被 sanitize 过的（非 [A-Za-z0-9._-] 换成 _），按同样规则匹配扫描根里的项目目录
const rootProjects = (await readdir(sessionRoot, { withFileTypes: true }))
  .filter(e => e.isDirectory()).map(e => e.name)
const targetProject = rootProjects.find(p => p.replace(/[^A-Za-z0-9._-]/g, '_') === found.project) ?? found.project
const target = join(sessionRoot, targetProject, wanted)
try { await lstat(target); console.error('目标已存在，未动任何文件：' + target); process.exit(2) }
catch (error) { if (error?.code !== 'ENOENT') throw error }

await rename(join(hiddenRoot, found.project, found.name), target)
console.log('已恢复：' + target)
console.log('重启/刷新 DSH 后该对话回到左侧列表。')
