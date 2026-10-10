import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { QuotaError } from '../quota/errors.ts'
import {
  decodeStatusLine,
  formatSessionProgress,
  isInsufficientBalanceText,
  isQuotaLimitText,
  type SessionProgress,
} from './session-status.ts'
import type { AgentRequest, AgentResult, AgentRunner } from './types.ts'

const REPORT_FENCE = /^```(?:markdown)?\n([\s\S]*?)\n```$/m

/**
 * Last markdown document in the agent stdout, stripping a wrapping fence if present.
 */
export function extractReport(stdout: string): string {
  const trimmed = stdout.trim()
  if (trimmed === '') return ''
  const fenced = trimmed.match(REPORT_FENCE)
  if (fenced?.[1] !== undefined) return fenced[1].trim()
  const heading = trimmed.lastIndexOf('\n# ')
  if (heading >= 0) return trimmed.slice(heading + 1).trim()
  return trimmed
}

export interface DshSpawnResult {
  code: number
  stdout: string
  stderr: string
  /** The watchdog killed the session instead of it finishing. */
  timedOut: boolean
}

export interface DshSpawn {
  (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<DshSpawnResult>
}

/**
 * One session gets a wall-clock watchdog. dsh has no hang protection of its
 * own: a plugin whose `apply` never resolves, or a provider call that stops
 * responding, leaves the process alive forever and the job holds until the
 * runner's own limit. A timeout is reported as a failed session, with the
 * partial output kept so the report says what was happening.
 */
export const DEFAULT_AGENT_TIMEOUT_MS = 60 * 60_000

export class AgentTimeoutError extends Error {
  override readonly name = 'AgentTimeoutError'
}

function takeLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\r?\n/)
  const rest = parts.pop() ?? ''
  return { lines: parts, rest }
}

function defaultSpawn(
  args: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    timeoutMs: number
    onStatus?: ((progress: SessionProgress) => void) | undefined
    onLog?: ((line: string) => void) | undefined
  },
): Promise<DshSpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.DSH_BIN ?? 'dsh', args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      options.onLog?.(`dsh-migrate: session watchdog fired after ${Math.round(options.timeoutMs / 1000)}s; killing it`)
      child.kill('SIGTERM')
      setTimeout(() => { child.kill('SIGKILL') }, 10_000).unref?.()
    }, options.timeoutMs)
    timer.unref?.()
    let stdout = ''
    let stderr = ''
    let stderrRest = ''
    let quotaSeen = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => {
      const text = String(chunk)
      stderr += text
      const split = takeLines(stderrRest + text)
      stderrRest = split.rest
      for (const line of split.lines) {
        const progress = decodeStatusLine(line)
        if (progress !== undefined) {
          options.onStatus?.(progress)
          continue
        }
        if (line.startsWith('dsh-migrate:')) {
          options.onLog?.(line)
          if (isInsufficientBalanceText(line)) quotaSeen = line
        }
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (stderrRest !== '') {
        const progress = decodeStatusLine(stderrRest)
        if (progress !== undefined) options.onStatus?.(progress)
        else if (stderrRest.startsWith('dsh-migrate:')) {
          options.onLog?.(stderrRest)
          if (isInsufficientBalanceText(stderrRest)) quotaSeen = stderrRest
        }
      }
      resolve({ code: code ?? 1, stdout, stderr, timedOut })
    })
  })
}

/**
 * Drive one dsh headless-style session through the migrate profile of the
 * agent runtime. LLM text stays in the captured stdout and is not printed live.
 */
export function createDshRunner(options: {
  spawnImpl?: DshSpawn | undefined
  dshHome?: string | undefined
  reportDir?: string | undefined
  /** Wall-clock watchdog for one session. */
  timeoutMs?: number | undefined
  onStatus?: ((progress: SessionProgress) => void) | undefined
  onLog?: ((line: string) => void) | undefined
} = {}): AgentRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS
  const spawnImpl = options.spawnImpl
  return {
    async run(request: AgentRequest): Promise<AgentResult> {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DEEPSEEK_API_KEY: request.apiKey,
        DSH_MIGRATE_PROVIDER: request.dsh.provider,
        DSH_MIGRATE_MODEL: request.dsh.model,
        DSH_MIGRATE_THINKING: request.dsh.thinking,
        DSH_MIGRATE_EFFORT: request.dsh.reasoningEffort,
        // The job's container is the isolation boundary, and a headless session
        // has nobody to answer an approval prompt.
        DSH_PERMISSION_MODE: 'danger-full-access',
        DSH_MIGRATE_TASK: request.prompt,
        DSH_MIGRATE_STATUS_INTERVAL_MS: process.env.DSH_MIGRATE_STATUS_INTERVAL_MS ?? '10000',
        DSH_MIGRATE_USAGE_SO_FAR: String(request.usageSoFar ?? 0),
      }
      if (request.usageLimit !== undefined) env.DSH_MIGRATE_USAGE_LIMIT = String(request.usageLimit)
      if (options.dshHome !== undefined) env.DSH_HOME = options.dshHome

      let lastUsage: SessionProgress | undefined
      const onStatus = (progress: SessionProgress) => {
        lastUsage = progress
        options.onStatus?.(progress)
      }
      const result = spawnImpl === undefined
        ? await defaultSpawn(
          ['--profile', 'migrate', request.prompt],
          {
            cwd: request.workdir,
            env,
            timeoutMs,
            onStatus,
            ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
          },
        )
        : await spawnImpl(
          ['--profile', 'migrate', request.prompt],
          { cwd: request.workdir, env, timeoutMs },
        )
      if (result.timedOut === true) {
        if (options.reportDir !== undefined) {
          mkdirSync(options.reportDir, { recursive: true })
          writeFileSync(join(options.reportDir, `${request.kind}.raw.txt`), result.stdout, 'utf8')
        }
        throw new AgentTimeoutError(
          `dsh session (${request.kind}) exceeded its ${Math.round(timeoutMs / 1000)}s watchdog and was killed`
          + `\n--- last stderr ---\n${result.stderr.trim().slice(-2000)}`,
        )
      }
      const combined = `${result.stderr}\n${result.stdout}`
      if (isQuotaLimitText(combined)) {
        throw new QuotaError('limit_exceeded', result.stderr.trim() || result.stdout.trim())
      }
      if (isInsufficientBalanceText(combined)) {
        throw new QuotaError(
          'insufficient_balance',
          `insufficient balance: dsh aborted the session (${result.stderr.trim() || result.stdout.trim()})`,
        )
      }
      if (result.code !== 0) {
        throw new Error(`dsh agent failed (${result.code}): ${result.stderr || result.stdout}`)
      }
      const report = extractReport(result.stdout)
      if (options.reportDir !== undefined) {
        mkdirSync(options.reportDir, { recursive: true })
        writeFileSync(join(options.reportDir, `${request.kind}.raw.txt`), result.stdout, 'utf8')
      }
      return {
        report,
        raw: result.stdout,
        ...(lastUsage === undefined ? {} : { usage: lastUsage }),
      }
    },
  }
}

export { formatSessionProgress }
