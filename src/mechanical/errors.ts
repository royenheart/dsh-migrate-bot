const ERROR_LINE = /^(?:error|Error|FAIL|failed|AssertionError|✖|×)\b/i
/** npm prefixes every line of its error, `npm error <text>` (npm 10+) or `npm ERR! <text>`; a bare prefix is a blank line. */
const NPM_ERROR_LINE = /^npm (?:error|ERR!) \S/
const TSC_LINE = /error TS\d+/
const STACK_LINE = /^\s+at\s+/

/**
 * Keep only failing lines from a mechanical run. Full logs stay off the agent context.
 * @param output - combined stdout+stderr
 */
export function extractMechanicalErrors(output: string): string {
  const lines = output.split(/\r?\n/)
  const kept: string[] = []
  for (const line of lines) {
    if (ERROR_LINE.test(line) || TSC_LINE.test(line) || NPM_ERROR_LINE.test(line)) {
      kept.push(line)
      continue
    }
    if (kept.length > 0 && STACK_LINE.test(line) && kept.length < 40) {
      kept.push(line)
    }
  }
  const text = kept.join('\n').trim()
  if (text !== '') return text.slice(0, 4000)
  const fallback = output.trim().split(/\r?\n/).slice(-20).join('\n')
  return fallback.slice(0, 2000)
}

/**
 * The first three error lines, which identify a failure across repair
 * attempts: one line is not enough when a tool spreads one error over several,
 * as npm does with `ERESOLVE unable to resolve dependency tree` followed by the
 * packages in conflict.
 * @param errors - the output of {@link extractMechanicalErrors}
 */
export function errorSummary(errors: string): string {
  // npm's `code X` line only repeats the next line's first word.
  const lines = errors.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '' && !STACK_LINE.test(` ${line}`) && !/^npm (?:error|ERR!) code \S+$/.test(line))
  return lines.slice(0, 3).join(' | ')
}
