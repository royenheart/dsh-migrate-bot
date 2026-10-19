import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import ts from 'typescript'

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
        if (block === 'peerDependencies' && meta[name]?.optional === true) {
          // npm installs it for nobody, but dsh still holds every peer range to the release, prereleases included.
          if (!semver.satisfies(target, range, { includePrerelease: true })) findings.push({ message: `${block}: ${name} is "${range}", which dsh refuses on ${target}` })
          continue
        }
        findings.push({ message: `${block}: ${name} is not published at ${target}; the harness removed or renamed it (last published ${versions.at(-1) ?? 'never'})` })
      } else if (!semver.satisfies(target, range)) {
        findings.push({ message: `${block}: ${name} is "${range}", which does not admit ${target}` })
      }
    }
  }
  return findings
}

/** Directories of build output, which the plugin's build regenerates from its sources. */
const BUILD_OUTPUT = new Set(['node_modules', 'lib', 'dist', 'build'])
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/

/**
 * The other half of the contract: what the plugin's sources refer to. A source
 * that still imports a dsh package the release does not publish fails at
 * runtime whatever the manifest declares, a type that names one fails the
 * typecheck, and a review can mark the change done while one reference
 * remains. The tracked sources are parsed with TypeScript, JSDoc included:
 * imports, re-exports, \`require\`, \`import()\` and \`import('…')\` types. Build
 * output is left out, since the build regenerates it.
 * @param root - the plugin's directory, inside a git checkout
 */
export function checkSourceImports(root: string, target: string, published: (name: string) => readonly string[] | undefined): DependencyFinding[] {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  if (listed.status !== 0) return []
  const findings: DependencyFinding[] = []
  for (const file of listed.stdout.split('\0')) {
    // A tracked file the migration deleted is still listed by git.
    if (!SOURCE_FILE.test(file) || file.split('/').some(segment => BUILD_OUTPUT.has(segment)) || !existsSync(join(root, file))) continue
    const source = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
    const reported = new Set<string>()
    for (const specifier of moduleReferences(source)) {
      const name = /^(@deepseek-ai\/dsh-[^/]+)/.exec(specifier.text)?.[1]
      if (name === undefined || reported.has(name)) continue
      const versions = published(name)
      if (versions === undefined || versions.includes(target)) continue
      reported.add(name)
      const line = source.getLineAndCharacterOfPosition(specifier.getStart(source)).line + 1
      findings.push({ message: `${file}:${String(line)} refers to ${name}, which ${target} does not publish (last published ${versions.at(-1) ?? 'never'})` })
    }
  }
  return findings
}

/** Every module specifier a source names, in source order. */
function moduleReferences(source: ts.SourceFile): ts.StringLiteralLike[] {
  const found: ts.StringLiteralLike[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) found.push(node.moduleSpecifier)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const [argument] = node.arguments
      if (argument !== undefined && ts.isStringLiteralLike(argument)) found.push(argument)
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) found.push(node.argument.literal)
    // JSDoc is attached to its host node rather than reached by forEachChild.
    for (const doc of (node as { jsDoc?: ts.Node[] }).jsDoc ?? []) visit(doc)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
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
