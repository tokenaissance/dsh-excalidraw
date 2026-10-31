/**
 * Conversation scoping (CONTRACT §2/§3): turn a request's optional session id
 * (or a tool call's agent session) into `{ sessionId, cwd }`, and turn that cwd
 * plus `scenesDir` into the absolute scene root.
 *
 * The rules this module exists to enforce:
 *  - never fall back to `process.cwd()`;
 *  - a session without a usable absolute working directory is a `no-session`
 *    refusal (400), not a guess;
 *  - `scenesDir` resolves against the session cwd, and an absolute
 *    `scenesDir` is accepted as-is.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

/** A refusal a route maps to 400 `{ error: "no-session" }`. */
export class SessionError extends Error {
  /** @param {string} [message] */
  constructor(message = 'no session: this request or tool call did not identify a conversation') {
    super(message)
    this.name = 'SessionError'
    this.code = 'no-session'
    this.status = 400
  }
}

/**
 * The session's committed working directory: the host's live value first, the
 * immutable header cwd second (matching dsh-better-sidebar's precedence).
 *
 * @param {{ header?: { cwd?: string } } | undefined} session
 * @param {{ get?: (session: unknown) => string } | undefined} workingDirectory
 * @returns {string | undefined}
 */
export function sessionCwdOf(session, workingDirectory) {
  if (session === undefined || session === null) return undefined
  try {
    const committed = workingDirectory?.get?.(session)
    if (typeof committed === 'string' && committed !== '') return committed
  } catch {
    // A throwing working-directory service is "no cwd", never a crash.
  }
  const header = session.header?.cwd
  return typeof header === 'string' && header !== '' ? header : undefined
}

/**
 * The absolute scene root of one session: `<cwd>/<scenesDir>` (CONTRACT §2).
 *
 * @param {string} cwd - absolute session working directory.
 * @param {string} scenesDir - relative to `cwd`, or absolute.
 * @returns {string}
 */
export function sceneRootOf(cwd, scenesDir) {
  if (typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd)) {
    throw new SessionError('cannot locate the scene store: the session has no absolute working directory')
  }
  if (typeof scenesDir !== 'string' || scenesDir === '') {
    throw new SessionError('cannot locate the scene store: scenesDir is empty')
  }
  return resolve(cwd, scenesDir)
}

/**
 * The `file` a tool result reports: the scene path relative to the session
 * cwd when it lives inside it (`.dsh/excalidraw/x.excalidraw.json`), otherwise
 * an absolute POSIX-style path.
 *
 * @param {string} cwd
 * @param {string} scenesDir
 * @param {string} file - a bare file name inside the scene root.
 * @returns {string}
 */
export function sceneFileRef(cwd, scenesDir, file) {
  const target = resolve(sceneRootOf(cwd, scenesDir), file)
  const rel = relative(cwd, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return target.split(sep).join('/')
  return rel.split(sep).join('/')
}

/**
 * Build the session resolver used by the routes and the tools.
 *
 * Without an explicit session id a request still has to land somewhere: the
 * resolver remembers the last session it successfully resolved (the plugin's
 * "most recent session"), and falls back to the only listed session when it
 * has not seen one yet. Anything else is a `no-session` refusal — never
 * `process.cwd()`.
 *
 * @param {object} services
 * @param {(id: string) => ({ header?: { cwd?: string } } | undefined)} [services.getSession] - `ctx.sessions.get`.
 * @param {() => unknown} [services.getWorkingDirectory] - `ctx.get('workingDirectory')`.
 * @param {() => (unknown[] | { byId?: Record<string, unknown> } | undefined)} [services.listSessions]
 *   `ctx.sessions.list()` — the real DSH API, returning `Session[]` — or the
 *   older `{ byId }` snapshot shape; both are accepted (P2-2).
 * @returns {{ resolve: (sessionId?: string) => Promise<{sessionId: string, cwd: string}>, lastSessionId: () => string | undefined }}
 */
export function createSessionResolver(services = {}) {
  let lastSessionId

  function cwdOf(sessionId) {
    let session
    try {
      session = services.getSession?.(sessionId)
    } catch {
      session = undefined
    }
    if (session === undefined || session === null) return undefined
    let workingDirectory
    try {
      workingDirectory = services.getWorkingDirectory?.()
    } catch {
      workingDirectory = undefined
    }
    return sessionCwdOf(session, workingDirectory)
  }

  function listedSessionIds() {
    try {
      const listed = services.listSessions?.()
      if (Array.isArray(listed)) {
        // `ctx.sessions.list()` returns live `Session` objects; the id is
        // `header.id` (`session.id` is a getter for the same value).
        const ids = []
        for (const session of listed) {
          const id = session?.header?.id ?? session?.id
          if (typeof id === 'string' && id !== '') ids.push(id)
        }
        return ids
      }
      // An older/host-side snapshot shape kept `{ byId }`.
      const byId = listed?.byId
      return byId !== null && typeof byId === 'object' ? Object.keys(byId) : []
    } catch {
      return []
    }
  }

  /**
   * @param {unknown} rawSessionId
   * @returns {Promise<{ sessionId: string, cwd: string }>}
   */
  async function resolve(rawSessionId) {
    const explicit = typeof rawSessionId === 'string' && rawSessionId.trim() !== '' ? rawSessionId.trim() : undefined
    const candidate = explicit ?? lastSessionId
    if (candidate !== undefined) {
      const cwd = cwdOf(candidate)
      if (cwd !== undefined) {
        lastSessionId = candidate
        return { sessionId: candidate, cwd }
      }
      // A session restored from disk is not "live", so neither the working
      // directory service nor its header can answer: fall back to the persisted
      // workspace mapping (`~/.dsh/storages/workspace.json`), or every old
      // conversation shows "no usable working directory" after a restart.
      let persisted
      try {
        persisted = await services.persistedCwd?.(candidate)
      } catch {
        persisted = undefined
      }
      if (typeof persisted === 'string' && persisted !== '' && isAbsolute(persisted)) {
        lastSessionId = candidate
        return { sessionId: candidate, cwd: persisted }
      }
    }
    if (explicit !== undefined) {
      throw new SessionError(`session ${JSON.stringify(explicit)} has no usable working directory`)
    }
    const ids = listedSessionIds()
    if (ids.length === 1) {
      const cwd = cwdOf(ids[0])
      if (cwd !== undefined) {
        lastSessionId = ids[0]
        return { sessionId: ids[0], cwd }
      }
    }
    throw new SessionError()
  }

  return { resolve, lastSessionId: () => lastSessionId }
}

