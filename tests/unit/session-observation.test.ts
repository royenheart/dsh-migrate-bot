import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeObservationLine,
  encodeObservationLine,
  stripObservationLines,
  translateObservation,
} from '../../src/agents/session-observation.ts'

test('assistant text, reasoning and usage become one structured observation', () => {
  const observation = translateObservation({
    type: 'assistant/message',
    seq: 3,
    time: 1_700_000_000_000,
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
  })
  assert.deepEqual(observation, {
    seq: 3,
    time: 1_700_000_000_000,
    type: 'assistant',
    turn: 1,
    step: 2,
    reasoning: 'I should read the file.',
    text: 'Reading it now.',
    usage: { inputTokens: 10, outputTokens: 4, cacheHitTokens: 6 },
  })
})

test('tool calls and results are kept as separate observations', () => {
  const call = translateObservation({ type: 'tool/call', seq: 4, data: { name: 'read', arguments: '{"path":"a.ts"}' } })
  assert.equal(call?.type, 'tool-call')
  assert.deepEqual(call?.tool, { name: 'read', arguments: '{"path":"a.ts"}' })
  const result = translateObservation({ type: 'tool/result', seq: 5, data: { message: { content: [{ type: 'text', text: 'ok' }], isError: false } } })
  assert.equal(result?.type, 'tool-result')
  assert.deepEqual(result?.tool, { name: 'unknown', result: 'ok', failed: false })
})

test('known secrets are redacted and long values are bounded', () => {
  const secret = 'sk-test-secret-value'
  const observation = translateObservation(
    { type: 'tool/call', seq: 1, data: { name: 'read', arguments: `{"path":"${secret}"}` } },
    { secrets: [secret] },
  )
  assert.equal(observation?.tool?.arguments, '{"path":"<redacted>"}')
  const long = translateObservation({ type: 'tool/result', seq: 2, data: { message: { content: [{ type: 'text', text: 'x'.repeat(5_000) }] } } })
  assert.ok((long?.tool?.result?.length ?? 0) <= 4_000)
})

test('an observation line survives encoding and is stripped from diagnostics', () => {
  const line = encodeObservationLine({ seq: 1, time: 1, type: 'other' })
  assert.deepEqual(decodeObservationLine(line), { seq: 1, time: 1, type: 'other' })
  assert.equal(decodeObservationLine('not one'), undefined)
  assert.equal(stripObservationLines(`keep\n${line}\nkeep 2`), 'keep\nkeep 2')
})
