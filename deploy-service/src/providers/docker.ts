import { spawn } from 'node:child_process'
import { lchownSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess, type SpawnResult } from '../spawn.ts'
import { buildResult, CHECK_TIMEOUT_MS, INSTALL_TIMEOUT_MS, OUTPUT_BYTES, waitForReady } from './common.ts'
import type { BuildResult, InstanceProvider, InstanceSpec, RunningInstance } from './types.ts'

/**
 * Preview containers from the preview image (`DSH_IMAGE`).
 *
 * The service drives the Docker CLI; the containers it starts never see the
 * Docker socket, run without capabilities, as an unprivileged user, and under
 * CPU, memory and process limits. Their directories are bind mounts, so
 * `DATA_DIR` must be the same path on the host and in the service's container:
 * the daemon resolves a bind mount on the host, whatever the service sees.
 *
 * Only the dependency install has a network, Docker's default bridge, in a
 * container that is removed when it ends. The boot check and the serving
 * instance have none: the instance container runs `launcher.mjs serve`, and a
 * second container joined to its network namespace runs `forward`, which turns
 * each loopback `dsh web` port into a Unix socket in a directory only that
 * second container mounts. The plugin's code therefore cannot reach the
 * service, the cloud metadata endpoint, or the sockets the service follows.
 */

export interface DockerProviderOptions {
  image: string
  /** Prefix of every container name, so the provider never touches another container. */
  prefix: string
  log: (message: string) => void
}

/** The user previews run as when the service runs as root: the image's `node` user. */
const PREVIEW_UID = 1000

