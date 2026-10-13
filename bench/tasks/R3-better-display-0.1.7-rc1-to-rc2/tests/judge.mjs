#!/usr/bin/env node
/**
 * The verifier of every task in bench/tasks. Each task's `tests/judge.mjs` is
 * a copy of this file, and its `tests/task.json` says what to check; Harbor
 * uploads `tests/` only when the agent has finished, so the agent never sees
 * either.
 *
 * It copies the plugin as the agent left it, installs it against the target
 * release with the package manager its lockfile names (pnpm for
 * `pnpm-lock.yaml`, npm otherwise, which honours the task's `before` date),
 * keeping the lockfile, and scores five checks, each 0 or 1:
 *
 * - `contract`: every `@deepseek-ai/dsh-*` range of the plugin admits the target;
 * - `typecheck`, `test`, `build`: the plugin's own scripts, with every dsh
 *   package it names that the target published pinned to the target, after the
 *   task's hidden tests replace the plugin's (the tests of the human migration);
 * - `boot`: dsh of the target loads the built plugin without skipping it:
 *   headless dsh reaches the model call, or a web profile reports ready for a
 *   plugin with a browser half;
 * - `unchanged` (control tasks only): the listed paths are as the fixture had them.
 *
 * The score is the weighted sum, 0 to 100, printed as the last line of JSON.
 * Self-contained: Node and the global npm, pnpm and dsh of the task image only.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const TESTS = dirname(new URL(import.meta.url).pathname)
const FIXTURE = '/app/fixture'
const task = JSON.parse(readFileSync(join(TESTS, 'task.json'), 'utf8'))
const WEIGHTS = { contract: 15, typecheck: 20, test: 30, build: 15, boot: 20, unchanged: 30, ...task.weights }
const SCRIPT_MS = 15 * 60_000
const BOOT_MS = 120_000
const semver = createRequire(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'npm', 'package.json'))('semver')

const results = {}
const report = (check, pass, detail) => {
  results[check] = pass ? 1 : 0
  console.log(`${pass ? 'PASS' : 'FAIL'} ${check}${detail ? `: ${detail.trim().split('\n').slice(-12).join('\n  ')}` : ''}`)
}

const work = join(mkdtempSync(join(tmpdir(), 'judge-')), 'plugin')
cpSync(join(FIXTURE, task.plugin ?? '.'), work, { recursive: true, filter: source => !/\/(node_modules|\.git)(\/|$)/.test(source) })
const manifestPath = join(work, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const named = [...new Set(['dependencies', 'peerDependencies', 'devDependencies']
  .flatMap(field => Object.keys(manifest[field] ?? {}))
  .filter(name => name.startsWith('@deepseek-ai/dsh-')))]

// contract: what a user installing the plugin next to the target would meet.
{
  const refused = ['dependencies', 'peerDependencies', 'devDependencies'].flatMap(field => Object.entries(manifest[field] ?? {})
    .filter(([name, range]) => name.startsWith('@deepseek-ai/dsh-') && !semver.satisfies(task.target, range))
    .map(([name, range]) => `${field} ${name}@${range}`))
  report('contract', named.length > 0 && refused.length === 0, refused.length > 0 ? `does not admit ${task.target}: ${refused.join(', ')}` : named.length === 0 ? 'names no @deepseek-ai/dsh-* package' : '')
}

// unchanged: a control task, where the migration needs no code change.
if (task.unchanged !== undefined) {
  const changed = spawnSync('git', ['-C', '/app', 'status', '--porcelain', '--', ...task.unchanged.map(path => join('fixture', path))], { encoding: 'utf8' }).stdout.trim()
  report('unchanged', changed === '', changed === '' ? '' : `changed:\n${changed}`)
}

// The plugin's own code against the target: every dsh package it names that the target published pinned to it, the human migration's tests in place.
// A package dsh stopped publishing (an optional peer the plugin still names) stays as declared.
for (const name of named) {
  const published = spawnSync('npm', ['view', `${name}@${task.target}`, 'version'], { encoding: 'utf8' }).stdout.trim() !== ''
  if (published) manifest.devDependencies = { ...manifest.devDependencies, [name]: task.target }
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
const hidden = join(TESTS, 'hidden')
if (existsSync(hidden)) cpSync(hidden, work, { recursive: true })

const run = (command, args) => spawnSync(command, args, { cwd: work, encoding: 'utf8', timeout: SCRIPT_MS, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: '1' } })
const install = existsSync(join(work, 'pnpm-lock.yaml'))
  ? run('pnpm', ['install', '--no-frozen-lockfile'])
  : run('npm', ['install', '--no-audit', '--no-fund', ...(task.before === undefined ? [] : [`--before=${task.before}`])])
const installed = install.status === 0
if (!installed) console.log(`install failed:\n${`${install.stdout}${install.stderr}`.slice(-3000)}`)
for (const script of ['typecheck', 'test', 'build']) {
  const name = task.scripts?.[script] === undefined ? script : task.scripts[script]
  if (name === null) continue
  if (!installed) { report(script, false, 'install failed'); continue }
  if (manifest.scripts?.[name] === undefined) { report(script, false, `no "${name}" script`); continue }
  const result = run('npm', ['run', name])
  report(script, result.status === 0, result.status === 0 ? '' : `${result.stdout}${result.stderr}`.slice(-3000))
}

// boot: the built plugin in a scratch dsh home, keyless.
if (task.boot !== false) {
  const web = manifest.dsh?.client !== undefined
  const home = mkdtempSync(join(tmpdir(), 'judge-home-'))
  const profile = join(home, 'profiles', 'judge')
  mkdirSync(join(profile, 'node_modules', dirname(manifest.name)), { recursive: true })
  symlinkSync(work, join(profile, 'node_modules', manifest.name), 'dir')
  const bundles = ['@deepseek-ai/dsh-base', web ? '@deepseek-ai/dsh-web-app' : '@deepseek-ai/dsh-headless', manifest.name]
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'judge-profile', private: true, type: 'module', dsh: { profile: { bundles, patchReload: 'startup' } } }))
  // The web composition turns HMR on, whose file watches run a shared host out of inotify instances (EMFILE); a boot that exits needs none.
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: hmr\n  disabled: true\n')
  const help = spawnSync('dsh', ['web', '--help'], { encoding: 'utf8' }).stdout ?? ''
  // `dsh web` is the profile named web; the profile under test is named instead.
  const args = web ? ['--profile', 'judge', '--port', '0', ...(help.includes('--no-open') ? ['--no-open'] : [])] : ['--profile', 'judge', 'ping']
  const { output, code, ready } = await new Promise(resolve => {
    const child = spawn('dsh', args, { cwd: work, env: { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: 'judge-placeholder-key', DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/v1', DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const done = (ready) => { clearTimeout(timer); child.kill('SIGKILL'); resolve({ output, code: child.exitCode, ready }) }
    const timer = setTimeout(() => done(false), BOOT_MS)
    const read = chunk => { output += String(chunk); if (web && /dsh web:[^\n]*https?:\/\//.test(output)) done(true) }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.on('close', () => done(false))
  })
  // dsh from 0.2 skips a bundle it refuses and goes on without it.
  const failed = /skipping profile bundle|failed to load|did not activate|pending \(waiting|FAILED fiber|ClientPackageCompositionError/i.test(output)
  // Headless: reaching the model call (the dead endpoint or the placeholder key) proves every plugin activated.
  const reached = /TRANSPORT:|API request to .* failed|127\.0\.0\.1:9\b|MISSING_CREDENTIAL|\bAUTH\b|no api key|invalid api key|ECONNREFUSED|fetch failed|Authentication Fails/i.test(output)
  report('boot', !failed && (web ? ready : reached || code === 0), !failed && (web ? ready : reached || code === 0) ? '' : output.slice(-3000))
  rmSync(home, { recursive: true, force: true })
}

const checks = Object.keys(results)
const max = checks.reduce((sum, check) => sum + WEIGHTS[check], 0)
const score = Math.round(100 * checks.reduce((sum, check) => sum + WEIGHTS[check] * results[check], 0) / max)
console.log(JSON.stringify({ score, max: 100, checks: results }))
