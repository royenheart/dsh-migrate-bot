/**
 * Where preview instances run.
 *
 * The preview manager owns records, working copies and the lifecycle; a
 * provider owns only processes. Each instance is two `dsh web` processes
 * started by `preview-image/launcher.mjs serve`: one with the plugin from the
 * working copy mounted, one without it for the safe entry. A second launcher
 * process, `forward`, which runs none of the plugin's code, exposes each of
 * them as a Unix socket in the socket directory, and the service reaches the
 * instance only through those sockets.
 */

/** What a provider is given about one preview. */
export interface InstanceSpec {
  /** The preview id, also used to name what the provider creates. */
  id: string
  /** The promoted working copy. */
  workDir: string
  /** The instance's dsh home, kept across rebuilds and cold starts. */
  homeDir: string
  /** Where `serve` writes `ready.json`. */
  stateDir: string
  /** Where `forward` creates the sockets; never writable by the plugin's code. */
  socketDir: string
}

/** How the service reaches one `dsh web` of a running instance. */
export interface InstanceEndpoint {
  /** The Unix socket the service connects to. */
  socketPath: string
  /** The `Host` value `dsh web` accepts: the loopback authority it listens on. */
  authority: string
  /** The launch token `dsh web` printed; exchanged for a session cookie by the proxy. */
  token: string
}

export interface RunningInstance {
  /** The plugin under migration. */
  url: InstanceEndpoint
  /** The same harness and home without the plugin. */
  safeUrl: InstanceEndpoint
}

export interface BuildResult {
  ok: boolean
  /** Why it failed, or what passed; one paragraph for the preview's state. */
  detail: string
}

export interface InstanceProvider {
  /**
   * Install the plugin's dependencies in a candidate working copy and run the
   * keyless boot check on it. Nothing serves the candidate yet; the manager
   * promotes it only when this passes.
   */
  build(spec: InstanceSpec, candidateDir: string): Promise<BuildResult>
  /** Start the instance from the promoted working copy and wait until it serves. */
  start(spec: InstanceSpec): Promise<RunningInstance>
  /** Stop the instance; its home and working copy stay. */
  stop(id: string): Promise<void>
  /** Remove everything the provider created for the instance. */
  destroy(id: string): Promise<void>
  /** Where the running instance answers, or nothing when it is not running. */
  running(id: string): RunningInstance | undefined
}
