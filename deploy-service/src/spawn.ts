import { spawn } from 'node:child_process'

/**
 * Run a program to completion with a watchdog and a bound on its output.
 *
 * Every process the service starts and waits for goes through here: git, the
 * Docker CLI, and the launcher's `install` and `check`. A process that runs past
 * `timeoutMs` or writes more than `maxBytes` is killed, and the result says so.
 */

export interface SpawnResult {
  /** The exit code; `null` when the process was killed or could not start. */
  code: number | null
  stdout: string
  /** `stdout` exactly as written, for output that is not UTF-8 text, such as a diff. */
  stdoutBytes: Buffer
  stderr: string
  /** Killed by the watchdog or the output bound. */
  killed: 'timeout' | 'output' | undefined
  /** Why the process could not start, when it could not. */
  error: string | undefined
}

/**
 * Run a program and collect what it wrote.
 * @param bin - the program.
 * @param args - its arguments.
 * @param options.cwd - where to run.
 * @param options.env - its whole environment; the service's own when absent.
 * @param options.timeoutMs - when to kill it.
 * @param options.maxBytes - the most stdout and stderr together it may write.
 */
export function runProcess(bin: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number }): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    let killed: SpawnResult['killed']
    const collect = (into: Buffer[]) => (chunk: Buffer): void => {
      size += chunk.byteLength
      if (size > options.maxBytes) {
        killed ??= 'output'
        child.kill('SIGKILL')
        return
      }
      into.push(chunk)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    const timer = setTimeout(() => {
      killed ??= 'timeout'
      child.kill('SIGKILL')
    }, options.timeoutMs)
    let error: string | undefined
    child.on('error', (failure) => { error = failure.message })
    child.on('close', (code) => {
      clearTimeout(timer)
      const bytes = Buffer.concat(stdout)
      resolve({ code, stdout: bytes.toString('utf8'), stdoutBytes: bytes, stderr: Buffer.concat(stderr).toString('utf8'), killed, error })
    })
  })
}
