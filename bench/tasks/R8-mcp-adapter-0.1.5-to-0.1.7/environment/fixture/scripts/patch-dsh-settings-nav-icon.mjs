// Patches the installed DSH settings shell so the `mcp` section nav row gets
// a connection icon instead of the generic settings-gear fallback. The icon
// mapping is shell chrome inside dsh-client-ui-settings-general — this repo's
// plugin cannot reach it through the settings.section slot, so the fix is a
// one-branch insert into the installed bundle. The marker comment
// `// dsh-mcp-adapter` makes the insert idempotent and revertible.
//
// Usage:
//   node scripts/patch-dsh-settings-nav-icon.mjs [--dsh-root <path>] [--icon <IconName>] [--revert]
//
// After patching, restart `dsh web` and refresh the page: the server composes
// module combos at boot and caches them by content hash.
// A DSH upgrade replaces the patched file — run the script again.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKER = '// dsh-mcp-adapter'
const SHELL_RELATIVE = join(
  'node_modules', '@deepseek-ai', 'dsh-client-ui-settings-general', 'lib', 'client.js',
)

function parseArgs(argv) {
  const options = { revert: false, icon: 'IconLinkOutline16', dshRoot: process.env.DSH_ROOT }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--revert') options.revert = true
    else if (arg === '--icon') options.icon = argv[++index]
    else if (arg === '--dsh-root') options.dshRoot = argv[++index]
    else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(1)
    }
  }
  return options
}

function candidateRoots() {
  const roots = []
  try {
    roots.push(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@deepseek-ai', 'dsh'))
  } catch {
    // npm is unavailable; skip the global-root candidate.
  }
  return roots
}

function locateShellFile(dshRoot) {
  const roots = [...(dshRoot !== undefined ? [dshRoot] : []), ...candidateRoots()]
  for (const root of roots) {
    const file = join(root, SHELL_RELATIVE)
    if (existsSync(file)) return file
  }
  console.error(
    `Could not locate ${SHELL_RELATIVE}.\n` +
      'Pass the DSH install root with --dsh-root <path> or DSH_ROOT=<path>.\n' +
      'The root is the directory containing the @deepseek-ai/dsh package.',
  )
  process.exit(1)
}

/** The models branch, with every build-generated identifier captured. */
const MODELS_BRANCH = /(\t+)if \(id === "models"\) return \(0, ([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*)\.IconDataOutline16, \{\n\t+className: ([A-Za-z_$][\w$]*)\.navIcon,\n\t+size: 16\n\t+\}\);/

function buildMcpBranch(indent, jsxRuntime, primitivesModule, cssModule, iconName) {
  return [
    `${indent}if (id === "mcp") return (0, ${jsxRuntime}.jsx)(${primitivesModule}.${iconName}, {`,
    `${indent}\tclassName: ${cssModule}.navIcon,`,
    `${indent}\tsize: 16`,
    `${indent}}); ${MARKER}`,
  ].join('\n')
}

const MCP_BRANCH = new RegExp(
  `\\n\\t+if \\(id === "mcp"\\) return \\(0, [A-Za-z_$][\\w$]*\\.jsx\\)\\([A-Za-z_$][\\w$]*\\.Icon\\w+, \\{\\n\\t+className: [A-Za-z_$][\\w$]*\\.navIcon,\\n\\t+size: 16\\n\\t+\\}\\); ${MARKER.replace(/\//g, '\\/')}`,
)

const options = parseArgs(process.argv.slice(2))
const file = locateShellFile(options.dshRoot)
const source = readFileSync(file, 'utf8')

if (options.revert) {
  if (!MCP_BRANCH.test(source)) {
    console.log(`No ${MARKER} insert found in ${file}; nothing to revert.`)
    process.exit(0)
  }
  writeFileSync(file, source.replace(MCP_BRANCH, ''))
  console.log(`Reverted the mcp nav icon in ${file}`)
  process.exit(0)
}

if (source.includes(MARKER)) {
  console.log(`${file} already carries the ${MARKER} insert; nothing to do.`)
  process.exit(0)
}

const match = MODELS_BRANCH.exec(source)
if (match === null) {
  console.error(
    `Could not find the models branch of navIcon() in ${file}.\n` +
      'The DSH build changed; update the MODELS_BRANCH pattern in this script.',
  )
  process.exit(1)
}
const [, indent, jsxRuntime, primitivesModule, cssModule] = match
const insert = `\n${buildMcpBranch(indent, jsxRuntime, primitivesModule, cssModule, options.icon)}`
writeFileSync(file, source.replace(match[0], `${match[0]}${insert}`))
console.log(`Patched ${file}`)
console.log(`The mcp nav row now uses ${options.icon}. Restart dsh web, then refresh the page.`)
