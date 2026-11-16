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
import { lstat, mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const failure = (code, message) => ({ ok: false, error: { code, message } })
const MAX_REQUEST_BYTES = 8 * 1024

/**
 * Retain the lifecycle capabilities returned by the public AgentRegistry API.
 * DSH intentionally exposes only a bare Agent from get(); deletion needs the
 * original handle so the host can cancel, drain, unregister, and detach in its
 * own supported order.
 */
export function installAgentHandleTracker(agents, sessions) {
  // Cordis supplies a context-local service proxy. Assigning methods through
  // that proxy only shadows them for this plugin; the official session
  // controller keeps calling the shared service. Patch the original service
  // so calls from every owner context are observed, while Reflect.apply below
  // retains the caller's receiver and therefore its lifecycle ownership.
  const originalSymbol = Symbol.for('cordis.original')
  const wrapperOrigin = Symbol.for('dsh-chat-manager.agent-tracker-origin')
  const agentService = agents[originalSymbol] ?? agents
  const sessionService = sessions?.[originalSymbol] ?? sessions
  const handles = new Map()
  const reservations = new Set()
  let released = false
  const originalCreate = agentService.create
  const originalResume = agentService.resume
  const originalAgentEnter = agentService.enter
  const originalSessionEnter = sessionService?.enter

  const assertAvailable = (sessionId) => {
    if (released) return
    if (typeof sessionId === 'string' && reservations.has(sessionId)) {
      throw new Error(`session "${sessionId}" is being permanently deleted`)
    }
  }

  const track = (handle) => {
    if (!released && handle?.agent?.id !== undefined && typeof handle.dispose === 'function') {
      handles.set(handle.agent.id, handle)
    }
    return handle
  }
  const wrappedCreate = async function (...args) {
    assertAvailable(args[0]?.sessionId)
    return track(await Reflect.apply(originalCreate, this, args))
  }
  const wrappedResume = async function (...args) {
    assertAvailable(args[0]?.resumeSessionId)
    return track(await Reflect.apply(originalResume, this, args))
  }
  const wrappedAgentEnter = typeof originalAgentEnter === 'function'
    ? function (...args) {
        assertAvailable(args[0]?.id)
        return Reflect.apply(originalAgentEnter, this, args)
      }
    : undefined
  const wrappedSessionEnter = typeof originalSessionEnter === 'function'
    ? function (...args) {
        assertAvailable(args[0]?.id)
        return Reflect.apply(originalSessionEnter, this, args)
      }
    : undefined

  // A plugin reload may install a new tracker while an old deletion still
  // drains. Once both release, remove every inactive wrapper in that stack.
  const unwrapReleased = (method) => {
    while (method?.[wrapperOrigin]?.released()) method = method[wrapperOrigin].original
    return method
  }
  for (const [wrapped, original] of [
    [wrappedCreate, originalCreate], [wrappedResume, originalResume],
    [wrappedAgentEnter, originalAgentEnter], [wrappedSessionEnter, originalSessionEnter],
  ]) {
    if (wrapped) Object.defineProperty(wrapped, wrapperOrigin, { value: { original, released: () => released } })
  }

  agentService.create = wrappedCreate
  agentService.resume = wrappedResume
  if (wrappedAgentEnter !== undefined) agentService.enter = wrappedAgentEnter
  if (wrappedSessionEnter !== undefined) sessionService.enter = wrappedSessionEnter
  let releaseStarted = false
  let resolveRelease
  let releaseTask

  const finishRelease = () => {
    if (!releaseStarted || released || reservations.size !== 0) return
    released = true
    handles.clear()
    if (agentService.create === wrappedCreate) agentService.create = unwrapReleased(originalCreate)
    if (agentService.resume === wrappedResume) agentService.resume = unwrapReleased(originalResume)
    if (wrappedAgentEnter !== undefined && agentService.enter === wrappedAgentEnter) agentService.enter = unwrapReleased(originalAgentEnter)
    if (wrappedSessionEnter !== undefined && sessionService.enter === wrappedSessionEnter) sessionService.enter = unwrapReleased(originalSessionEnter)
    resolveRelease?.()
  }

  return {
    reserve(sessionId) {
      if (releaseStarted || reservations.has(sessionId)) return undefined
      reservations.add(sessionId)
      let active = true
      return () => {
        if (!active) return
        active = false
        reservations.delete(sessionId)
        finishRelease()
      }
    },
    async dispose(sessionId) {
      const handle = handles.get(sessionId)
      if (handle === undefined || agents.get(sessionId) !== handle.agent) {
        handles.delete(sessionId)
        return false
      }
      await handle.dispose()
      handles.delete(sessionId)
      return true
    },
    release() {
      if (released) return releaseTask
      if (!releaseStarted) {
        releaseStarted = true
        releaseTask = new Promise(resolve => { resolveRelease = resolve })
        finishRelease()
      }
      return releaseTask
    },
  }
}

const sendJson = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

const readJsonBody = async (req) => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new Error('request-too-large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const sameHeader = (left, right) => (
  left?.id === right?.id
  && left?.version === right?.version
  && left?.createdAt === right?.createdAt
  && left?.cwd === right?.cwd
  && left?.parentSession === right?.parentSession
  && left?.seedLength === right?.seedLength
  && left?.origin === right?.origin
  && (left?.delegationDepth ?? 0) === (right?.delegationDepth ?? 0)
  && left?.agentPreset === right?.agentPreset
  && left?.isSeeded === right?.isSeeded
)

const inside = (root, target) => {
  const path = relative(root, target)
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)
}

