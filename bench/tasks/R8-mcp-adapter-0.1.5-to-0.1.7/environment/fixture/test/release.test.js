import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const projectRoot = new URL('..', import.meta.url)

function check(tag) {
  return spawnSync('node', ['scripts/check-release-tag.mjs', tag], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
}

test('release gate accepts only the v-prefixed package version', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  )
  const matchingTag = `v${packageJson.version}`
  const mismatchedTag = `${matchingTag}-mismatch`

  const matching = check(matchingTag)
  assert.equal(matching.status, 0, matching.stderr)
  assert.ok(
    matching.stdout.includes(
      `Release tag ${matchingTag} matches package version ${packageJson.version}`,
    ),
  )

  const mismatched = check(mismatchedTag)
  assert.notEqual(mismatched.status, 0)
  assert.ok(
    mismatched.stderr.includes(
      `Release tag ${mismatchedTag} does not match package version ${packageJson.version}`,
    ),
  )
})
