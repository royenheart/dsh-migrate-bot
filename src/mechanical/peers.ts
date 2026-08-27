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
 * npm install specs for every `@deepseek-ai/dsh-*` dependency named by the plugin.
 * @param pkg - parsed package.json
 * @param version - resolved harness version (no `dsh-v` prefix)
 */
export function dshPeerSpecs(pkg: unknown, version: string): string[] {
  if (typeof pkg !== 'object' || pkg === null) return []
  const record = pkg as Record<string, unknown>
  const names = new Set<string>()
  for (const key of ['peerDependencies', 'devDependencies', 'dependencies']) {
    for (const name of dependencyNames(record, key)) {
      if (name.startsWith(DSH_SCOPE)) names.add(name)
    }
  }
  return [...names].sort().map(name => `${name}@${version}`)
}

/**
 * Shell command that installs {@link dshPeerSpecs} without writing the lockfile.
 * @param specs - `name@version` entries from {@link dshPeerSpecs}
 */
export function pinDshPeersCommand(specs: readonly string[]): string | undefined {
  if (specs.length === 0) return undefined
  return `npm install --no-save ${specs.join(' ')}`
}
