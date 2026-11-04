import { test } from 'node:test'
import assert from 'node:assert/strict'
import { choosePair } from '../../src/evaluation/pair.ts'

const records = [
  { id: 'newest', scoredTasks: ['M1', 'M2'] },
  { id: 'middle', scoredTasks: ['M1', 'M2', 'M3'] },
  { id: 'oldest', scoredTasks: ['M1'] },
]

test('the default pair maximizes shared tasks with a newer head', () => {
  assert.deepEqual(choosePair(records), ['middle', 'newest'])
})

test('an explicit pair wins and same-side self-comparison is preserved', () => {
  assert.deepEqual(choosePair(records, 'oldest', 'newest'), ['oldest', 'newest'])
  assert.deepEqual(choosePair(records, 'oldest', 'oldest'), ['oldest', 'oldest'])
})

test('a single endpoint chooses its partner on the correct chronological side', () => {
  assert.deepEqual(choosePair(records, 'newest'), ['newest', 'newest'])
  assert.deepEqual(choosePair(records, 'middle'), ['middle', 'newest'])
  assert.deepEqual(choosePair(records, 'oldest'), ['oldest', 'middle'])
  assert.deepEqual(choosePair(records, undefined, 'oldest'), ['oldest', 'oldest'])
  assert.deepEqual(choosePair(records, undefined, 'newest'), ['middle', 'newest'])
})

test('the pair choice handles empty and single record lists', () => {
  assert.deepEqual(choosePair([]), ['', ''])
  assert.deepEqual(choosePair([{ id: 'only' }]), ['only', 'only'])
})
