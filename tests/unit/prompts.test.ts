import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ABSORPTION_PROMPT,
  ALIGNMENT_PROMPT,
  FIX_PROMPT,
  assembleFixPrompt,
} from '../../src/prompts/defaults.ts'
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
