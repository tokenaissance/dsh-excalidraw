/**
 * CONTRACT §2/§3 conversation scoping: the resolver accepts the real DSH
 * session service shape (`ctx.sessions.list()` returning `Session[]`) as well
 * as the older `{ byId }` snapshot, and still refuses when two sessions are
 * listed and none was named (P2-2).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { SessionError, createSessionResolver, sessionCwdOf, sceneRootOf } from '../lib/session.js'

const ONE = { header: { id: 'session-1', cwd: '/work/one' }, id: 'session-1' }
const TWO = { header: { id: 'session-2', cwd: '/work/two' }, id: 'session-2' }

function resolverOf({ sessions = [ONE], listSessions, workingDirectory } = {}) {
  return createSessionResolver({
    getSession: (id) => sessions.find((session) => session.header.id === id),
    getWorkingDirectory: () => workingDirectory,
    listSessions,
  })
}

test('the only session from the real Session[] list is used for a bare request (P2-2)', async () => {
  const resolver = resolverOf({ listSessions: () => [ONE] })
  assert.deepEqual(await resolver.resolve(undefined), { sessionId: 'session-1', cwd: '/work/one' })
})

test('the legacy { byId } snapshot shape still resolves (P2-2)', async () => {
  const resolver = resolverOf({ listSessions: () => ({ byId: { 'session-1': ONE } }) })
  assert.deepEqual(await resolver.resolve(), { sessionId: 'session-1', cwd: '/work/one' })
})

test('two listed sessions and no explicit id still refuse (CONTRACT §3)', async () => {
  const resolver = resolverOf({ sessions: [ONE, TWO], listSessions: () => [ONE, TWO] })
  await assert.rejects(resolver.resolve(undefined), (error) => error instanceof SessionError && error.code === 'no-session')
})

test('a resolved session is remembered before the only-session fallback', async () => {
  const resolver = resolverOf({ sessions: [ONE, TWO], listSessions: () => [ONE, TWO] })
  assert.deepEqual(await resolver.resolve('session-2'), { sessionId: 'session-2', cwd: '/work/two' })
  assert.deepEqual(await resolver.resolve(undefined), { sessionId: 'session-2', cwd: '/work/two' })
  assert.equal(resolver.lastSessionId(), 'session-2')
})

test('list entries without a usable id or cwd are ignored', async () => {
  const resolver = resolverOf({ listSessions: () => [null, {}, { header: { id: '' } }, { header: { id: 'nope' } }] })
  await assert.rejects(resolver.resolve(undefined), (error) => error.code === 'no-session')
})

test('a throwing session service is a no-session, never a crash', async () => {
  const resolver = createSessionResolver({
    getSession: () => {
      throw new Error('gone')
    },
    listSessions: () => {
      throw new Error('gone')
    },
  })
  await assert.rejects(resolver.resolve('session-1'), (error) => error.code === 'no-session')
})

test('sessionCwdOf prefers the live working directory, then the header cwd', () => {
  assert.equal(sessionCwdOf(ONE, { get: () => '/live' }), '/live')
  assert.equal(sessionCwdOf(ONE, undefined), '/work/one')
  assert.equal(sessionCwdOf(undefined, undefined), undefined)
  assert.equal(sessionCwdOf(ONE, { get: () => { throw new Error('no') } }), '/work/one')
})

test('sceneRootOf resolves scenesDir against the session cwd and refuses a relative cwd', () => {
  assert.equal(sceneRootOf('/work/one', '.dsh/excalidraw'), '/work/one/.dsh/excalidraw')
  assert.equal(sceneRootOf('/work/one', '/abs/scenes'), '/abs/scenes')
  assert.throws(() => sceneRootOf('relative', '.dsh/excalidraw'), (error) => error.code === 'no-session')
})

test('a restored session falls back to the persisted workspace path (round 19)', async () => {
  const { createSessionResolver } = await import('../lib/session.js')
  const resolver = createSessionResolver({
    getSession: () => undefined,
    listSessions: () => [],
    getWorkingDirectory: () => undefined,
    persistedCwd: async (id) => (id === 'session-old' ? '/Users/reina/Project' : undefined),
  })
  assert.deepEqual(await resolver.resolve('session-old'), { sessionId: 'session-old', cwd: '/Users/reina/Project' })
  await assert.rejects(resolver.resolve('session-gone'), (error) => error.code === 'no-session')
  // A relative or empty persisted path is not a cwd.
  const broken = createSessionResolver({ getSession: () => undefined, persistedCwd: async () => 'relative/path' })
  await assert.rejects(broken.resolve('session-x'), (error) => error.code === 'no-session')
})
