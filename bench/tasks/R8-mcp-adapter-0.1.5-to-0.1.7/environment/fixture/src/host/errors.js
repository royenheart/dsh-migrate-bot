/**
 * Render any thrown value as one human-readable message. Host modules share
 * this helper instead of redefining it per file.
 */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