const missing = error => error?.code === 'ENOENT'

const sameFile = (left, right) => (
  left.dev === right.dev
  && left.ino === right.ino
  && left.mode === right.mode
  && left.size === right.size
  && left.birthtimeNs === right.birthtimeNs
)

const locationPaths = (sessionRoot, location) => {
  if (location?.kind !== 'jsonl' || typeof location.path !== 'string') return undefined
  const root = resolve(sessionRoot)
  const transcript = resolve(location.path)
  if (!isAbsolute(root) || !isAbsolute(transcript) || !inside(root, transcript)) return undefined
  const parts = relative(root, transcript).split(sep).filter(Boolean)
  if (parts.length !== 3 || !/^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(parts[2])) return undefined
  return {
    root,
    projectDirectory: join(root, parts[0]),
    sessionDirectory: join(root, parts[0], parts[1]),
    transcript,
  }
}

const validateExistingLocation = async (paths) => {
  const [root, project, directory, transcript] = await Promise.all([
    realpath(paths.root),
    lstat(paths.projectDirectory, { bigint: true }),
    lstat(paths.sessionDirectory, { bigint: true }),
    lstat(paths.transcript, { bigint: true }),
  ])
  if (
    !project.isDirectory()
    || project.isSymbolicLink()
    || !directory.isDirectory()
    || directory.isSymbolicLink()
    || !transcript.isFile()
    || transcript.isSymbolicLink()
  ) return undefined

  const [resolvedProject, resolvedDirectory, resolvedTranscript] = await Promise.all([
    realpath(paths.projectDirectory),
    realpath(paths.sessionDirectory),
    realpath(paths.transcript),
  ])
  if (
    !inside(root, resolvedProject)
    || !inside(root, resolvedDirectory)
    || dirname(resolvedTranscript) !== resolvedDirectory
  ) return undefined
  return { root, resolvedDirectory, directory, transcript }
}

const pathExists = async (path) => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

/**
 * 2026-11-13 实测：损坏 transcript（SessionFormatError）的会话打不开持久化
 * 句柄，保守流程只能停在 storage-state-unknown。物理兜底：在扫描根下找目录名
 * === sessionId 的唯一目录，确认内含 session*.jsonl(.zstd)，暂存搬移 + sameFile
 * 身份复核后按 mode 搬去隐藏区或删除。任何一步不确定都返回 undefined，
 * 让调用方维持原有的保守失败，绝不猜着删。
 */
