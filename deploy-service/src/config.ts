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
  // Preview sockets live under it, and a Unix socket path is limited to 108 bytes.
  DATA_DIR: z.string().refine(isAbsolute, 'must be an absolute path').refine(dir => dir.length <= 64, 'must be at most 64 characters, because preview sockets live under it'),
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).transform(url => url.replace(/\/+$/, '')),
  PROVIDER: z.enum(['docker', 'process']),
  DSH_IMAGE: z.string().min(1).optional(),
  DSH_VERSION: z.string().regex(/^[0-9A-Za-z.+-]+$/, 'must be a dsh version such as 0.2.0-rc.2').optional(),
  DSH_BIN: z.string().refine(isAbsolute, 'must be an absolute path').optional(),
  IDLE_MINUTES: minutes.default(120),
  TTL_DAYS: z.coerce.number().int().min(1).max(365).default(3),
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),
  PUBLIC_VIEWS: flag,
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
