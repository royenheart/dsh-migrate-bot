import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXTENSION_POINTS_PROMPT,
  OVERLAP_PROMPT,
  REPAIR_PROMPT,
  assembleRepairPrompt,
  harnessContextNote,
} from '../../src/prompts/migration.ts'
import { channelPrompt, DUPLICATE_CONTRACT, REPORT_CONTRACT } from '../../src/prompts/reports.ts'

const HARNESS = { path: '/tmp/harness', tag: 'dsh-v0.1.1-rc.2' }

test('the overlap review preserves the documented product form', () => {
  assert.match(OVERLAP_PROMPT, /documented product form/)
  assert.match(OVERLAP_PROMPT, /entry point is its own capability/)
  assert.match(OVERLAP_PROMPT, /not a uniqueness residue/)
  assert.match(OVERLAP_PROMPT, /silent degrade/)
  assert.match(OVERLAP_PROMPT, /Decision: keep \| shrink \| retire/)
})

test('the extension-point review keeps a patch a coarser official extension point cannot replace', () => {
  assert.match(EXTENSION_POINTS_PROMPT, /the one the capability needs/)
  assert.match(EXTENSION_POINTS_PROMPT, /not "doing the job"/)
  assert.match(EXTENSION_POINTS_PROMPT, /silent degrade/)
})

test('the repair prompt adds no toolchain package and leaves the end-to-end suite alone', () => {
  assert.match(REPAIR_PROMPT, /Do not add compiler or toolchain packages/)
  assert.match(REPAIR_PROMPT, /Do not edit the end-to-end suite/)
  assert.match(REPAIR_PROMPT, /BLOCKER: upstream/)
})

test('no prompt asks for Agent Notes in a third-party plugin repository, and every one asks for a report', () => {
  assert.match(EXTENSION_POINTS_PROMPT, /never write design-note files into this third-party plugin repository/)
  assert.match(REPAIR_PROMPT, /Never write design notes, Agent Notes, or other documentation files/)
  for (const prompt of [OVERLAP_PROMPT, EXTENSION_POINTS_PROMPT, REPAIR_PROMPT]) {
    assert.match(prompt, /Write a markdown report/)
    assert.match(prompt, /The report is the last markdown document you print/)
  }
})

test('the prompts use the project vocabulary', () => {
  for (const prompt of [OVERLAP_PROMPT, EXTENSION_POINTS_PROMPT, REPAIR_PROMPT, harnessContextNote(HARNESS)]) {
    assert.doesNotMatch(prompt, /\bseams?\b|\bgate\b|boot probe|Report [AB]\b|\bC1\b/)
  }
})

test('a repair prompt carries both reviews, the failing output only, and the earlier attempts', () => {
  const prompt = assembleRepairPrompt({
    template: 'REPAIR',
    overlapReport: 'Decision: shrink',
    extensionPointsReport: 'use the official slot',
    failingOutput: 'error: keyed slot missing key',
    priorRepairs: ['touched client.js'],
    harness: HARNESS,
    baselineNote: 'it already failed on dsh-v0.1.0',
  })
  assert.match(prompt, /Decision: shrink/)
  assert.match(prompt, /use the official slot/)
  assert.match(prompt, /keyed slot missing key/)
  assert.match(prompt, /### Repair attempt 1\n\ntouched client\.js/)
  assert.match(prompt, /it already failed on dsh-v0\.1\.0/)
  assert.match(prompt, /\/tmp\/harness/)
  assert.match(prompt, /\.dsh-migrate\/patch-reports\//)
  assert.match(prompt, /\[Feature request\]/)
})

test('the first repair attempt says it is the first', () => {
  const prompt = assembleRepairPrompt({ template: 'R', overlapReport: '', extensionPointsReport: '', failingOutput: 'x', priorRepairs: [] })
  assert.match(prompt, /this is the first repair attempt/)
})

test('a tag from outside cannot add a line to the harness note', () => {
  const note = harnessContextNote({ path: '/tmp/harness', tag: 'dsh-v0.1.6\n::add-mask::not-a-secret' })
  assert.equal(note.split('\n').filter(line => line.startsWith('::')).length, 0)
})

test('a channel prompt carries the evidence and the contract its output is parsed with', () => {
  assert.match(channelPrompt({ id: 'migrate-bot' }, 'EVIDENCE'), /EVIDENCE[\s\S]*"title"/)
  assert.ok(channelPrompt({ id: 'harness-discussion' }, 'E').includes(DUPLICATE_CONTRACT))
  // An override replaces the instructions, never the contract.
  const overridden = channelPrompt({ id: 'harness-discussion', prompt: 'Classify carefully.' }, 'E')
  assert.match(overridden, /^Classify carefully\./)
  assert.ok(overridden.includes(DUPLICATE_CONTRACT))
  assert.ok(channelPrompt({ id: 'mine', prompt: 'Summarize.' }, 'E').includes(REPORT_CONTRACT))
  assert.throws(() => channelPrompt({ id: 'mine' }, 'E'), /has no prompt/)
})