async function physicallyRemoveCorruptSession(deps, { sessionRoot, sessionId, mode }) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return undefined
  if (deps.sessions.get(sessionId) !== undefined || deps.agents.get(sessionId) !== undefined) return undefined
  let projects
  try { projects = await readdir(sessionRoot, { withFileTypes: true }) } catch { return undefined }
  const matches = []
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue
    const projectDir = join(sessionRoot, project.name)
    let entries
    try { entries = await readdir(projectDir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name === sessionId) {
        matches.push({ project: project.name, sessionDir: join(projectDir, entry.name) })
      }
    }
  }
  if (matches.length !== 1) return undefined
  const { project, sessionDir } = matches[0]
  let files
  try { files = await readdir(sessionDir) } catch { return undefined }
  if (!files.some(name => /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(name))) return undefined
  let before
  try { before = await lstat(sessionDir, { bigint: true }) } catch { return undefined }
  if (!before.isDirectory() || before.isSymbolicLink()) return undefined

  let quarantineRoot
  let quarantined
  try {
    quarantineRoot = await mkdtemp(join(dirname(resolve(sessionRoot)), '.dsh-session-delete-'))
    quarantined = join(quarantineRoot, sessionId)
    await rename(sessionDir, quarantined)
    const after = await lstat(quarantined, { bigint: true })
    if (after.isSymbolicLink() || !sameFile(before, after)) {
      await rename(quarantined, sessionDir)
      await rm(quarantineRoot, { recursive: true, force: true })
      return failure('unsafe-location', '损坏会话目录在搬移期间发生身份变化，未删除任何文件。')
    }
    if (mode === 'hide' && deps.retireDirectory !== undefined) {
      await deps.retireDirectory(quarantined, { project })
    } else {
      const removeDirectory = deps.removeDirectory ?? (directory => rm(directory, { recursive: true, force: false }))
      await removeDirectory(quarantined)
    }
    if (await pathExists(quarantined)) {
      return failure('storage-partial', '损坏会话已从 DSH 摘载，但存储处理未完成，不能确认删除成功。')
    }
    await rm(quarantineRoot, { recursive: true, force: true })
    return { ok: true, value: mode === 'hide'
      ? { hidden: true, corruptRecovery: true }
      : { deleted: true, corruptRecovery: true } }
  } catch {
    if (quarantined !== undefined && await pathExists(quarantined).catch(() => false)) {
      await rename(quarantined, sessionDir).catch(() => undefined)
    }
    if (quarantineRoot !== undefined) await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined)
    return undefined
  }
}

/**
 * Permanently remove (or, with deps.retireDirectory, hide) one JSONL session
 * directory. A live Agent is first torn down through its owned host handle;
 * persistence retirement is then awaited before the same path and identity
 * checks used for a cold session.
 */
export async function deleteSessionSafely(deps, { sessionRoot, sessionId, mode = 'permanent' }) {
  if (mode !== 'permanent' && mode !== 'hide') {
    return failure('invalid-mode', '删除模式只允许 hide 或 permanent。')
  }
  const persistence = deps.sessionPersistence
  const usesHandles = persistence.supportsRawArtifacts === undefined
    && persistence.name === 'session-persistence-jsonl'
    && typeof persistence.open === 'function'
    && typeof persistence.stat === 'function'
    && typeof persistence.resolveCurrentLog === 'function'
  if (!persistence.supportsRawArtifacts && !usesHandles) {
    return failure('unsupported-backend', '当前会话存储不是可逐会话删除的 JSONL 后端。')
  }

  const releaseReservation = deps.agentHandles.reserve?.(sessionId)
  if (typeof deps.agentHandles.reserve === 'function' && releaseReservation === undefined) {
    return failure('deletion-in-progress', '该会话正在删除中，请等待当前操作完成。')
  }

  const ownership = { usesHandles, handle: undefined }
  try {
    return await deleteReservedSession(deps, { sessionRoot, sessionId, mode }, ownership)
  } finally {
    try { await ownership.handle?.close() }
    finally { releaseReservation?.() }
  }
}

