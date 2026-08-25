import { ABSORPTION_PROMPT, ALIGNMENT_PROMPT, FIX_PROMPT } from './defaults.ts'
import type { MigrateConfig } from '../config/schema.ts'

export interface ResolvedPrompts {
  absorption: string
  alignment: string
  fix: string
}

/**
 * User overrides win; otherwise the shipped English prompts are used.
 */
export function resolvePrompts(config: MigrateConfig): ResolvedPrompts {
  return {
    absorption: config.prompts.absorption ?? ABSORPTION_PROMPT,
    alignment: config.prompts.alignment ?? ALIGNMENT_PROMPT,
    fix: config.prompts.fix ?? FIX_PROMPT,
  }
}
