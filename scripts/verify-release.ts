/**
 * Gate: every file that states the release version states the same one.
 *
 * Commitizen bumps `VERSION`, `package.json`, `package-lock.json` and
 * `.cz.toml` together and writes the changelog section; the image the Action
 * runs is tagged with that version in `action.yml`. A hand edit to any one of
 * them would ship an Action whose code and image disagree.
 */

import { join } from 'node:path'
import { readText, REPO_ROOT } from './repo.ts'

export const IMAGE = 'ghcr.io/royenheart/dsh-migrate-bot'

export interface ReleaseFiles {
  version: string
  packageJson: string
  packageLock: string
  czToml: string
  actionYml: string
  changelog: string
}

export function readReleaseFiles(): ReleaseFiles {
  const read = (name: string): string => readText(join(REPO_ROOT, name))
  return { version: read('VERSION'), packageJson: read('package.json'), packageLock: read('package-lock.json'), czToml: read('.cz.toml'), actionYml: read('action.yml'), changelog: read('CHANGELOG.md') }
}

/** Each statement of the version that differs from `VERSION`. */
export function verifyRelease(files: ReleaseFiles): string[] {
  const version = files.version.trim()
  const lock = JSON.parse(files.packageLock) as { version?: string; packages?: Record<string, { version?: string }> }
  const stated: Array<[string, string | undefined]> = [
    ['package.json', (JSON.parse(files.packageJson) as { version?: string }).version],
    ['package-lock.json', lock.version],
    ['package-lock.json packages[""]', lock.packages?.['']?.version],
    ['.cz.toml', files.czToml.split('\n').find(line => line.startsWith('version = '))?.split('"')[1]],
    ['action.yml image', files.actionYml.split('\n').find(line => line.includes(`docker://${IMAGE}:`))?.split(`${IMAGE}:v`)[1]?.trim()],
    ['CHANGELOG.md newest release', files.changelog.split('\n').find(line => line.startsWith('## v'))?.slice(4).split(' ')[0]],
  ]
  return stated.flatMap(([where, value]) => value === version ? [] : [`${where} says ${value ?? 'nothing'}, VERSION says ${version}`])
}
