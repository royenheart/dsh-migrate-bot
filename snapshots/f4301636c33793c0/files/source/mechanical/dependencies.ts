import { execFileSync } from 'node:child_process'
import semver from 'semver'

/**
 * The plugin's dependency contract with the target release.
 *
 * Every `@deepseek-ai/dsh-*` package is published with the release's version,
 * and a package the harness removed or renamed stops at its last release. So a
 * plugin that names one must name a package published at the target, under a
 * range that admits the target by npm's rules, which compare a prerelease only
 * within the same `major.minor.patch`: `^0.1.0-rc.8` does not admit
 * `0.1.2-alpha.2`. The other checks install the target's packages whatever the
 * plugin declares, so they cannot see either mistake; a user installing the
 * plugin would.
 *
 * An optional peer is installed only by whoever needs it, so one the harness
 * stopped publishing harms nothing; its range still has to admit the target,
 * because dsh refuses a plugin whose peer ranges do not.
 */

const DSH_SCOPE = '@deepseek-ai/dsh-'
const BLOCKS = ['peerDependencies', 'dependencies', 'devDependencies', 'optionalDependencies'] as const

export interface DependencyFinding {
  message: string
}

/**
 * @param pkg - the parsed `package.json`.
 * @param target - the target release's version.
 * @param published - the published versions of a package, or `undefined` when they could not be read.
 */
export function checkDependencyContract(pkg: unknown, target: string, published: (name: string) => readonly string[] | undefined): DependencyFinding[] {
  if (typeof pkg !== 'object' || pkg === null) return []
  const findings: DependencyFinding[] = []
  const meta = (pkg as { peerDependenciesMeta?: Record<string, { optional?: boolean } | undefined> }).peerDependenciesMeta ?? {}
  for (const block of BLOCKS) {
    const entries = (pkg as Record<string, unknown>)[block]
    if (typeof entries !== 'object' || entries === null) continue
    for (const [name, range] of Object.entries(entries)) {
      // A workspace, file or git reference is not a registry range.
      if (!name.startsWith(DSH_SCOPE) || typeof range !== 'string' || semver.validRange(range) === null) continue
      const versions = published(name)
      if (versions === undefined) continue
      if (!versions.includes(target)) {
        if (block === 'peerDependencies' && meta[name]?.optional === true) continue
        findings.push({ message: `${block}: ${name} is not published at ${target}; the harness removed or renamed it (last published ${versions.at(-1) ?? 'never'})` })
      } else if (!semver.satisfies(target, range)) {
        findings.push({ message: `${block}: ${name} is "${range}", which does not admit ${target}` })
      }
    }
  }
  return findings
}

/** The published versions of a package from the npm registry; `undefined` when the lookup fails. */
export function npmPublishedVersions(name: string, timeoutMs = 60_000): readonly string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(execFileSync('npm', ['view', name, 'versions', '--json'], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] }))
    if (Array.isArray(parsed)) return parsed.filter((version): version is string => typeof version === 'string')
    return typeof parsed === 'string' ? [parsed] : undefined
  } catch {
    return undefined
  }
}
