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
// dsh-session-delete 1.1.0 — 主机半：注册一条“删除会话”路由，两种模式：
//   mode:'permanent'（硬删）——实现沿用 dsh-chat-manager (MIT, WSL043) 的
//     src/host/delete-session.mjs，安全边界未动（请求体上限、身份复核 sameHeader、
//     路径 confinement、符号链接拒绝、agent handle 预留、storage-partial 等保守失败语义）。
//   mode:'hide'（软删）——同一条保守流程，只把最后一步 rm 换成 retireDirectory：
//     把已暂存、已复核身份的会话目录 rename 出 sessionPersistence 扫描根，进同级
//     `sessions-hidden\<项目>\` 隐藏区。宿主只扫根目录的子目录（已核 0.2.2-rc.1
//     dsh-session-persistence-jsonl 的 listProjectDirs），所以界面/搜索都找不到它；
//     rename 不写文件内容，zstd 历史原样，可随时用 restore-session.mjs 搬回。

import { mkdir, rename } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import {
  createDeleteRequestHandler,
  deleteSessionSafely,
  hostRequestFence,
  installAgentHandleTracker,
  sameOriginRequest,
} from './host/delete-session.mjs'

export const name = 'dsh-session-delete'
export const inject = ['webServer', 'sessionPersistence', 'sessions', 'agents']

const ROUTE_PATH = '/plugins/dsh-session-delete/delete'

/** 未声明的服务用 ctx.get 取，取不到就返回 undefined（Cordis 对未注入键会抛）。 */
function tryGet(ctx, key) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(key) : undefined
  } catch {
    return undefined
  }
}

/** agent 句柄跟踪装不上时的空转替身：删除仍走同一条保守路径，只是不接管 create/resume。 */
const idleHandles = {
  reserve: () => () => {},
  dispose: async () => false,
  release: () => Promise.resolve(),
}

/** 软删（hide）落点：扫描根同级的 sessions-hidden\<项目>\。宿主只扫根的子目录，这里它看不见。 */
const hiddenDirectory = (sessionRoot, project) => {
  const safeProject = project.replace(/[^A-Za-z0-9._-]/g, '_')
  return join(dirname(sessionRoot), 'sessions-hidden', safeProject)
}

/** 把已暂存复核过的会话目录搬进隐藏区；重名（曾隐藏过同名会话）就加时间戳后缀。 */
async function retireToHidden(quarantinedDirectory, { project }, sessionRoot) {
  const target = join(hiddenDirectory(sessionRoot, project), basename(quarantinedDirectory))
  await mkdir(dirname(target), { recursive: true })
  try {
    await rename(quarantinedDirectory, target)
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error
    await rename(quarantinedDirectory, `${target}.${new Date().toISOString().replace(/[:.]/g, '-')}`)
  }
}

export function apply(ctx) {
  const persistence = ctx.sessionPersistence
  const sessionRoot = persistence?.config?.root ?? persistence?.root
  if (typeof sessionRoot !== 'string' || sessionRoot.length === 0) {
    console.warn('[dsh-session-delete] 没找到 sessionPersistence 的 JSONL 根目录，删除路由不注册。')
    return
  }

  let agentHandles = idleHandles
  try {
    agentHandles = installAgentHandleTracker(ctx.agents, ctx.sessions)
  } catch (error) {
    console.warn('[dsh-session-delete] agent 句柄跟踪安装失败，运行中的对话将被拒绝删除：', error?.message ?? error)
  }
  ctx.effect(() => () => agentHandles.release(), 'dsh-session-delete: agent lifecycle tracking')

  const deleteSession = (sessionId, mode) => deleteSessionSafely({
    sessions: ctx.sessions,
    agents: ctx.agents,
    agentHandles,
    sessionPersistence: persistence,
    retireDirectory: mode === 'hide'
      ? (directory, info) => retireToHidden(directory, info, sessionRoot)
      : undefined,
  }, { sessionRoot, sessionId, mode })

  // connection 可能在别的插件之后才注册：按请求解析，别在 apply 期固化。
  const isTrustedRequest = req => hostRequestFence(tryGet(ctx, 'connection'))(req)
    || sameOriginRequest(req)

  const handler = createDeleteRequestHandler({ isTrustedRequest, deleteSession })

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler }),
    'dsh-session-delete: confirmed permanent deletion route',
  )
}

export {
  createDeleteRequestHandler,
  deleteColdSession,
  deleteSessionSafely,
  installAgentHandleTracker,
} from './host/delete-session.mjs'
