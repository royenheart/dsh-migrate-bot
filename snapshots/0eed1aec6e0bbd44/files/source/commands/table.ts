/**
 * The comment commands: `/dsh-migrate <verb>` on a proposal's issue or pull
 * request. `docs/reference/commands.md` is generated from this table.
 */

/** The prefix a comment must carry. */
export const COMMAND_PREFIX = '/dsh-migrate'

export interface CommandSpec {
  verb: string
  summary: string
  /** Whether it needs a configured deploy service. */
  needsDeployService: boolean
  /** Flags this verb accepts, written as they appear in a comment. */
  flags: readonly string[]
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    verb: 'status',
    summary: 'Report the processed and verified releases, the open proposal, every report channel, and the preview deployment.',
    needsDeployService: false,
    flags: [],
  },
  {
    verb: 'report',
    summary: 'Send the merge report to the enabled channels that have not taken it; `--resend` sends it to every enabled channel again; `--dry-run` shows what each channel would send.',
    needsDeployService: false,
    flags: ['--dry-run', '--resend'],
  },
  {
    verb: 'redeploy',
    summary: 'Rebuild the preview deployment of this pull request from its current head.',
    needsDeployService: true,
    flags: [],
  },
  {
    verb: 'destroy',
    summary: 'Remove the preview deployment and its working copy.',
    needsDeployService: true,
    flags: [],
  },
  {
    verb: 'extend',
    summary: 'Ask the deploy service to extend the preview deployment by `deploy.preview.extendDays`, at most to `deploy.preview.ttlDays`.',
    needsDeployService: true,
    flags: [],
  },
  {
    verb: 'publish',
    summary: 'Apply the preview working copy to the pull request branch after the checks pass.',
    needsDeployService: true,
    flags: [],
  },
]

export const COMMANDS_BY_VERB: Record<string, CommandSpec> = Object.fromEntries(COMMANDS.map(spec => [spec.verb, spec]))

/** The verb list as help text. */
export function renderCommandHelp(): string {
  return COMMANDS.map((spec) => {
    const flags = spec.flags.map(flag => ` [${flag}]`).join('')
    return `- \`${COMMAND_PREFIX} ${spec.verb}${flags}\` — ${spec.summary}`
  }).join('\n')
}
