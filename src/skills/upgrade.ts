import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The community upgrade skills in agent sessions.
 *
 * The image vendors `oh-my-dsh/dsh-plugin-upgrade-skill` at the commit the
 * `vendor/dsh-plugin-upgrade-skill` submodule pins. A session that should use
 * them finds the skills below in `<DSH_HOME>/skills`; any other session finds
 * none of them there. Only `plugin-upgrade` is loaded, as the upstream
 * benchmark protocol attaches it: the other skills are for authoring that
 * project's own cards and benchmark cases.
 */

export const UPGRADE_SKILLS = ['plugin-upgrade'] as const

/** Where the image keeps the vendored skills; `DSH_MIGRATE_SKILLS_DIR` overrides it. */
export const DEFAULT_SKILLS_SOURCE = '/opt/dsh-migrate/vendor/upgrade-skill/skills'

export function skillsSource(env: NodeJS.ProcessEnv): string {
  const configured = env.DSH_MIGRATE_SKILLS_DIR
  return configured === undefined || configured === '' ? DEFAULT_SKILLS_SOURCE : configured
}

/**
 * Load or unload the upgrade skills in a dsh home.
 * @returns one line saying what happened.
 */
export function syncUpgradeSkills(input: { dshHome: string; enabled: boolean; source: string }): string {
  const target = join(input.dshHome, 'skills')
  if (!input.enabled) {
    for (const name of UPGRADE_SKILLS) rmSync(join(target, name), { recursive: true, force: true })
    return 'upgrade skills: not loaded'
  }
  const missing = UPGRADE_SKILLS.filter(name => !existsSync(join(input.source, name, 'SKILL.md')))
  if (missing.length > 0) throw new Error(`upgrade skills: ${missing.join(', ')} not found in ${input.source}`)
  mkdirSync(target, { recursive: true })
  for (const name of UPGRADE_SKILLS) {
    rmSync(join(target, name), { recursive: true, force: true })
    cpSync(join(input.source, name), join(target, name), { recursive: true })
  }
  return `upgrade skills: loaded ${UPGRADE_SKILLS.join(', ')}`
}
