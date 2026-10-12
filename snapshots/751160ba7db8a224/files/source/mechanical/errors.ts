const ERROR_LINE = /^(?:error|Error|FAIL|failed|AssertionError|✖|×)\b/i
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
    if (ERROR_LINE.test(line) || TSC_LINE.test(line)) {
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
