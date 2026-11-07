import { isAbsolute } from 'node:path'
import { z } from 'zod'

/**
 * The service's configuration, read from the environment once at start.
 *
 * Nothing else configures the service: no file, no flag except `--conformance`.
 * An invalid or missing value stops the process before it listens, with every
 * problem named, so a misconfigured deployment fails at start and not at the
 * first request that needs the missing value.
 */

const flag = z.enum(['true', 'false']).default('false').transform(value => value === 'true')
const minutes = z.coerce.number().int().min(1)

export const envSchema = z.object({
  DEPLOY_TOKEN: z.string().min(16, 'must be at least 16 characters'),
  GITHUB_WEBHOOK_SECRET: z.string().min(16, 'must be at least 16 characters'),
  // A preview socket is DATA_DIR/previews/<id>/sockets/plugin.sock, 46 characters
  // more, and a Unix socket path is limited to 108 bytes.
  DATA_DIR: z.string().refine(isAbsolute, 'must be an absolute path').refine(dir => Buffer.byteLength(dir) <= 62, 'must be at most 62 bytes, because preview sockets live under it'),
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).transform(url => url.replace(/\/+$/, '')),
  PROVIDER: z.enum(['docker', 'process']),
  DSH_IMAGE: z.string().min(1).optional(),
  DSH_VERSION: z.string().regex(/^[0-9A-Za-z.+-]+$/, 'must be a dsh version such as 0.2.0-rc.2').optional(),
  DSH_BIN: z.string().refine(isAbsolute, 'must be an absolute path').optional(),
  IDLE_MINUTES: minutes.default(120),
  TTL_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),
  PUBLIC_VIEWS: flag,
  EVIDENCE_URL: z.preprocess(value => value === '' ? undefined : value, z.url({ protocol: /^https?$/ }).transform(url => url.replace(/\/+$/, '')).refine(url => {
    const parsed = new URL(url)
    return !url.includes('?') && !url.includes('#') && parsed.username === '' && parsed.password === ''
  }, 'must be a base URL without query, fragment or credentials').optional()),
  /** When set, the preview model gateway is enabled and uses this upstream origin. */
  MODEL_UPSTREAM: z.preprocess(value => value === '' ? undefined : value, z.url({ protocol: /^https?$/ }).refine(url => {
    const parsed = new URL(url)
    const path = parsed.pathname.replace(/\/+$/, '')
    const https = parsed.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    return parsed.username === '' && parsed.password === '' && !url.includes('?') && !url.includes('#') && https && path !== '' && path !== '/' && !path.endsWith('/v1')
  }, 'must be no credentials/query/fragment, use https (or loopback), include a base path, and avoid a trailing /v1').transform(url => url.replace(/\/+$/, '')).default('https://api.deepseek.com/anthropic')),
  /** The service-owned provider key. Only the model gateway receives it. */
  MODEL_API_KEY: z.preprocess(value => value === '' ? undefined : value, z.string().min(1).regex(/^[\x21-\x7E]+$/, 'must be a single-line header value').optional()),
  /** Comma-separated model ids the gateway admits; absent admits every id. */
  MODEL_MODELS: z.preprocess(value => value === '' ? undefined : value, z.string().optional()),
  /** Maximum model requests one preview grant may make. */
  MODEL_MAX_REQUESTS: z.coerce.number().int().min(1).max(100000).default(200),
  /** Largest Messages request body the gateway buffers, in bytes. */
  MODEL_MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(100 * 1024 * 1024).default(20 * 1024 * 1024),
  /** Concurrent requests one grant may have in flight. */
  MODEL_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(2),
  /** Concurrent requests the gateway serves across all previews. */
  MODEL_GLOBAL_CONCURRENCY: z.coerce.number().int().min(1).max(1000).default(20),
  /** Upstream request deadline, in milliseconds. */
  MODEL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3600000).default(600000),
  /** Optional preview origin suffix; previews then answer on p-<id>.<domain>. */
  PREVIEW_DOMAIN: z.preprocess(value => value === '' ? undefined : value, z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/, 'must be a lowercase DNS name').optional()),
  INSTANCE_PREFIX: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).default('dsh-preview-'),
}).superRefine((env, context) => {
  if (env.PROVIDER === 'docker' && env.DSH_IMAGE === undefined) {
    context.addIssue({ code: 'custom', path: ['DSH_IMAGE'], message: 'is required when PROVIDER is docker' })
  }
  if (env.PROVIDER === 'process' && env.DSH_VERSION === undefined && env.DSH_BIN === undefined) {
    context.addIssue({ code: 'custom', path: ['DSH_VERSION'], message: 'is required when PROVIDER is process and DSH_BIN is not set' })
  }
})

export type ServiceConfig = z.output<typeof envSchema> & {
  /** Started with `--conformance`: the `X-Conformance` header is honoured. */
  conformance: boolean
}

/**
 * Validate the environment and the command line.
 * @param env - the process environment.
 * @param argv - the arguments after the script name.
 * @returns the configuration, or every problem found.
 */
export function loadConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): { ok: true; config: ServiceConfig } | { ok: false; problems: string[] } {
  const unknown = argv.filter(arg => arg !== '--conformance')
  const parsed = envSchema.safeParse(env)
  const problems = [
    ...unknown.map(arg => `unknown argument ${arg}; the service is configured by environment, and --conformance is its only flag`),
    ...(parsed.success ? [] : parsed.error.issues.map(issue => `${issue.path.join('.') || 'environment'}: ${issue.message}`)),
  ]
  if (!parsed.success || problems.length > 0) return { ok: false, problems }
  return { ok: true, config: { ...parsed.data, conformance: argv.includes('--conformance') } }
}
