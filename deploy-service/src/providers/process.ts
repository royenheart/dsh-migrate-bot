import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '../spawn.ts'
import { buildResult, CHECK_TIMEOUT_MS, INSTALL_TIMEOUT_MS, LAUNCHER, OUTPUT_BYTES, waitForReady } from './common.ts'
import type { BuildResult, InstanceProvider, InstanceSpec, RunningInstance } from './types.ts'

/**
 * Instances as child processes of the service, on the service's own host.
 *
 * For CI and tests: it needs no image build and no container runtime. It
 * isolates nothing — the plugin's install scripts and the plugin itself run
 * with the service's user and can read the service's files — so it is not for
 * a deployment that previews code its operator has not read. What it does
 * withhold is the service's environment: the plugin's processes get `PATH`,
 * `HOME`, the dsh binary and the launcher's own variables, never the deploy
 * token or the webhook secret.
 */

export interface ProcessProviderOptions {
  /** The dsh binary; when absent, `dshVersion` is installed under `dataDir`. */
  dshBin?: string | undefined
  dshVersion?: string | undefined
  dataDir: string
  log: (message: string) => void
}

/**
 * The whole environment of a process that runs the plugin's code.
 * @param bin - the dsh binary.
 * @param dataDir - the service's data directory, for npm's cache.
 * @param extra - the launcher's variables.
 */
export function instanceEnv(bin: string, dataDir: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    DSH_BIN: bin,
    npm_config_cache: join(dataDir, 'npm-cache'),
    ...extra,
  }
}

interface Instance {
  children: ChildProcess[]
  running?: RunningInstance
}

export class ProcessProvider implements InstanceProvider {
  private readonly instances = new Map<string, Instance>()
  private installing: Promise<string> | undefined

  constructor(private readonly options: ProcessProviderOptions) {}

  /** The dsh binary, installed once per version when the service was not given one. */
  private async dsh(): Promise<string> {
    if (this.options.dshBin !== undefined) return this.options.dshBin
    const version = this.options.dshVersion ?? ''
    const prefix = join(this.options.dataDir, 'dsh', `dsh-${version}`)
    const bin = join(prefix, 'bin', 'dsh')
    if (existsSync(bin)) return bin
    this.installing ??= (async () => {
      this.options.log(`installing @deepseek-ai/dsh@${version} into ${prefix}`)
      mkdirSync(prefix, { recursive: true })
      const installed = await runProcess('npm', ['install', '-g', '--prefix', prefix, '--no-fund', '--no-audit', `@deepseek-ai/dsh@${version}`], { timeoutMs: INSTALL_TIMEOUT_MS, maxBytes: OUTPUT_BYTES })
      if (installed.code !== 0 || !existsSync(bin)) {
        this.installing = undefined
        throw new Error(`installing dsh ${version} failed: ${installed.stderr.trim().slice(-600)}`)
      }
      return bin
    })()
    return await this.installing
  }

  async build(_spec: InstanceSpec, candidateDir: string): Promise<BuildResult> {
    let bin: string
    try {
      bin = await this.dsh()
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
    const env = instanceEnv(bin, this.options.dataDir, { PLUGIN_DIR: candidateDir })
    const options = { cwd: candidateDir, env, maxBytes: OUTPUT_BYTES }
    const install = await runProcess(process.execPath, [LAUNCHER, 'install'], { ...options, timeoutMs: INSTALL_TIMEOUT_MS })
    if (install.code !== 0) return buildResult(install, undefined)
    const check = await runProcess(process.execPath, [LAUNCHER, 'check'], { ...options, timeoutMs: CHECK_TIMEOUT_MS + 10_000 })
    return buildResult(install, check)
  }

  /** Start one launcher mode in its own process group, so stopping it reaches every process it started. */
  private launch(spec: InstanceSpec, mode: 'serve' | 'forward', env: NodeJS.ProcessEnv): ChildProcess {
    const child = spawn(process.execPath, [LAUNCHER, mode], { cwd: spec.workDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    const forward = (chunk: Buffer): void => {
      for (const line of chunk.toString().split('\n')) if (line.trim() !== '') this.options.log(`instance ${spec.id}: ${line}`)
    }
    child.stdout?.on('data', forward)
    child.stderr?.on('data', forward)
    return child
  }

  async start(spec: InstanceSpec): Promise<RunningInstance> {
    await this.stop(spec.id)
    const bin = await this.dsh()
    for (const dir of [spec.homeDir, spec.stateDir, spec.socketDir]) mkdirSync(dir, { recursive: true })
    rmSync(join(spec.stateDir, 'ready.json'), { force: true })
    const serve = this.launch(spec, 'serve', instanceEnv(bin, this.options.dataDir, { PLUGIN_DIR: spec.workDir, DSH_HOME: spec.homeDir, STATE_DIR: spec.stateDir }))
    const forward = this.launch(spec, 'forward', instanceEnv(bin, this.options.dataDir, { STATE_DIR: spec.stateDir, SOCKET_DIR: spec.socketDir }))
    const instance: Instance = { children: [serve, forward] }
    this.instances.set(spec.id, instance)
    let exited = false
    for (const child of instance.children) {
      child.on('exit', () => {
        exited = true
        if (this.instances.get(spec.id) === instance) void this.stop(spec.id)
      })
    }
    try {
      instance.running = await waitForReady(spec, () => !exited)
      return instance.running
    } catch (error) {
      await this.stop(spec.id)
      throw error
    }
  }

  async stop(id: string): Promise<void> {
    const instance = this.instances.get(id)
    if (instance === undefined) return
    this.instances.delete(id)
    await Promise.all(instance.children.map(async child => await stopGroup(child)))
  }

  async destroy(id: string): Promise<void> {
    await this.stop(id)
  }

  running(id: string): RunningInstance | undefined {
    return this.instances.get(id)?.running
  }
}

/** SIGTERM a child's process group, then SIGKILL it after ten seconds. */
async function stopGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
  const group = -child.pid
  try {
    process.kill(group, 'SIGTERM')
  } catch {
    return
  }
  const timer = setTimeout(() => {
    try {
      process.kill(group, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }, 10_000)
  await exited
  clearTimeout(timer)
}
