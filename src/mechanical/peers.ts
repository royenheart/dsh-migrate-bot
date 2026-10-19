/**
 * Pin a plugin's `@deepseek-ai/dsh-*` packages to the migrate target so
 * typecheck and tests run against that harness, not whatever the lockfile
 * or a caret range last resolved.
 */

const DSH_SCOPE = '@deepseek-ai/dsh-'

function dependencyNames(pkg: Record<string, unknown>, key: string): string[] {
  const block = pkg[key]
  if (typeof block !== 'object' || block === null) return []
  return Object.keys(block)
}

/**
 * npm install specs for every `@deepseek-ai/dsh-*` dependency named by the
 * plugin that the release published. One it did not is an optional peer the
 * dependency contract let through; installing it would fail.
 * @param pkg - parsed package.json
 * @param version - resolved harness version (no `dsh-v` prefix)
 * @param published - the published versions of a package, or `undefined` when they could not be read
 */
export function dshPeerSpecs(pkg: unknown, version: string, published: (name: string) => readonly string[] | undefined = () => undefined): string[] {
  if (typeof pkg !== 'object' || pkg === null) return []
  const record = pkg as Record<string, unknown>
  const names = new Set<string>()
  for (const key of ['peerDependencies', 'devDependencies', 'dependencies']) {
    for (const name of dependencyNames(record, key)) {
      if (name.startsWith(DSH_SCOPE)) names.add(name)
    }
  }
  return [...names].filter(name => published(name)?.includes(version) !== false).sort().map(name => `${name}@${version}`)
}

/**
 * Shell command that installs {@link dshPeerSpecs} without writing the lockfile.
 * @param specs - `name@version` entries from {@link dshPeerSpecs}
 * @param before - the release's `--before` date (`releaseCutoff`): its packages'
 *   peers resolve to what was published with it
 */
export function pinDshPeersCommand(specs: readonly string[], before?: string): string | undefined {
  if (specs.length === 0) return undefined
  return `npm install --no-save${before === undefined ? '' : ` --before=${before}`} ${specs.join(' ')}`
}
