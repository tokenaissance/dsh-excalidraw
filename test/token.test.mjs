/**
 * CONTRACT §1/§2: token precedence (row → env → profile) and the profile
 * parser. Fixtures use obvious fake tokens; the real profile is never read by
 * a test, and no test asserts a token into a log line.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROFILE_PATCH_FILE,
  TOKEN_ENV,
  extractBearer,
  parseProfileToken,
  resolveToken,
} from '../lib/token.js'

const PROFILE = `# fixture profile patch
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard
# Excalidraw+ MCP server (Streamable HTTP)
- insert:
    - id: mcp-excalidraw
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: excalidraw
        transport: streamable-http
        url: https://api.excalidraw.com/api/v1/mcp
        headers:
          Authorization: "Bearer
            sk-fixture-token-0123456789"
        failOnStartupError: false
# Another MCP server, later in the same file
- insert:
    - id: mcp-freehire
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: freehire
        headers:
          Authorization: "Bearer sk-freehire-token"
`

test('parseProfileToken finds the excalidraw row and folds the header', () => {
  assert.equal(parseProfileToken(PROFILE), 'sk-fixture-token-0123456789')
})

test('parseProfileToken never picks up another server row', () => {
  const onlyFreehire = PROFILE.slice(PROFILE.indexOf('- insert:\n    - id: mcp-freehire') - 1)
  assert.equal(parseProfileToken(onlyFreehire), '')
  const renamed = PROFILE.replace('serverName: excalidraw', 'serverName: somethingelse')
  assert.equal(parseProfileToken(renamed), '')
})

test('parseProfileToken accepts unquoted and single-quoted headers, and comments', () => {
  const unquoted = [
    '- insert:',
    '    - id: mcp-excalidraw',
    '      config:',
    '        serverName: excalidraw',
    '        headers:',
    '          Authorization: Bearer sk-plain-token  # rotate me',
  ].join('\n')
  assert.equal(parseProfileToken(unquoted), 'sk-plain-token')

  const single = unquoted.replace('Bearer sk-plain-token  # rotate me', "'Bearer sk-single-token'")
  assert.equal(parseProfileToken(single), 'sk-single-token')
})

test('parseProfileToken finds a header written before serverName in the same entry', () => {
  const text = [
    '- insert:',
    '    - id: mcp-excalidraw',
    '      config:',
    '        headers:',
    '          Authorization: "Bearer sk-early-token"',
    '        serverName: excalidraw',
  ].join('\n')
  assert.equal(parseProfileToken(text), 'sk-early-token')
})

test('parseProfileToken returns "" for anything it cannot identify', () => {
  for (const value of [undefined, null, '', 'not: yaml', '- insert:\n  - id: x']) {
    assert.equal(parseProfileToken(value), '')
  }
  const noHeaders = '- insert:\n    - config:\n        serverName: excalidraw\n'
  assert.equal(parseProfileToken(noHeaders), '')
  const tokenButNoServer = '- insert:\n    - config:\n        headers:\n          Authorization: Bearer sk-nope\n'
  assert.equal(parseProfileToken(tokenButNoServer), '')
})

test('extractBearer only accepts the Bearer scheme', () => {
  assert.equal(extractBearer('Bearer abc'), 'abc')
  assert.equal(extractBearer('bearer   abc  '), 'abc')
  assert.equal(extractBearer('"Bearer abc"'), 'abc')
  assert.equal(extractBearer('Basic abc'), '')
  assert.equal(extractBearer('Bearer '), '')
  assert.equal(extractBearer(undefined), '')
})

test('resolveToken prefers config, then the environment, then the profile', async () => {
  const reads = []
  const readFile = async (path, encoding) => {
    reads.push({ path, encoding })
    return PROFILE
  }
  const env = { [TOKEN_ENV]: 'sk-env-token', DSH_PROFILE_DIR: '/profiles/desktop' }

  assert.deepEqual(await resolveToken({ configToken: 'sk-config-token', env, readFile }), {
    token: 'sk-config-token',
    source: 'config',
  })
  assert.equal(reads.length, 0)

  assert.deepEqual(await resolveToken({ configToken: '   ', env, readFile }), { token: 'sk-env-token', source: 'env' })
  assert.equal(reads.length, 0)

  const noEnvToken = { DSH_PROFILE_DIR: '/profiles/desktop' }
  assert.deepEqual(await resolveToken({ env: noEnvToken, readFile }), {
    token: 'sk-fixture-token-0123456789',
    source: 'profile',
  })
  assert.equal(reads.length, 1)
  assert.equal(reads[0].path, `/profiles/desktop/${PROFILE_PATCH_FILE}`)
  assert.equal(reads[0].encoding, 'utf8')
})

test('resolveToken degrades to "none" without a profile or when it cannot be read', async () => {
  assert.deepEqual(await resolveToken({ env: {} }), { token: '', source: 'none' })
  assert.deepEqual(await resolveToken({ env: { DSH_PROFILE_DIR: '  ' } }), { token: '', source: 'none' })
  const failing = async () => {
    throw new Error('ENOENT: profile not found')
  }
  assert.deepEqual(await resolveToken({ env: { DSH_PROFILE_DIR: '/missing' }, readFile: failing }), {
    token: '',
    source: 'none',
  })
  const emptyProfile = async () => '# nothing here\n'
  assert.deepEqual(await resolveToken({ env: { DSH_PROFILE_DIR: '/p' }, readFile: emptyProfile }), {
    token: '',
    source: 'none',
  })
})

test('no resolved result leaks a token outside the token field', async () => {
  const readFile = async () => PROFILE
  const result = await resolveToken({ env: { DSH_PROFILE_DIR: '/p' }, readFile })
  assert.deepEqual(Object.keys(result).sort(), ['source', 'token'])
  assert.equal(result.source, 'profile')
  assert.equal(JSON.stringify(result.source).includes('sk-'), false)
})

test('a token is taken from the excalidraw row, never from a neighbouring server row (round 11 P1)', () => {
  const text = [
    '- insert:',
    '    - id: mcp-other',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: other',
    '        headers:',
    '          Authorization: "Bearer other-token"',
    '    - id: mcp-excalidraw',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: excalidraw',
    '        headers:',
    '          Authorization: "Bearer right-token"',
    '',
  ].join('\n')
  assert.equal(parseProfileToken(text), 'right-token')
  // Order inside the block must not matter either.
  const swapped = [
    '- insert:',
    '    - id: mcp-excalidraw',
    '      config:',
    '        serverName: excalidraw',
    '        headers:',
    '          Authorization: "Bearer right-token"',
    '    - id: mcp-other',
    '      config:',
    '        serverName: other',
    '        headers:',
    '          Authorization: "Bearer other-token"',
    '',
  ].join('\n')
  assert.equal(parseProfileToken(swapped), 'right-token')
  // A row without a token falls back to the next matching row, not the neighbour.
  const none = ['- insert:', '    - id: a', '      config:', '        serverName: excalidraw', ''].join('\n')
  assert.equal(parseProfileToken(none), '')
})

test('residual YAML text is never mistaken for a bearer token (round 14)', () => {
  assert.equal(extractBearer('Bearer abc.def-123_456'), 'abc.def-123_456')
  // A trailing comment is dropped; an unclosed quote or a multi-field line is not.
  assert.equal(extractBearer('Bearer abc123 # not a token'), 'abc123')
  assert.equal(extractBearer('Bearer abc123# part of the token'), '', 'a # inside the token is not a credential')
  assert.equal(extractBearer('"Bearer abc123'), '')
  assert.equal(extractBearer('Bearer abc  123'), '')
  assert.equal(extractBearer("'Bearer abc123'"), 'abc123')
})
