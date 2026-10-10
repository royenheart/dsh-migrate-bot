import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { z } from 'zod'

/**
 * Durable JSON records in the data directory.
 *
 * A record is written to a sibling file and renamed over the old one, so a
 * crash leaves either the old record or the new one and never half of each.
 * Reads validate, because a record a person edited by hand or an older version
 * wrote is input like any other.
 */

/**
 * Write a JSON record atomically.
 * @param path - where the record lives.
 * @param value - the record.
 */
export function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

/**
 * Read a JSON record, or nothing when it is absent or does not validate.
 * @param path - where the record lives.
 * @param schema - what the record must look like.
 */
export function readJson<T extends z.ZodType>(path: string, schema: T): z.output<T> | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = schema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
