import { appendFileSync } from 'node:fs'

/**
 * Write step outputs for a Docker GitHub Action (`$GITHUB_OUTPUT`).
 * No-op outside Actions.
 */
export function writeGithubOutput(fields: Record<string, string | undefined>): void {
  const file = process.env.GITHUB_OUTPUT
  if (file === undefined || file === '') return
  const lines: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (/[\n\r]/.test(value)) {
      lines.push(`${key}<<MIGRATE_EOF`, value, 'MIGRATE_EOF')
    } else {
      lines.push(`${key}=${value}`)
    }
  }
  if (lines.length === 0) return
  appendFileSync(file, `${lines.join('\n')}\n`, 'utf8')
}
