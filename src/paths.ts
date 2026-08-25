import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Walk up from a compiled or source file until the app root (has fixtures/).
 */
export function appRootFrom(moduleUrl: string): string {
  let dir = dirname(fileURLToPath(moduleUrl))
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'fixtures/plugins/typecheck-ok/package.json'))) return dir
    dir = dirname(dir)
  }
  throw new Error('could not locate dsh-migrate app root from ' + moduleUrl)
}
