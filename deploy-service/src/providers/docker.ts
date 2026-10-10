import { lchownSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '../spawn.ts'
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

  async build(spec: InstanceSpec, candidateDir: string): Promise<BuildResult> {
    const user = this.user([candidateDir])
    const common = ['run', '--rm', '--init', ...LIMITS, ...user, '-e', 'PLUGIN_DIR=/plugin', '-e', 'HOME=/tmp', '-e', 'npm_config_cache=/tmp/.npm', '-v', `${candidateDir}:/plugin`, '-w', '/plugin']
    await this.docker(['rm', '--force', this.name(spec.id, '-install'), this.name(spec.id, '-check')])
    const options = { maxBytes: OUTPUT_BYTES }
    const install = await runProcess('docker', [...common, '--name', this.name(spec.id, '-install'), this.options.image, 'install'], { ...options, timeoutMs: INSTALL_TIMEOUT_MS })
    if (install.code !== 0) return buildResult(install, undefined)
    const check = await runProcess('docker', [...common, '--name', this.name(spec.id, '-check'), '--network', 'none', this.options.image, 'check'], { ...options, timeoutMs: CHECK_TIMEOUT_MS + 30_000 })
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

/** `chown -R` that changes links themselves and never follows them. */
function chownTree(path: string, uid: number): void {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return
  lchownSync(path, uid, uid)
  if (!stat.isDirectory()) return
  for (const entry of readdirSync(path)) chownTree(join(path, entry), uid)
}
