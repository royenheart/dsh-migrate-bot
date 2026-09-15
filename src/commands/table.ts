/**
 * The command vocabulary.
 *
 * One table, two callers: a comment on the migrate issue or pull request, and
 * the deploy target's own surface. A single table is what keeps them from
 * drifting into disagreeing about who may do what, and it is why adding a verb
 * is one entry rather than two implementations.
 *
 * A verb either instructs the deploy target or asks this Action to do something
 * it could already do; `publish` is the only one that changes a repository, and
 * it is gated for that reason.
 *
 * Each entry also declares whether running it can change something outside this
 * run, because that is what decides whether a repeat of the same command is
 * suppressed. It is declared here rather than derived at the call site so that a
 * new verb has to answer the question instead of inheriting a silent default.
 */

/** Trigger phrase a comment must carry. */
export const COMMAND_PREFIX = '/dsh-migrate'

/** One verb's shape and requirements. */
export interface CommandSpec {
  verb: string
  summary: string
  /** Whether running it puts a change on the pull request branch. */
  gated: boolean
  /** Whether it needs a configured deploy target. */
  needsTarget: boolean
  /** Flags this verb accepts, each written as it appears in a comment. */
  flags: readonly string[]
  /**
   * Whether running it can change anything outside this run.
   *
   * `'never'` — read-only, so a repeat costs nothing and is not recorded.
   * `'unless-dry-run'` — it acts, but a declared dry run does not.
   * `'always'` — it acts, and no flag makes it harmless.
   */
  effectful: 'never' | 'unless-dry-run' | 'always'
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    verb: 'status',
    summary: 'Report the recorded state, the open migrate pull request, and every feedback channel with its reason',
    gated: false,
    needsTarget: false,
    flags: [],
    effectful: 'never',
  },
  {
    verb: 'feedback',
    summary: 'Send the enabled feedback channels now, print what they would send with `--dry-run`, or report a merge again to a channel that already received it with `--resend`',
    gated: false,
    needsTarget: false,
    flags: ['--dry-run', '--resend'],
    effectful: 'unless-dry-run',
  },
  {
    verb: 'redeploy',
    summary: 'Rebuild the preview for this pull request from its current head',
    gated: false,
    needsTarget: true,
    flags: [],
    effectful: 'always',
  },
  {
    verb: 'destroy',
    summary: 'Tear the preview down and discard its scratch tree',
    gated: false,
    needsTarget: true,
    flags: [],
    effectful: 'always',
  },
  {
    verb: 'extend',
    summary: 'Ask the target to push the preview expiry out by `deploy.preview.extendDays`, within the ceiling it may not pass',
    gated: false,
    needsTarget: true,
    flags: [],
    effectful: 'always',
  },
  {
    verb: 'publish',
    summary: 'Hand the preview scratch diff to this Action, which runs the gates before anything reaches the branch',
    gated: true,
    needsTarget: true,
    flags: [],
    effectful: 'always',
  },
]

/** The verb table keyed by verb. */
export const COMMANDS_BY_VERB: Record<string, CommandSpec> = Object.fromEntries(
  COMMANDS.map(spec => [spec.verb, spec]),
)

/**
 * Whether a repeat of this command must be suppressed.
 * @param spec - the verb's declaration.
 * @param flags - the flags the command was written with.
 */
export function commandHasEffect(spec: CommandSpec, flags: readonly string[]): boolean {
  if (spec.effectful === 'never') return false
  if (spec.effectful === 'unless-dry-run') return !flags.includes('--dry-run')
  return true
}

/**
 * How a comment is rendered into help, so the reply teaches the vocabulary.
 *
 * A flag is written as an option rather than as part of the command: `--dry-run
 * --resend` reads as one instruction, and the two do opposite things.
 */
export function renderCommandHelp(): string {
  return COMMANDS.map((spec) => {
    const flags = spec.flags.map(flag => ` [${flag}]`).join('')
    return `- \`${COMMAND_PREFIX} ${spec.verb}${flags}\` — ${spec.summary}`
  }).join('\n')
}