const LIMITS = ['--cpus', '1', '--memory', '2g', '--pids-limit', '512', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']

export class DockerProvider implements InstanceProvider {
  private readonly instances = new Map<string, RunningInstance>()

  constructor(private readonly options: DockerProviderOptions) {}

  private name(id: string, suffix = ''): string {
    return `${this.options.prefix}${id}${suffix}`
  }

  /**
   * The user a container runs as, and the ownership its mounts need.
   *
   * A service running as root hands the directories to the image's `node`
   * user; a service running as another user runs previews as itself, so the
   * files stay its own. Nothing of the plugin runs while this walks the tree.
   */
  private user(dirs: readonly string[]): string[] {
    const uid = process.getuid?.() ?? PREVIEW_UID
    const gid = process.getgid?.() ?? PREVIEW_UID
    if (uid !== 0) return ['--user', `${String(uid)}:${String(gid)}`]
    for (const dir of dirs) chownTree(dir, PREVIEW_UID)
    return ['--user', `${String(PREVIEW_UID)}:${String(PREVIEW_UID)}`]
  }

  private async docker(args: readonly string[]): Promise<{ ok: boolean; output: string }> {
    const result = await runProcess('docker', args, { timeoutMs: 120_000, maxBytes: OUTPUT_BYTES })
    return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim() }
  }

  /**
   * Remove every container this provider names: its prefix, a preview id, and
   * one of its suffixes, so a service whose prefix extends this one's keeps its own.
   *
   * For the start of the service, when none of them is in use: a restart
   * leaves the instances, and the install or check of a build it interrupted.
   */
  async removeLeftovers(): Promise<void> {
    const listed = await this.docker(['ps', '--all', '--filter', `name=${this.options.prefix}`, '--format', '{{.Names}}'])
    const ours = (name: string): boolean => name.startsWith(this.options.prefix) && /^[0-9a-f]{16}(-install|-check|-forward)?$/.test(name.slice(this.options.prefix.length))
    const names = listed.ok ? listed.output.split('\n').map(line => line.trim()).filter(ours) : []
    if (names.length > 0) await this.docker(['rm', '--force', ...names])
  }

  /**
   * `docker run --rm` the container `name` to its end. The watchdog of
   * `runProcess` kills only the CLI client, so a container it killed is removed here.
   */
  private async runToEnd(name: string, args: readonly string[], timeoutMs: number): Promise<SpawnResult> {
    const result = await runProcess('docker', args, { maxBytes: OUTPUT_BYTES, timeoutMs })
    if (result.killed !== undefined) await this.docker(['rm', '--force', name])
    return result
  }

  async build(spec: InstanceSpec, candidateDir: string): Promise<BuildResult> {
    const user = this.user([candidateDir])
    const common = ['run', '--rm', '--init', ...LIMITS, ...user, '-e', 'PLUGIN_DIR=/plugin', '-e', 'HOME=/tmp', '-e', 'npm_config_cache=/tmp/.npm', '-v', `${candidateDir}:/plugin`, '-w', '/plugin']
    const installer = this.name(spec.id, '-install')
    const checker = this.name(spec.id, '-check')
    await this.docker(['rm', '--force', installer, checker])
    const install = await this.runToEnd(installer, [...common, '--name', installer, this.options.image, 'install'], INSTALL_TIMEOUT_MS)
    if (install.code !== 0) return buildResult(install, undefined)
    const check = await this.runToEnd(checker, [...common, '--name', checker, '--network', 'none', this.options.image, 'check'], CHECK_TIMEOUT_MS + 30_000)
    return buildResult(install, check)
  }

  async start(spec: InstanceSpec): Promise<RunningInstance> {
    await this.stop(spec.id)
    for (const dir of [spec.homeDir, spec.stateDir, spec.socketDir]) mkdirSync(dir, { recursive: true })
    rmSync(join(spec.stateDir, 'ready.json'), { force: true })
    const user = this.user([spec.workDir, spec.homeDir, spec.stateDir, spec.socketDir])
    const name = this.name(spec.id)
    const forwarder = this.name(spec.id, '-forward')
    const serve = await this.docker([
      'run', '--detach', '--init', '--name', name, '--network', 'none', ...LIMITS, ...user,
      '-e', 'PLUGIN_DIR=/plugin', '-e', 'DSH_HOME=/dsh-home', '-e', 'STATE_DIR=/state', '-e', 'HOME=/tmp',
      '-v', `${spec.workDir}:/plugin`, '-v', `${spec.homeDir}:/dsh-home`, '-v', `${spec.stateDir}:/state`,
      this.options.image, 'serve',
    ])
    const forward = serve.ok
      ? await this.docker([
          'run', '--detach', '--init', '--name', forwarder, '--network', `container:${name}`, ...LIMITS, ...user,
          '-e', 'STATE_DIR=/state', '-e', 'SOCKET_DIR=/sockets',
          '-v', `${spec.stateDir}:/state:ro`, '-v', `${spec.socketDir}:/sockets`,
          this.options.image, 'forward',
        ])
      : serve
    if (!forward.ok) {
      await this.stop(spec.id)
      throw new Error(`docker run failed: ${forward.output.slice(-600)}`)
    }
    let alive = true
    const watch = setInterval(() => {
      void this.docker(['inspect', '--format', '{{.State.Running}}', name, forwarder]).then((state) => {
        alive = state.ok && state.output.split('\n').every(line => line.trim() === 'true')
      })
    }, 2_000)
    try {
      const running = await waitForReady(spec, () => alive)
      this.instances.set(spec.id, running)
      // As the process provider's exit handler does: a container that exits
      // (out of memory, a crash) stops the instance, both containers, so
      // `running` no longer names it and the next visit starts it again. They
      // are removed by id, so a start that already reused their names keeps its own.
      const ids = [serve.output, forward.output].flatMap(output => containerId(output) ?? [])
      for (const container of [name, forwarder]) {
        const wait = spawn('docker', ['wait', container], { stdio: 'ignore' })
        const exited = (): void => {
          if (this.instances.get(spec.id) !== running) return
          this.options.log(`instance ${spec.id}: container ${container} exited`)
          this.instances.delete(spec.id)
          if (ids.length > 0) void this.docker(['rm', '--force', ...ids])
        }
        wait.on('exit', exited)
        wait.on('error', exited)
      }
      return running
    } catch (error) {
      const logs = await this.docker(['logs', '--tail', '20', name])
      await this.stop(spec.id)
      throw new Error(`${error instanceof Error ? error.message : String(error)}: ${logs.output.slice(-600)}`)
    } finally {
      clearInterval(watch)
    }
  }

  async stop(id: string): Promise<void> {
    this.instances.delete(id)
    await this.docker(['rm', '--force', this.name(id, '-forward'), this.name(id)])
  }

  async destroy(id: string): Promise<void> {
    await this.stop(id)
    await this.docker(['rm', '--force', this.name(id, '-install'), this.name(id, '-check')])
  }

  running(id: string): RunningInstance | undefined {
    return this.instances.get(id)
  }
}

/** The id `docker run --detach` printed: the line of its output that is a full container id. */
function containerId(output: string): string | undefined {
  return output.split('\n').map(line => line.trim()).reverse().find(line => /^[0-9a-f]{64}$/.test(line))
}

/** `chown -R` that changes links themselves and never follows them. */
function chownTree(path: string, uid: number): void {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return
  lchownSync(path, uid, uid)
  if (!stat.isDirectory()) return
  for (const entry of readdirSync(path)) chownTree(join(path, entry), uid)
}