async function deleteReservedSession(deps, { sessionRoot, sessionId, mode }, ownership) {
  const { usesHandles } = ownership
  const storedHeaders = async () => (await deps.sessionPersistence.list()).map(item => usesHandles ? item.header : item)
  let header = (await storedHeaders()).find(item => item.id === sessionId)
    ?? deps.sessions.get(sessionId)?.header
  if (header === undefined) {
    // A stale archive marker can outlive its transcript. Only acknowledge an
    // absent session after both the public backend and physical layout agree;
    // unreadable/corrupt artifacts must never be mistaken for successful deletion.
    if (usesHandles && /^[A-Za-z0-9_-]+$/.test(sessionId)
      && deps.sessions.get(sessionId) === undefined && deps.agents.get(sessionId) === undefined
      && await deps.sessionPersistence.stat(sessionId) === undefined) {
      const projects = await readdir(sessionRoot, { withFileTypes: true })
      let absent = true
      for (const project of projects) {
        if (project.isSymbolicLink()) { absent = false; break }
        if (!project.isDirectory()) continue
        const entries = await readdir(join(sessionRoot, project.name))
        if (entries.some(name => name === sessionId || name.startsWith(`${sessionId}.`))) {
          absent = false; break
        }
      }
      if (absent && await deps.sessionPersistence.stat(sessionId) === undefined
        && deps.sessions.get(sessionId) === undefined && deps.agents.get(sessionId) === undefined) {
        return { ok: true, value: { deleted: false, alreadyAbsent: true } }
      }
    }
    return failure('session-not-found', '会话不存在或已经删除。')
  }

  if (deps.agents.get(sessionId) !== undefined) {
    let disposed
    try {
      disposed = await deps.agentHandles.dispose(sessionId)
    } catch {
      return failure('lifecycle-error', 'DSH 未能安全停止并摘载该会话，未删除任何内容。')
    }
    if (!disposed) {
      return failure('lifecycle-unavailable', '无法取得该会话的宿主生命周期句柄，未删除任何内容。请确认插件已更新并在更新后重启 DeepSeek Harness。')
    }
  }

  if (deps.sessions.get(sessionId) !== undefined || deps.agents.get(sessionId) !== undefined) {
    return failure('lifecycle-unavailable', '宿主未能完整摘载该会话，未删除任何内容。')
  }

  // inspect() waits for the persistence backend's asynchronous retirement
  // drain. A never-materialized blank session is already fully removed here.
  try {
    // The handle API owns the cross-process writer lease until removal finishes.
    // Opening happens only after the live Agent has drained and released its handle.
    const inspected = usesHandles
      ? { meta: (ownership.handle = await deps.sessionPersistence.open(sessionId, 'write')).header }
      : await deps.sessionPersistence.inspect(sessionId)
    if (!sameHeader(header, inspected.meta)) {
      return failure('unsafe-location', '会话在摘载期间发生了身份变化，未删除任何文件。')
    }
    header = inspected.meta
  } catch (error) {
    // 2026-11-13 实测 storage-state-unknown 无从下手：把底层错误带进文案（截 200 字），
    // 只加诊断信息，不改变任何失败语义。
    const detail = String(error?.message ?? error ?? 'unknown').replace(/\s+/g, ' ').slice(0, 200)
    // 损坏 transcript 打不开持久化句柄 → 走物理兜底（唯一目录名匹配 + 身份复核，
    // 拿不准就 undefined 回到保守失败）。只认 corrupt/SessionFormatError 这类格式错。
    if (/corrupt|SessionFormatError/i.test(detail)) {
      const recovered = await physicallyRemoveCorruptSession(deps, { sessionRoot, sessionId, mode })
      if (recovered !== undefined) return recovered
    }
    const stillStored = (await storedHeaders()).some(item => item.id === sessionId)
    if (!stillStored && deps.sessions.get(sessionId) === undefined && deps.agents.get(sessionId) === undefined) {
      if (usesHandles && await deps.sessionPersistence.stat(sessionId) === undefined) {
        return { ok: true, value: { deleted: true } }
      }
      const missingPaths = usesHandles ? undefined : locationPaths(sessionRoot, deps.sessionPersistence.locate(header))
      if (missingPaths !== undefined && !await pathExists(missingPaths.sessionDirectory)) {
        return { ok: true, value: { deleted: true } }
      }
      return failure('storage-state-unknown', `DSH 已摘载会话，但无法确认其存储是否已删除。原因：${detail}`)
    }
    return failure('storage-state-unknown', `无法确认会话存储状态，未继续删除。原因：${detail}${stillStored ? '' : '（存储已不可见但会话仍在内存）'}`)
  }

  const location = usesHandles
    ? { kind: 'jsonl', path: await deps.sessionPersistence.resolveCurrentLog(sessionId) }
    : deps.sessionPersistence.locate(header)
  const raw = usesHandles ? { meta: ownership.handle.header } : await deps.sessionPersistence.readRaw(sessionId)
  const paths = locationPaths(sessionRoot, location)
  if (paths === undefined || raw === undefined || !sameHeader(header, raw.meta)) {
    return failure('unsafe-location', '无法验证该会话的独立 JSONL 存储位置。')
  }

  let validated
  try {
    validated = await validateExistingLocation(paths)
  } catch (error) {
    if (error?.code === 'ENOENT') return failure('session-not-found', '会话不存在或已经删除。')
    return failure('storage-error', '读取会话存储失败，未删除任何文件。')
  }
  if (validated === undefined) {
    return failure('unsafe-location', '会话存储位置未通过安全校验，未删除任何文件。')
  }
  if (deps.sessions.get(sessionId) !== undefined || deps.agents.get(sessionId) !== undefined) {
    return failure('session-reopened', '该会话在删除过程中被重新打开，已取消删除。')
  }

  let quarantineRoot
  let quarantinedDirectory
  let detached = false
  try {
    const moveDirectory = deps.moveDirectory ?? rename
    quarantineRoot = await mkdtemp(join(dirname(validated.root), '.dsh-session-delete-'))
    quarantinedDirectory = join(quarantineRoot, basename(validated.resolvedDirectory))
    await moveDirectory(validated.resolvedDirectory, quarantinedDirectory)
    detached = true

    const quarantinedTranscript = join(quarantinedDirectory, basename(paths.transcript))
    const [directoryAfter, transcriptAfter] = await Promise.all([
      lstat(quarantinedDirectory, { bigint: true }),
      lstat(quarantinedTranscript, { bigint: true }),
    ])
    if (
      directoryAfter.isSymbolicLink()
      || transcriptAfter.isSymbolicLink()
      || !sameFile(validated.directory, directoryAfter)
      || !sameFile(validated.transcript, transcriptAfter)
    ) {
      await moveDirectory(quarantinedDirectory, validated.resolvedDirectory)
      detached = false
      await rm(quarantineRoot, { recursive: true, force: true })
      return failure('unsafe-location', '会话目录在删除期间发生了身份变化，未删除任何文件。')
    }

    // 1.1.0 软删（mode:'hide'）：不 rm，而是把已暂存、已复核身份的会话目录整体
    // 搬去隐藏区（宿主扫描根之外 → 界面全隐藏，rename 不动文件内容，zstd 原样）。
    const retire = mode === 'hide' ? deps.retireDirectory : undefined
    if (retire !== undefined) {
      await retire(quarantinedDirectory, {
        project: basename(dirname(validated.resolvedDirectory)),
      })
    } else {
      const removeDirectory = deps.removeDirectory
        ?? (directory => rm(directory, { recursive: true, force: false }))
      await removeDirectory(quarantinedDirectory)
    }
    if (await pathExists(quarantinedDirectory)) {
      // retire 成功时目录已不在暂存点；仍在 = 搬移没完成。
      return failure('storage-partial', '会话已从 DSH 摘载，但存储处理未完成，不能确认删除成功。')
    }
    await rm(quarantineRoot, { recursive: true, force: true })
    return { ok: true, value: mode === 'hide' ? { hidden: true } : { deleted: true } }
  } catch (error) {
    if (detached && quarantinedDirectory !== undefined) {
      let remains = true
      try {
        remains = await pathExists(quarantinedDirectory)
      } catch {
        // Inaccessible storage is not proof of cleanup; retain the quarantine.
      }
      if (remains) {
        return failure('storage-partial', '会话已从 DSH 摘载，但存储清理未完成，不能确认永久删除成功。')
      }
      if (quarantineRoot !== undefined) await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined)
      return { ok: true, value: { deleted: true } }
    }
    if (quarantineRoot !== undefined) await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined)
    if (missing(error)) return failure('session-not-found', '会话不存在或已经删除。')
    return failure('storage-error', '存储删除失败，未删除任何文件。')
  }
}

