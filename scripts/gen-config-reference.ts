/**
 * Generate `docs/reference/configuration.md` from the configuration schema.
 *
 *   node dist/scripts/gen-config-reference.js [--write]
 *
 * Without `--write` it reports whether the file on disk differs from the
 * generated text, which is how the gate runs it.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { configSchema } from '../src/config/schema.ts'
import { REPO_ROOT } from './repo.ts'

export const CONFIG_REFERENCE = join(REPO_ROOT, 'docs', 'reference', 'configuration.md')

interface JsonSchema {
  type?: string
  enum?: unknown[]
  default?: unknown
  description?: string
  format?: string
  properties?: Record<string, JsonSchema>
  additionalProperties?: JsonSchema | boolean
  items?: JsonSchema
  anyOf?: JsonSchema[]
}

interface Row {
  key: string
  type: string
  default: string
  description: string
}

function typeOf(schema: JsonSchema): string {
  if (schema.enum !== undefined) return schema.enum.map(value => `\`${String(value)}\``).join(' \\| ')
  if (schema.type === 'array') return `list of ${typeOf(schema.items ?? {})}`
  if (schema.format === 'uri') return 'URL'
  return schema.type ?? 'any'
}

function defaultOf(schema: JsonSchema): string {
  if (schema.default === undefined) return '—'
  if (typeof schema.default === 'object') return '—'
  return `\`${String(schema.default)}\``
}

function rowsOf(schema: JsonSchema, prefix: string): Row[] {
  const rows: Row[] = []
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    const key = prefix === '' ? name : `${prefix}.${name}`
    if (child.properties !== undefined) {
      rows.push(...rowsOf(child, key))
      continue
    }
    if (typeof child.additionalProperties === 'object' && child.additionalProperties.properties !== undefined) {
      rows.push({ key, type: 'mapping', default: '—', description: child.description ?? '' })
      rows.push(...rowsOf(child.additionalProperties, `${key}.<id>`))
      continue
    }
    rows.push({ key, type: typeOf(child), default: defaultOf(child), description: child.description ?? '' })
  }
  return rows
}

/** The reference page as it must be on disk. */
export function generateConfigReference(): string {
  const schema = z.toJSONSchema(configSchema, { io: 'input' }) as JsonSchema
  const rows = rowsOf(schema, '').map(row => `| \`${row.key}\` | ${row.type} | ${row.default} | ${row.description} |`)
  return [
    '---',
    'kind: reference',
    'description: Every key of .github/dsh-migrate.yml with its type, default and meaning.',
    '---',
    '',
    '# Configuration reference',
    '',
    'A consumer configures the Action in `.github/dsh-migrate.yml`. Every key is optional. An unknown key is an error. This page is generated from `src/config/schema.ts` by `scripts/gen-config-reference.ts`; edit the schema, not this page.',
    '',
    '| Key | Type | Default | Description |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
}

/** Whether the page on disk equals the generated one. */
export function configReferenceIsCurrent(): boolean {
  let current = ''
  try {
    current = readFileSync(CONFIG_REFERENCE, 'utf8')
  } catch {
    return false
  }
  return current === generateConfigReference()
}

if (import.meta.filename === process.argv[1]) {
  if (process.argv.includes('--write')) {
    writeFileSync(CONFIG_REFERENCE, generateConfigReference())
  } else if (!configReferenceIsCurrent()) {
    console.error('docs/reference/configuration.md is stale; run the generator with --write')
    process.exit(1)
  }
}
