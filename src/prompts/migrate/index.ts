/**
 * The migration plane's prompts: the three sessions a run composes (overlap,
 * alignment, repair) plus the harness-context note appended to the first two.
 */
export {
  ABSORPTION_PROMPT,
  ALIGNMENT_PROMPT,
  FIX_PROMPT,
  assembleFixPrompt,
  harnessContextNote,
  withHarnessContext,
} from './prompts.ts'
