import semver from 'semver'
import type { Release } from '../workflow/model.ts'

/** Upstream release tags are `dsh-v<semver>`. */
export const TAG_PREFIX = 'dsh-v'

/**
 * The release a tag or a bare version names, or `undefined` when it is neither.
 * @param value - `dsh-v0.2.0-rc.2` or `0.2.0-rc.2`.
 */
export function parseRelease(value: string): Release | undefined {
  const version = value.startsWith(TAG_PREFIX) ? value.slice(TAG_PREFIX.length) : value
  // `semver.valid` also accepts `v1.0.0` and `=1.0.0`; a release is only the canonical form.
  return semver.valid(version) === version ? { tag: `${TAG_PREFIX}${version}`, version } : undefined
}

/** Semver order of two releases. */
export function compareReleases(left: Release, right: Release): number {
  return semver.compare(left.version, right.version)
}

/** The newest of some releases. */
export function newest(releases: readonly Release[]): Release | undefined {
  return [...releases].sort(compareReleases).at(-1)
}

/**
 * The lowest release a plugin's `@deepseek-ai/dsh-*` dependency ranges admit.
 *
 * It stands in for the source release when no migration has verified one yet.
 * @param manifest - the plugin's parsed `package.json`.
 */
export function declaredRelease(manifest: unknown): Release | undefined {
  if (typeof manifest !== 'object' || manifest === null) return undefined
  const versions: string[] = []
  for (const field of ['peerDependencies', 'devDependencies', 'dependencies']) {
    const block = (manifest as Record<string, unknown>)[field]
    if (typeof block !== 'object' || block === null) continue
    for (const [name, range] of Object.entries(block)) {
      if (!name.startsWith('@deepseek-ai/dsh-') || typeof range !== 'string') continue
      const lowest = semver.validRange(range) === null ? null : semver.minVersion(range)
      if (lowest !== null) versions.push(lowest.version)
    }
  }
  const lowest = versions.sort(semver.compare)[0]
  return lowest === undefined ? undefined : parseRelease(lowest)
}
