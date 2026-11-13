#!/usr/bin/env node
// The preview instance launcher. It runs inside the preview image (the `docker`
// provider) and on the host (the `process` provider), so both providers start
// exactly the same processes. Plain JavaScript with no dependencies, because
// the preview image carries nothing but Node and dsh.
//
//   launcher.mjs install   install the plugin's dependencies in PLUGIN_DIR
//   launcher.mjs check     the keyless check of PLUGIN_DIR; prints dsh's output
//   launcher.mjs serve     two `dsh web` processes, with and without the plugin;
//                          writes their loopback ports and launch tokens to STATE_DIR/ready.json
//   launcher.mjs forward   one Unix socket per `dsh web` in SOCKET_DIR, forwarded to its loopback port
//
// `serve` runs the plugin's code; `forward` does not, and it is the only mode
// that writes SOCKET_DIR, which the plugin's code never sees. Environment:
// DSH_BIN, PLUGIN_DIR, DSH_HOME, STATE_DIR, SOCKET_DIR.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const env = process.env
const dsh = env.DSH_BIN ?? 'dsh'
const pluginDir = env.PLUGIN_DIR ?? '/plugin'

/** What `dsh web` prints once it listens; the token is its launch token. */
const READY = /dsh web: (http:\/\/127\.0\.0\.1:(\d+))\/\?token=([A-Za-z0-9_-]+)/

/** The keyless model route of the check: a placeholder key and a closed port. */
const KEYLESS = {
  DEEPSEEK_API_KEY: 'probe-placeholder-key',
  DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/v1',
  DSH_TELEMETRY_DISABLED: '1',
}

function fail(message) {
  process.stderr.write(`dsh-preview: ${message}\n`)
  process.exit(2)
}

function pluginName() {
  try {
    const name = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).name
    if (typeof name === 'string' && name !== '') return name
  } catch {
    // Reported below.
  }
  return fail(`${pluginDir}/package.json has no usable name`)
}

