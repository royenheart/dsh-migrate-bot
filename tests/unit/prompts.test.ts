import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ABSORPTION_PROMPT,
  ALIGNMENT_PROMPT,
  FIX_PROMPT,
  assembleFixPrompt,
} from '../../src/prompts/migrate/index.ts'
import { resolvePrompts } from '../../src/prompts/resolve.ts'
import { parseConfig } from '../../src/config/load.ts'

test('absorption preserves documented product form, not a uniqueness residue', () => {
  assert.match(ABSORPTION_PROMPT, /documented product form/)
  assert.match(ABSORPTION_PROMPT, /entry point is its own capability/)
  assert.match(ABSORPTION_PROMPT, /not a uniqueness residue/)
  assert.match(ABSORPTION_PROMPT, /silent degrade/)
  assert.doesNotMatch(ABSORPTION_PROMPT, /what it still uniquely does/)
})

test('alignment does not drop a patch for a coarser official substitute', () => {
  assert.match(ALIGNMENT_PROMPT, /same seam the capability needs/)
  assert.match(ALIGNMENT_PROMPT, /not "doing the job"/)
  assert.match(ALIGNMENT_PROMPT, /silent degrade/)
  assert.doesNotMatch(ALIGNMENT_PROMPT, /If official seams can do the job, drop/)
})

test('fix prompt does not add typescript to the plugin for mechanical tsc', () => {
  assert.match(FIX_PROMPT, /Do not add compiler or toolchain packages/)
  assert.match(FIX_PROMPT, /typescript/)
})

test('harness note treats patches\/ as product spec and same-seam coverage', () => {
  const prompt = assembleFixPrompt({
    template: 'FIX',
    reportA: 'A',
    reportB: 'B',
    errors: 'error: x',
    priorFixes: [],
    harness: { path: '/tmp/harness', tag: 'dsh-v0.1.1-rc.2' },
  })
  assert.match(prompt, /\/tmp\/harness/)
  assert.match(prompt, /dsh-v0\.1\.1-rc\.2/)
  assert.match(prompt, /README/)
  assert.match(prompt, /patches\/ directory/)
  assert.match(prompt, /same seam/)
  assert.match(prompt, /Do not drop a patch because the plugin degrades/)
  assert.match(prompt, /official extension points/)
  assert.match(prompt, /\.dsh-migrate\/patch-reports\//)
  assert.match(prompt, /deepseek-ai\/deepseek-harness/)
  assert.match(prompt, /\[Feature request\]/)
})

test('resolvePrompts ships the new absorption default', () => {
  const prompts = resolvePrompts(parseConfig({}))
  assert.match(prompts.absorption, /documented product form/)
  assert.match(prompts.alignment, /documented unique behavior complete/)
})

test('the alignment prompt forbids creating Agent Notes in a third-party plugin repo', () => {
  // Observed live: an agent left `.agents/notes/implemented/...` in the plugin
  // tree. Nothing in dsh, the container, the preset, or the fixtures asks for
  // that — the only mention of the convention is this prompt, so it now states
  // the boundary explicitly.
  assert.match(ALIGNMENT_PROMPT, /never write design-note files into this third-party plugin repository/)
  assert.match(ALIGNMENT_PROMPT, /read them as evidence/i)
  assert.doesNotMatch(ALIGNMENT_PROMPT, /slots, settings, Agent Notes\)/)
  // The repair loop edits the same tree and must not reintroduce the artifact.
  assert.match(FIX_PROMPT, /Never write design notes, Agent Notes, or other documentation files/)
})

test('the Agent Notes boundary does not remove the report every stage must produce', () => {
  // The report is captured from stdout and stored by the runner; the file
  // prohibition must never be read as "produce nothing".
  for (const prompt of [ABSORPTION_PROMPT, ALIGNMENT_PROMPT, FIX_PROMPT]) {
    assert.match(prompt, /Write a markdown report/)
    assert.match(prompt, /The report is the last markdown document you print/)
  }
  assert.match(ALIGNMENT_PROMPT, /printing it is the deliverable/)
  assert.match(ALIGNMENT_PROMPT, /never written into the plugin tree/)
})

test('a tag from outside cannot add a line to the harness note', async () => {
  // The note is interpolated into a prompt an agent reads with an API key in its
  // environment, and the tag comes from an action input or from the recorded
  // state: one line of it.
  const { harnessContextNote } = await import('../../src/prompts/migrate/prompts.ts')
  const note = harnessContextNote({ path: '/tmp/harness', tag: 'dsh-v0.1.6\n::add-mask::not-a-secret' })
  // The note is a paragraph of its own; what the tag may not do is add a line.
  assert.equal(note.split('\n').filter(line => line.startsWith('::')).length, 0)
  const line = note.split('\n').find(entry => entry.includes('Harness source for'))
  assert.match(line ?? '', /\`dsh-v0\.1\.6 ::add-mask::not-a-secret\` is at/)
})
