import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export type ReportKind = 'A' | 'B' | `C${number}` | 'mechanical'

export interface ReportStore {
  runDir: string
  write(kind: ReportKind, body: string): string
  read(kind: ReportKind): string | undefined
  listFixReports(): string[]
}

/**
 * Persist A/B/C reports on disk. These files stay out of the plugin repo and PRs.
 * @param runDir - absolute run directory
 */
export function createReportStore(runDir: string): ReportStore {
  mkdirSync(runDir, { recursive: true })

  function pathFor(kind: ReportKind): string {
    return join(runDir, `${kind}.md`)
  }

  return {
    runDir,
    write(kind, body) {
      const file = pathFor(kind)
      writeFileSync(file, body, 'utf8')
      return file
    },
    read(kind) {
      const file = pathFor(kind)
      if (!existsSync(file)) return undefined
      return readFileSync(file, 'utf8')
    },
    listFixReports() {
      const reports: string[] = []
      for (let index = 1; index < 100; index += 1) {
        const text = this.read(`C${index}`)
        if (text === undefined) break
        reports.push(text)
      }
      return reports
    },
  }
}