/** Write one dsh profile; the plugin, when named, is linked into its node_modules. */
function writeProfile(home, profile, bundles, plugin) {
  const dir = join(home, 'profiles', profile)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: `dsh-preview-${profile}`, private: true, type: 'module', dsh: { profile: { bundles } } }, null, 2)}\n`)
  if (plugin === undefined) return
  const link = join(dir, 'node_modules', plugin)
  mkdirSync(dirname(link), { recursive: true })
  rmSync(link, { force: true, recursive: true })
  symlinkSync(pluginDir, link, 'dir')
}

function install() {
  const run = (args) => {
    const result = spawnSync('npm', args, { cwd: pluginDir, stdio: 'inherit', env })
    if (result.status !== 0) fail(`npm ${args.join(' ')} exited ${String(result.status)}`)
  }
  if (!existsSync(join(pluginDir, 'package.json'))) fail('the working copy has no package.json')
  // Without a committed lockfile the install writes none: one written into the
  // working copy would count as part of the person's change.
  run([...existsSync(join(pluginDir, 'package-lock.json')) ? ['ci'] : ['install', '--no-package-lock'], '--no-audit', '--no-fund'])
  run(['run', 'build', '--if-present'])
}

/** Whether the plugin root declares a browser half (`dsh.client`). */
function declaresClient() {
  try {
    const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
    const client = manifest?.dsh?.client
    return typeof client === 'object' && client !== null
  } catch {
    return false
  }
}

/** Whether a bundle patch declares an agent preset; the headless composition has no registry. */
function declaresPreset() {
  try {
    const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
    const patch = manifest?.dsh?.bundle?.patch
    const files = typeof patch === 'string' ? [patch] : Array.isArray(patch) ? patch : []
    return files.some(file => typeof file === 'string' && /@deepseek-ai\/dsh-agent-preset/.test(readFileSync(join(pluginDir, file), 'utf8')))
  } catch {
    return false
  }
}

/** The model route is keyless; the launch token is a credential and never reaches the log. */
function redact(text) {
  return String(text)
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, 'sk-<redacted>')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh<redacted>')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_<redacted>')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, match => `${match.split(/\s+/)[0]} <redacted>`)
    .replace(/(?:mongodb|postgres(?:ql)?|mysql|redis):\/\/[^\s:/@]+:[^\s@/]+@/gi, match => match.replace(/:[^:@/]+@/, ':<redacted>@'))
    .replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '<redacted>')
}

/** Stateful line scrubber: credentials split across chunks are held until the line ends. */
function streamRedactor(write) {
  let held = ''
  let pem = false
  const emitLines = () => {
    let newline = held.indexOf('\n')
    while (newline >= 0) {
      const line = held.slice(0, newline + 1)
      held = held.slice(newline + 1)
      const begins = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)
      const ends = /-----END [A-Z ]*PRIVATE KEY-----/.test(line)
      if (pem) {
        if (ends) pem = false
      } else if (begins) {
        pem = !ends
      } else {
        write(redact(line))
      }
      newline = held.indexOf('\n')
    }
    if (held.length > 64 * 1024) {
      const keep = 512
      const markers = ['token=', 'Bearer ', 'Basic ', 'sk-', 'ghp_', 'github_pat_', 'AKIA', '-----BEGIN ']
      let cut = held.length - keep
      for (const candidate of markers) {
        const at = held.lastIndexOf(candidate)
        if (at >= 0 && at < cut) cut = at
      }
      const prefix = held.slice(0, cut)
      held = held.slice(cut)
      write(pem ? '[redacted]\n' : redact(prefix))
    }
  }
  return {
    feed(chunk) { held += String(chunk); emitLines() },
    flush() {
      if (pem) write('[redacted]\n')
      else write(redact(held))
      held = ''
      pem = false
    },
  }
}

/** The headless check: boot the plugin and stop at the model call. */
function checkHeadless(plugin, home) {
  writeProfile(home, 'check', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', plugin], plugin)
  const result = spawnSync(dsh, ['--profile', 'check', 'ping'], {
    cwd: pluginDir,
    env: { ...env, ...KEYLESS, DSH_HOME: home },
    encoding: 'utf8',
    timeout: Number(env.CHECK_TIMEOUT_MS ?? 180_000),
    killSignal: 'SIGKILL',
  })
  process.stdout.write(redact(result.stdout ?? ''))
  process.stderr.write(redact(result.stderr ?? ''))
  if (result.error?.code === 'ETIMEDOUT') {
    process.stderr.write('dsh-preview: boot check timed out\n')
    return 124
  }
  return result.status ?? 1
}

/** The web check: load the plugin in the composition `serve` uses and wait for its ready line. */
function checkWeb(plugin, home) {
  writeProfile(home, 'check', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', plugin], plugin)
  return new Promise((resolve) => {
    const child = spawn(dsh, ['--profile', 'check', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd: pluginDir,
      env: { ...env, ...KEYLESS, DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.stdout.write(redact(output))
      child.kill('SIGTERM')
      setTimeout(() => { child.kill('SIGKILL') }, 5_000).unref?.()
      resolve(code)
    }
    const timer = setTimeout(() => {
      process.stderr.write('dsh-preview: web check timed out\n')
      finish(124)
    }, Number(env.CHECK_TIMEOUT_MS ?? 180_000))
    const onData = (chunk) => {
      output += String(chunk)
      if (READY.test(output)) finish(0)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (error) => {
      output += `dsh-preview: ${error.message}\n`
      finish(1)
    })
    // A server that exits cleanly without a ready line has not passed the check.
    child.on('exit', (code) => { finish(code === 0 ? 1 : code ?? 1) })
  })
}

async function check() {
  const plugin = pluginName()
  const home = mkdtempSync(join(tmpdir(), 'dsh-preview-check-'))
  let code
  try {
    code = declaresClient() || declaresPreset() ? await checkWeb(plugin, home) : checkHeadless(plugin, home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  process.exit(code)
}

/** Start one `dsh web` and resolve with its port and launch token. */
function web(profile, children) {
  return new Promise((resolve, reject) => {
    const child = spawn(dsh, ['--profile', profile, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd: pluginDir,
      env: { ...env, DSH_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let output = ''
    // Separate buffers: stdout and stderr interleave at the terminal, but a
    // token never spans two different streams.
    const logOut = streamRedactor(text => { process.stdout.write(`[${profile}] ${text}`) })
    const logErr = streamRedactor(text => { process.stderr.write(`[${profile}] ${text}`) })
    const onData = (logger) => (chunk) => {
      const text = String(chunk)
      // The launch token is a credential: it reaches ready.json, never the log.
      logger.feed(text)
      output += text
      const ready = READY.exec(output)
      if (ready !== null) resolve({ port: Number(ready[2]), token: ready[3] })
    }
    child.stdout.on('data', onData(logOut))
    child.stderr.on('data', onData(logErr))
    child.on('exit', (code) => {
      logOut.flush()
      logErr.flush()
      reject(new Error(`dsh web (${profile}) exited ${String(code)}`))
      for (const other of children) other.kill('SIGTERM')
      process.exit(1)
    })
  })
}

async function serve() {
  const plugin = pluginName()
  const home = env.DSH_HOME ?? fail('DSH_HOME is not set')
  const stateDir = env.STATE_DIR ?? fail('STATE_DIR is not set')
  writeProfile(home, 'preview', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', plugin], plugin)
  writeProfile(home, 'safe', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  const children = []
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      for (const child of children) child.kill('SIGTERM')
      process.exit(0)
    })
  }
  const [pluginWeb, safeWeb] = await Promise.all([web('preview', children), web('safe', children)])
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'ready.json.tmp'), `${JSON.stringify({ plugin: pluginWeb, safe: safeWeb })}\n`, { mode: 0o600 })
  renameSync(join(stateDir, 'ready.json.tmp'), join(stateDir, 'ready.json'))
  process.stdout.write('dsh-preview: serving\n')
}

/** Wait for `serve` to name its ports, then forward one Unix socket to each. */
async function forward() {
  const stateDir = env.STATE_DIR ?? fail('STATE_DIR is not set')
  const socketDir = env.SOCKET_DIR ?? fail('SOCKET_DIR is not set')
  const file = join(stateDir, 'ready.json')
  let ready
  for (let waited = 0; ready === undefined; waited += 250) {
    if (waited > 120_000) fail('serve never wrote ready.json')
    try {
      ready = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  const modelPort = Number(env.MODEL_PORT ?? 0)
  const modelSocket = env.MODEL_SOCKET
  if (Number.isInteger(modelPort) && modelPort > 0 && typeof modelSocket === 'string' && modelSocket !== '') {
    const relay = createServer((socket) => {
      const upstream = createConnection({ path: modelSocket })
      socket.pipe(upstream).pipe(socket)
      socket.on('error', () => upstream.destroy())
      socket.on('close', () => upstream.destroy())
      upstream.on('error', () => socket.destroy())
      upstream.on('close', () => socket.destroy())
    })
    relay.maxConnections = 8
    relay.on('error', (error) => process.stderr.write(`dsh-preview: model relay: ${String(error)}\n`))
    await new Promise((resolve, reject) => {
      relay.once('error', reject)
      relay.listen(modelPort, '127.0.0.1', () => { relay.off('error', reject); resolve() })
    })
  }
  mkdirSync(socketDir, { recursive: true })
  for (const entry of ['plugin', 'safe']) {
    const port = Number(ready[entry]?.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`ready.json names no port for ${entry}`)
    const path = join(socketDir, `${entry}.sock`)
    rmSync(path, { force: true })
    const server = createServer((socket) => {
      const upstream = createConnection({ host: '127.0.0.1', port })
      socket.pipe(upstream).pipe(socket)
      socket.on('error', () => upstream.destroy())
      upstream.on('error', () => socket.destroy())
    })
    await new Promise(resolve => server.listen(path, resolve))
  }
  process.stdout.write('dsh-preview: forwarding\n')
}

const mode = process.argv[2]
if (mode === 'install') install()
else if (mode === 'check') await check()
else if (mode === 'serve') await serve()
else if (mode === 'forward') await forward()
else fail(`unknown mode ${String(mode)}; expected install, check, serve or forward`)
