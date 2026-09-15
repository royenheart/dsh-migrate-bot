/**
 * Gate: the skills vendored into the image are the commit the submodule pins.
 *
 * Two places name that commit — the `vendor/dsh-plugin-upgrade-skill` gitlink
 * and the `UPGRADE_SKILL_COMMIT` build argument in the Dockerfile — and they
 * must agree. A Docker action's build context does not carry submodules, so the
 * image cannot read the gitlink; it clones the commit instead. When the two
 * drift, a migration loads one snapshot of the community knowledge while the
 * benchmark record claims another, which is exactly the comparison the record
 * exists to make.
 */

import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readText, REPO_ROOT } from './repo.ts'

/** The submodule path and the Dockerfile that pins the same commit. */
export const SUBMODULE_PATH = 'vendor/dsh-plugin-upgrade-skill'
export const DOCKERFILE_PATH = 'Dockerfile'
export const PIN_ARG = 'UPGRADE_SKILL_COMMIT'

/** One defect in the pin. */
export interface PinViolation {
  detail: string
}

/** The commit recorded by the submodule's gitlink, or `undefined`. */
export function submoduleCommit(): string | undefined {
  const result = spawnSync('git', ['ls-tree', 'HEAD', SUBMODULE_PATH], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  if (result.status !== 0) return undefined
  const match = /^\d+\s+\w+\s+([0-9a-f]{40})\s/.exec(result.stdout)
  return match?.[1]
}

/** The commit the Dockerfile clones. */
export function dockerfileCommit(): string | undefined {
  const text = readText(resolve(REPO_ROOT, DOCKERFILE_PATH))
  const match = new RegExp(`^ARG\\s+${PIN_ARG}=([0-9a-f]{40})\\s*$`, 'm').exec(text)
  return match?.[1]
}

/**
 * Check that the image pin and the submodule pin are the same commit.
 * @returns one entry per defect.
 */
export function verifySkillsPin(): { violations: PinViolation[] } {
  const violations: PinViolation[] = []
  const gitlink = submoduleCommit()
  const pinned = dockerfileCommit()
  if (gitlink === undefined) {
    violations.push({ detail: `no gitlink for ${SUBMODULE_PATH}; run: git submodule update --init ${SUBMODULE_PATH}` })
  }
  if (pinned === undefined) {
    violations.push({ detail: `${DOCKERFILE_PATH} declares no ARG ${PIN_ARG}=<40-hex commit>` })
  }
  if (gitlink !== undefined && pinned !== undefined && gitlink !== pinned) {
    violations.push({
      detail: `${DOCKERFILE_PATH} pins ${PIN_ARG}=${pinned} but ${SUBMODULE_PATH} is at ${gitlink}`,
    })
  }
  return { violations }
}

if (import.meta.filename === process.argv[1]) {
  const { violations } = verifySkillsPin()
  if (violations.length === 0) {
    console.log(`verify-skills-pin: image and submodule both pin ${String(dockerfileCommit())}.`)
    process.exit(0)
  }
  console.error('verify-skills-pin: the vendored skills are pinned twice and disagree:')
  for (const violation of violations) console.error(`  ${violation.detail}`)
  process.exit(1)
}
