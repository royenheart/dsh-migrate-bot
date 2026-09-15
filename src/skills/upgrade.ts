import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { UPGRADE_SKILL_CHANNEL } from '../feedback/channels.ts'
import type { MigrateConfig } from '../config/schema.ts'

/**
 * The community upgrade knowledge, loaded into a migration only when the user
 * asked for the channel that reports back to it.
 *
 * The two are one feature from the user's side: enabling `upgrade-skill` means
 * "use their version cards while migrating, and tell them what the migration
 * found". Loading the cards without the channel would feed the migration
 * knowledge nobody asked for, and enabling the channel without the cards would
 * ask the model to report on card ids it never read.
 *
 * The skills are vendored into the image at the commit this repository's
 * submodule pins, so a migration and the benchmark score that describes it run
 * against the same snapshot.
 */

/** Where the image keeps the vendored skills. */
export const DEFAULT_SKILLS_SOURCE = '/opt/dsh-migrate/vendor/upgrade-skill/skills'

/** Environment variable overriding the vendored location, for local runs. */
export const SKILLS_SOURCE_ENV = 'DSH_MIGRATE_SKILLS_DIR'

export interface SkillsSyncResult {
  /** `installed`, `absent`, or `unavailable`. */
  status: 'installed' | 'absent' | 'unavailable'
  /** Skill directory names involved. */
  skills: string[]
  detail: string
}

/**
 * Whether the migration should load the community upgrade skills.
 * @param config - the parsed configuration.
 */
export function upgradeSkillsEnabled(config: MigrateConfig): boolean {
  return config.feedback.enabled && config.feedback.channels[UPGRADE_SKILL_CHANNEL]?.enabled === true
}

/** The vendored skills directory, or `undefined` when it is not present. */
export function skillsSource(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env[SKILLS_SOURCE_ENV]
  const source = configured === undefined || configured === '' ? DEFAULT_SKILLS_SOURCE : configured
  return existsSync(source) ? source : undefined
}

/** Skill directory names under a skills root. */
function skillNames(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter(name => statSync(join(root, name)).isDirectory())
    .filter(name => existsSync(join(root, name, 'SKILL.md')))
    .sort()
}

/**
 * Make `<dshHome>/skills` hold exactly the vendored skills when they are wanted,
 * and none of them when they are not.
 *
 * dsh discovers skills in `<dshHome>/skills` through the filesystem skill
 * provider the `standard` preset mounts, so this is the whole wiring: the
 * directory either carries the community knowledge for this session or it does
 * not. Only the directories this function manages are removed, so a presets
 * directory or a user's own skill is never touched.
 * @param input.dshHome - the dsh home the session will run under.
 * @param input.enabled - whether the `upgrade-skill` channel is on.
 * @param input.source - the vendored skills directory.
 * @param input.log - sink for one line describing what happened.
 */
export function syncUpgradeSkills(input: {
  dshHome: string | undefined
  enabled: boolean
  source: string | undefined
  log: (message: string) => void
}): SkillsSyncResult {
  const configured = input.dshHome ?? process.env.DSH_HOME
  if (configured === undefined || configured === '') {
    return { status: 'unavailable', skills: [], detail: 'no DSH_HOME is known, so no skill root can be written' }
  }
  const target = join(configured, 'skills')
  const vendored = input.source === undefined ? [] : skillNames(input.source)

  if (!input.enabled) {
    const removed = skillNames(target).filter(name => vendored.includes(name))
    for (const name of removed) rmSync(join(target, name), { recursive: true, force: true })
    return {
      status: 'absent',
      skills: [],
      detail: removed.length === 0
        ? 'upgrade-skill channel is off; no community skill was loaded'
        : `upgrade-skill channel is off; removed ${removed.join(', ')}`,
    }
  }

  if (input.source === undefined) {
    return {
      status: 'unavailable',
      skills: [],
      detail: `the upgrade-skill channel is on but no vendored skills are present (looked in ${process.env[SKILLS_SOURCE_ENV] ?? DEFAULT_SKILLS_SOURCE})`,
    }
  }

  mkdirSync(target, { recursive: true })
  for (const name of vendored) {
    const destination = join(target, name)
    rmSync(destination, { recursive: true, force: true })
    cpSync(join(input.source, name), destination, { recursive: true })
  }
  return {
    status: 'installed',
    skills: vendored,
    detail: `loaded ${vendored.join(', ')} into ${target}`,
  }
}
