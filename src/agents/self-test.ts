import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The agent runtime self-test.
 *
 * It starts one session through the migrate profile without an API key. A
 * runtime whose profile composes cleanly stops at the credential check with
 * `MISSING_CREDENTIAL`; any other ending means agent sessions cannot run, which
 * is a fault of this Action and not of the plugin being migrated.
 */

export interface SelfTestResult {
  ok: boolean
  detail: string
}

const SELF_TEST_TIMEOUT_MS = 120_000

/**
 * Classify the output of a keyless session.
 * @param output - exit code and both streams of the session process.
 */
export function classifySelfTest(output: { code: number | null; stdout: string; stderr: string }): SelfTestResult {
  const text = `${output.stderr}\n${output.stdout}`
  if (text.includes('did not activate')) {
    return { ok: false, detail: `a profile entry did not activate:\n${lastLines(text)}` }
  }
  if (!text.includes('MISSING_CREDENTIAL')) {
    return { ok: false, detail: `the session did not reach the credential check (exit ${String(output.code)}):\n${lastLines(text)}` }
  }
  return { ok: true, detail: 'the migrate profile reached the credential check' }
}

/**
 * Run the self-test against the installed agent runtime.
 * @param options.bin - the dsh executable, as `DSH_BIN` names it for agent
 *   sessions; defaults to `dsh` on the PATH.
 * @param options.dshHome - the home holding the migrate profile.
 */
export function runSelfTest(options: { bin?: string | undefined; dshHome?: string | undefined } = {}): SelfTestResult {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-migrate-self-test-'))
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, DSH_MIGRATE_STATUS_INTERVAL_MS: '60000' }
    delete env.DEEPSEEK_API_KEY
    if (options.dshHome !== undefined) env.DSH_HOME = options.dshHome
    const result = spawnSync(options.bin ?? 'dsh', ['--profile', 'migrate', 'self-test'], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: SELF_TEST_TIMEOUT_MS,
    })
    if (result.error !== undefined) return { ok: false, detail: result.error.message }
    return classifySelfTest({ code: result.status, stdout: result.stdout, stderr: result.stderr })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

function lastLines(text: string): string {
  return text.trim().split('\n').slice(-12).join('\n')
}
