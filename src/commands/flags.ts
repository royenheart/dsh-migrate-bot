/**
 * How a subcommand's flags are read.
 *
 * They live here rather than inside `cli.ts` so the mapping from an argument
 * list to the thing a subcommand does is a unit that can be tested: the CLI
 * cannot be imported, and a flag whose wiring is only visible in `main` is a
 * flag that silently stops working when somebody edits the wrong line.
 */

/** What the `run` subcommand decides from its arguments. */
export interface RunFlags {
  /** Run even though dsh has not changed since the last successful run. */
  force: boolean
  /** Run even while a migrate pull request is open, which opens a second one. */
  allowSecond: boolean
  /** The fast gate only, no agent session. */
  mechanicalOnly: boolean
  /** Leave GitHub alone: no issue, no pull request, no comment. */
  skipGithub: boolean
}

/**
 * Read the flags that change what a migration run does.
 *
 * `allowSecond` implies a forced run: asking for a second pull request on a
 * version the state already records is a deliberate re-run, and the
 * unchanged-version gate would otherwise stop the run before the override could
 * ever be reached.
 * @param argv - the process arguments.
 */
export function runFlags(argv: readonly string[]): RunFlags {
  const mechanicalOnly = argv.includes('--mechanical-only')
  return {
    force: argv.includes('--force') || argv.includes('--allow-second-pr'),
    allowSecond: argv.includes('--allow-second-pr'),
    mechanicalOnly,
    skipGithub: argv.includes('--skip-github') || mechanicalOnly,
  }
}

/** What the `feedback` subcommand decides from its arguments. */
export interface FeedbackFlags {
  /** Produce and print each channel's payload without delivering it. */
  dryRun: boolean
  /** Report a merge to a channel that already received it. */
  resend: boolean
  /** The old name for `resend`, warned about rather than obeyed. */
  legacyForce: boolean
}

/**
 * Read the flags that change what a feedback run does.
 * @param argv - the process arguments.
 */
export function feedbackFlags(argv: readonly string[]): FeedbackFlags {
  return {
    dryRun: argv.includes('--dry-run'),
    resend: argv.includes('--resend'),
    legacyForce: argv.includes('--force') && !argv.includes('--resend'),
  }
}