// Kept as an import-compatible alias for 0.1.0 consumers.
export const deleteColdSession = deleteSessionSafely

/**
 * HTTP boundary for the destructive operation. The native client must make a
 * same-origin JSON POST and include a confirmation-only header that ordinary
 * links and HTML forms cannot add.
 */
export function sameOriginRequest(req) {
  const host = req.headers.host
  return typeof host === 'string' && req.headers.origin === `http://${host}`
}

/**
 * Prefer the Host's own request fence (loopback authority, not cross-site, and the Host session cookie).
 * The official desktop app forwards dsh-app:// requests to the Host without an Origin header, so a
 * plain same-origin check would reject every desktop request; older cores without that fence keep it.
 */
export function hostRequestFence(connection) {
  if (typeof connection?.requestRejection !== 'function') return sameOriginRequest
  return req => connection.requestRejection(req) === undefined
}

export function createDeleteRequestHandler({ deleteSession, isTrustedRequest = sameOriginRequest }) {
  return async (req, res) => {
    const contentType = req.headers['content-type']
    const confirmation = req.headers['x-dsh-session-delete-confirmation']

    if (req.method !== 'POST') {
      sendJson(res, 405, failure('method-not-allowed', '只允许使用 POST 删除会话。'))
      return
    }
    if (!isTrustedRequest(req) || confirmation !== 'delete-session') {
      sendJson(res, 403, failure('forbidden', '删除请求未通过同源与确认校验。'))
      return
    }
    if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
      sendJson(res, 415, failure('unsupported-media-type', '删除请求必须使用 JSON。'))
      return
    }

    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === 'request-too-large'
      sendJson(
        res,
        tooLarge ? 413 : 400,
        failure(tooLarge ? 'request-too-large' : 'invalid-json', tooLarge ? '删除请求过大。' : '删除请求不是有效 JSON。'),
      )
      return
    }
    if (
      typeof body?.sessionId !== 'string'
      || body.sessionId.length === 0
      || body.sessionId.length > 512
      || body.sessionId.includes('\0')
    ) {
      sendJson(res, 400, failure('invalid-session-id', '会话 ID 无效。'))
      return
    }
    const mode = body.mode === undefined || body.mode === 'permanent' ? 'permanent' : body.mode
    if (mode !== 'hide' && mode !== 'permanent') {
      sendJson(res, 400, failure('invalid-mode', '删除模式只允许 hide 或 permanent。'))
      return
    }

    try {
      const result = await deleteSession(body.sessionId, mode)
      sendJson(res, result.ok ? 200 : 409, result)
    } catch {
      sendJson(res, 500, failure('internal', '删除过程中发生未预期错误，未确认删除成功。'))
    }
  }
}
