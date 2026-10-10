import { ABSORPTION_PROMPT, ALIGNMENT_PROMPT, FIX_PROMPT, withHarnessContext } from './migrate/index.ts'
import type { MigrateConfig } from '../config/schema.ts'

export interface ResolvedPrompts {
  absorption: string
  alignment: string
  fix: string
}

/**
 * User overrides win; otherwise the shipped English prompts are used.
 */
export function resolvePrompts(
  config: MigrateConfig,
  harness?: { path: string; tag: string } | undefined,
): ResolvedPrompts {
  return {
    absorption: withHarnessContext(config.prompts.overlap ?? ABSORPTION_PROMPT, harness),
    alignment: withHarnessContext(config.prompts.extensionPoints ?? ALIGNMENT_PROMPT, harness),
    fix: config.prompts.repair ?? FIX_PROMPT,
  }
}
