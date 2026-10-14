import type { MigrationContext } from '../workflow/machine.ts'

/**
 * What the boot checks of the unmodified tree say about the failure.
 *
 * `regression`: it boots on the source release and not on the target, so the
 * releases in between caused the failure. `pre-existing`: it did not boot on the
 * source release either. `unaffected`: it boots on both. `unknown`: one of the
 * two checks did not run.
 */
export type BaselineClass = 'regression' | 'pre-existing' | 'unaffected' | 'unknown'

export function classifyBaseline(context: MigrationContext): BaselineClass {
  const source = context.sourceBoot?.outcome
  const target = context.targetBoot?.outcome
  if (source === undefined || target === undefined || source === 'skipped' || target === 'skipped') return 'unknown'
  if (source === 'fail') return 'pre-existing'
  return target === 'fail' ? 'regression' : 'unaffected'
}

/** One sentence for the repair prompt and the proposal. */
export function describeBaseline(context: MigrationContext): string {
  const source = context.input.source
  const target = context.input.target.tag
  switch (classifyBaseline(context)) {
    case 'regression':
      return `The unmodified plugin boots on ${source?.release.tag ?? 'the source release'} (${source?.origin ?? 'unknown origin'}) and fails on ${target}: a change between these releases caused the failure.`
    case 'pre-existing':
      return `The unmodified plugin already failed to boot on ${source?.release.tag ?? 'the source release'} (${source?.origin ?? 'unknown origin'}): it is behind by more than this release range, so look further back than ${target}.`
    case 'unaffected':
      return `The unmodified plugin boots on both ${source?.release.tag ?? 'the source release'} and ${target}.`
    case 'unknown':
      return 'No pre-migration boot comparison is available (no source release is known, or the boot check is off).'
  }
}
