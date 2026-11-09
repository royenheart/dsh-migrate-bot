import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  boundTraceLine,
  decodeTraceLine,
  encodeTraceLine,
  redactSecrets,
  stripTraceLines,
  traceSecrets,
  translateSessionEvent,
  type TraceState,
} from '../../src/agents/session-trace.ts'

const assistant = {
  type: 'assistant/message',
  seq: 3,
  data: {
    turn: 1,
    step: 2,
    message: {
      content: [
        { type: 'reasoning', text: 'I should read the file.' },
        { type: 'text', text: 'Reading it now.' },
      ],
    },
    usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 6 },
  },
}

test('assistant text, reasoning and usage become bounded lines', () => {
  const state: TraceState = {}
  assert.deepEqual(translateSessionEvent(assistant, state, { includeText: true }), [
    'thinking: I should read the file.',
    'assistant: Reading it now.',
    'step 1.2 usage: in 10 out 4 cache 6; context 16',
  ])
  translateSessionEvent({ type: 'request/context', data: { contextWindow: 200_000 } }, state)
  assert.match(translateSessionEvent(assistant, state).at(-1) ?? '', /context 16 \/ 200000/)
})

test('a report session keeps reasoning and tools but not its visible report text', () => {
  const lines = translateSessionEvent(assistant, {}, { includeText: false })
  assert.equal(lines.some(line => line.startsWith('assistant:')), false)
  assert.equal(lines.some(line => line.startsWith('thinking:')), true)
})

test('tool calls and results are redacted and summarized, or kept longer in full mode', () => {
  const secret = 'sk-test-secret-value'
  const call = { type: 'tool/call', data: { name: 'read', arguments: `{"path":"${secret}"}` } }
  assert.equal(translateSessionEvent(call, {}, { secrets: [secret] })[0], 'tool read {"path":"<redacted>"}')
  const long = 'x'.repeat(500)
  const result = { type: 'tool/result', data: { message: { content: [{ type: 'text', text: long }], isError: false } } }
  const summary = translateSessionEvent(result, {}, { toolResults: 'summary' })[0] ?? ''
  assert.ok(summary.length <= 300, `${summary.length}`)
  const full = translateSessionEvent(result, {}, { toolResults: 'full', maxChars: 2_000 })[0] ?? ''
  assert.ok(full.length > 300)
  assert.equal(translateSessionEvent({ type: 'tool/result', data: { message: { content: [], isError: true }, error: { code: 'E_FAIL', reason: 'nope' } } })[0], 'result error (E_FAIL: nope)')
})

test('turn end, unknown events and silent lifecycle events are handled', () => {
  assert.deepEqual(translateSessionEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), ['turn end: completed'])
  assert.deepEqual(translateSessionEvent({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom' } } } }), ['turn end: error: boom'])
  assert.deepEqual(translateSessionEvent({ type: 'custom/thing', data: { turn: 2 } }), ['custom/thing 2'])
  assert.deepEqual(translateSessionEvent({ type: 'step/start', data: { turn: 1, step: 1 } }), [])
})

test('a trace line survives encoding, and is stripped from diagnostics', () => {
  const line = encodeTraceLine('tool read: ok')
  assert.equal(decodeTraceLine(line), 'tool read: ok')
  assert.equal(decodeTraceLine('not a trace'), undefined)
  assert.equal(decodeTraceLine(encodeTraceLine('tok', 'secret-token'), 'secret-token'), 'tok')
  assert.equal(decodeTraceLine(encodeTraceLine('tok', 'secret-token'), 'other-token'), undefined)
  assert.equal(stripTraceLines(`keep\n${line}\nkeep 2`), 'keep\nkeep 2')
})

test('known secrets are found by name, and common credential shapes are redacted', () => {
  assert.deepEqual(traceSecrets({ DEEPSEEK_API_KEY: 'sk-1234567890', GITHUB_TOKEN: 'ghp_1234567890', PATH: '/usr/bin' }).sort(), ['ghp_1234567890', 'sk-1234567890'])
  assert.deepEqual(traceSecrets({ CUSTOM_DEPLOY_AUTH: 'custom-value-123' }, ['custom-value-123']), ['custom-value-123'])
  assert.equal(redactSecrets('a sk-abcdefgh123 and ghp_abcdefghijklmnopqrst and Bearer abc.def', []), 'a sk-<redacted> and gh<redacted> and Bearer <redacted>')
  assert.equal(redactSecrets('value-1234', ['value-1234']), '<redacted>')
})

test('a line is bounded with an ellipsis, not cut silently', () => {
  assert.equal(boundTraceLine('abcdef', 4), 'abc…')
  assert.equal(boundTraceLine('  a \n b  ', 10), 'a b')
})
