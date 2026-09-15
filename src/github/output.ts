import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

/**
 * Write step outputs for a Docker GitHub Action (`$GITHUB_OUTPUT`).
 * No-op outside Actions.
 *
 * A value with a newline in it is written with the heredoc form the runner
 * parses, and the delimiter is drawn per write rather than fixed: a fixed one is
 * a line a value could contain, and everything after it would be read as the
 * next output.
 * @param fields - the outputs to write; `undefined` values are skipped.
 */
export function writeGithubOutput(fields: Record<string, string | undefined>): void {
  const file = process.env.GITHUB_OUTPUT
  if (file === undefined || file === '') return
  const delimiter = `MIGRATE_EOF_${randomUUID().replace(/-/g, '')}`
  const lines: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (/[\n\r]/.test(value)) {
      lines.push(`${key}<<${delimiter}`, value, delimiter)
    } else {
      lines.push(`${key}=${value}`)
    }
  }
  if (lines.length === 0) return
  appendFileSync(file, `${lines.join('\n')}\n`, 'utf8')
}
