import {
  mkdirSync as defaultMkdirSync,
  readFileSync as defaultReadFileSync,
  renameSync as defaultRenameSync,
  writeFileSync as defaultWriteFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir as defaultHomedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { errorMessage } from './errors.js'

/** Absolute directory of the bundled skill, resolved from this module. */
export const SKILL_DIR = fileURLToPath(new URL('../../skills/mcp-adapter/', import.meta.url))

const SKILL_FILE = 'SKILL.md'
const SKILL_TEMP_FILE = '.SKILL.md.tmp'
const SKILL_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

/** The Adapter package version, read lazily so a missing manifest never breaks load. */
function packageVersion() {
  try {
    return createRequire(import.meta.url)('../../package.json').version
  } catch {
    return 'unknown'
  }
}

/**
 * Resolve the DSH skills root the same way the harness does: `$DSH_HOME`
 * when set, otherwise `.dsh` under the OS home directory.
 */
export function resolveSkillsRoot(env = process.env, homedir = defaultHomedir) {
  return join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'skills')
}

/**
 * Split one `SKILL.md` into its frontmatter fields and body. The block must
 * open the file: `---`, flat `key: value` lines, then a closing `---`. Only
 * `name`, `description`, and `whenToUse` are read; everything after the
 * closing fence is the skill body. A missing or misplaced block throws.
 */
export function parseSkillFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (match === null) {
    throw new Error('the bundled skill file must open with a --- frontmatter block')
  }
  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line)
    if (entry !== null) fields[entry[1]] = entry[2]
  }
  return {
    name: fields.name,
    description: fields.description,
    whenToUse: fields.whenToUse === '' ? undefined : fields.whenToUse,
    body: match[0].length < text.length ? text.slice(match[0].length).replace(/^\r?\n+/, '') : '',
  }
}

/**
 * Copy the bundled `SKILL.md` to `$DSH_HOME/skills/<name>/SKILL.md` so the
 * filesystem skill provider (and with it Settings > Skills) discovers it.
 * The copy is atomic — temp file in the target directory, then rename — and
 * never a symlink or hardlink. An installed file is never overwritten: when
 * it exists and matches, nothing happens; when it differs, the human's edit
 * wins and one warning names the path and the package version. Returns true
 * when the file now carries the skill (install done or already present).
 */
function installSkillFile(ctx, text, name, {
  readInstalledFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  env,
  homedir,
}) {
  const warn = (reason) => {
    ctx.logger?.warn?.(`dsh-mcp-adapter: ${reason}`)
  }
  const targetDir = join(resolveSkillsRoot(env, homedir), name)
  const target = join(targetDir, SKILL_FILE)
  let installed
  try {
    installed = String(readInstalledFileSync(target, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      warn(
        `cannot read the installed skill file ${target} (${errorMessage(error)}); `
        + 'registering the bundled skill at runtime instead',
      )
      return false
    }
  }
  if (installed !== undefined) {
    if (installed === text) return true
    // The human's edit wins: leave the file untouched and treat it as the
    // one definition for this name.
    warn(
      `the installed skill file ${target} differs from the bundled copy `
      + `(dsh-mcp-adapter ${packageVersion()}); delete ${targetDir} to refresh `
      + 'it from the package on the next start',
    )
    return true
  }
  try {
    mkdirSync(targetDir, { recursive: true })
    const temp = join(targetDir, SKILL_TEMP_FILE)
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, target)
    return true
  } catch (error) {
    warn(
      `cannot install the skill file at ${target} (${errorMessage(error)}); `
      + 'registering the bundled skill at runtime instead',
    )
    return false
  }
}

/**
 * Install the bundled `mcp-adapter` skill so agents discover how to drive the
 * Proxy Tool. The body lives in `skills/mcp-adapter/SKILL.md` next to the
 * package root, so a human can edit the wording without touching code;
 * frontmatter still drives routing.
 *
 * The `skillInstall` mode comes from the Adapter Config (default `'file'`).
 * `'file'` copies the skill to `$DSH_HOME/skills/<name>/SKILL.md` and lets
 * the filesystem provider pick it up — one definition per name, so the
 * runtime registration is skipped. `'runtime'` registers directly on the
 * `skills` service as before. `'off'` installs nothing.
 *
 * The skill is a convenience, never a dependency: an unreadable file, bad
 * frontmatter, or a failed install logs a warning and never throws; a failed
 * file install falls back to the runtime registration. Every filesystem
 * access (`readFileSync` for the bundled copy, `readInstalledFileSync` for
 * the installed one, plus `writeFileSync`, `mkdirSync`, and `renameSync`)
 * and `dir`, `env`, and `homedir` are injectable for tests.
 */
export function installMcpSkill(ctx, {
  readFileSync = defaultReadFileSync,
  readInstalledFileSync = defaultReadFileSync,
  writeFileSync = defaultWriteFileSync,
  mkdirSync = defaultMkdirSync,
  renameSync = defaultRenameSync,
  env = process.env,
  homedir = defaultHomedir,
  dir = SKILL_DIR,
  skillInstall = 'file',
} = {}) {
  if (skillInstall === 'off') return undefined
  const fail = (reason) => {
    ctx.logger?.warn?.(`dsh-mcp-adapter: bundled skill unavailable (${reason})`)
    return undefined
  }
  try {
    const text = String(readFileSync(`${dir}${SKILL_FILE}`, 'utf8'))
    const { name, description, whenToUse, body } = parseSkillFrontmatter(text)
    if (typeof name !== 'string' || SKILL_NAME.test(name) === false) {
      return fail(`frontmatter name ${JSON.stringify(name ?? null)} is not kebab-case`)
    }
    if (typeof description !== 'string' || description === '') {
      return fail('frontmatter requires a non-empty description')
    }
    const register = () => ctx.skills.register({
      name,
      description,
      ...(whenToUse === undefined ? {} : { whenToUse }),
      source: 'runtime',
      content: body,
      resourceBase: { kind: 'directory', path: dir },
    })
    if (skillInstall !== 'runtime') {
      const installed = installSkillFile(ctx, text, name, {
        readInstalledFileSync, writeFileSync, mkdirSync, renameSync, env, homedir,
      })
      // One definition per name: the filesystem provider owns the skill once
      // the file is in place (or the human's edit already covers it).
      if (installed) return undefined
    }
    return register()
  } catch (error) {
    return fail(errorMessage(error))
  }
}
