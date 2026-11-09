/**
 * Turn dsh session events into short, readable trace lines.
 *
 * The translator is deliberately tolerant: event field names are sniffed, an
 * unknown type becomes one generic line, and a malformed event produces
 * nothing rather than failing the session. The runner loads this module from
 * the Action's own dist (like `session-status.ts`), so the line format and its
 * tests live with the Action, not in the plain-JavaScript runner.
 */

export const TRACE_PREFIX = 'dsh-migrate-trace:'
const DEFAULT_MAX_CHARS = 2_000

export interface TraceState {
  /** The model route's advertised context window, when a request/context event named it. */
  contextWindow?: number | undefined
}

export interface TraceOptions {
  /** Values that must never reach the stream. */
  secrets?: readonly string[] | undefined
  /** The most characters one trace line may carry. */
  maxChars?: number | undefined
  /** Visible assistant text; false for a report session, whose text is the report itself. */
  includeText?: boolean | undefined
  /** How much of a tool's arguments and result to keep; `summary` is the default. */
  toolResults?: 'summary' | 'full' | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The event data, or the event itself for older/looser shapes. */
function dataOf(event: Record<string, unknown>): Record<string, unknown> {
  return isRecord(event.data) ? event.data : event
}

function messageOf(data: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(data.message) ? data.message : undefined
}

/** Text blocks of a message, separated by newlines. */
function blockText(message: Record<string, unknown> | undefined, types: readonly string[]): string {
  if (message === undefined || !Array.isArray(message.content)) return ''
  return message.content
    .filter(isRecord)
    .filter(block => types.includes(String(block.type)))
    .map(block => asString(block.text) ?? '')
    .filter(text => text !== '')
    .join('\n')
}

/** Collapse whitespace and bound one trace line; a trace is a log line, not a document. */
export function boundTraceLine(text: string, maxChars = DEFAULT_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxChars) return collapsed
  return `${collapsed.slice(0, Math.max(0, maxChars - 1))}…`
}

/** Redact known values and the common credential shapes. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let redacted = text
  for (const secret of secrets) {
    if (secret.length >= 4) redacted = redacted.split(secret).join('<redacted>')
  }
  return redacted
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh<redacted>')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_<redacted>')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/\b(Basic\s+)[A-Za-z0-9+/=]+/gi, '$1<redacted>')
    .replace(/\b(token|password|secret|api[-_]?key)=([^\s&"']+)/gi, '$1=<redacted>')
    .replace(/(?:mongodb|postgres(?:ql)?|mysql|redis):\/\/[^\s:/@]+:[^\s@/]+@/gi, match => match.replace(/:[^:@/]+@/, ':<redacted>@'))
    .replace(/(?:Cookie|Set-Cookie):\s*[^\n]+/gi, match => `${match.split(':')[0]}: <redacted>`)
}

/**
 * The values a session's environment holds that must not be streamed.
 * @param env - the process environment of the runner.
 */
export function traceSecrets(env: NodeJS.ProcessEnv, extra: readonly string[] = []): string[] {
  const secrets: string[] = [...extra]
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < 8) continue
    if (!/(?:^|_)(?:API_KEY|KEY|TOKEN|SECRET|PASSWORD)$/i.test(name)) continue
    if (!secrets.includes(value)) secrets.push(value)
  }
  return secrets
}

function usageLine(data: Record<string, unknown>, state: TraceState): string | undefined {
  const usage = isRecord(data.usage) ? data.usage : undefined
  if (usage === undefined) return undefined
  const input = asNumber(usage.inputTokens)
  const output = asNumber(usage.outputTokens)
  if (input === undefined || output === undefined) return undefined
  const cache = asNumber(usage.cacheReadTokens) ?? 0
  const turn = asNumber(data.turn)
  const step = asNumber(data.step)
  const where = turn === undefined || step === undefined ? 'step' : `step ${String(turn)}.${String(step)}`
  const context = input + cache
  return `${where} usage: in ${String(input)} out ${String(output)} cache ${String(cache)}; context ${String(context)}${state.contextWindow === undefined ? '' : ` / ${String(state.contextWindow)}`}`
}

function reasonText(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (!isRecord(reason)) return 'unknown'
  const kind = asString(reason.kind) ?? 'unknown'
  const error = isRecord(reason.error) ? reason.error : undefined
  const message = error === undefined ? undefined : asString(error.message)
  return message === undefined ? kind : `${kind}: ${message}`
}

/**
 * Translate one session event. The state is updated in place for events that
 * carry context facts; an unknown type is one generic line.
 * @param event - a session event, as `snapshotEvents()` returned it.
 * @param state - the translator's cross-event state (the context window).
 * @param options - bounds, secrets, and whether visible assistant text is included.
 * @returns zero or more lines, each already bounded and redacted.
 */
export function translateSessionEvent(event: unknown, state: TraceState = {}, options: TraceOptions = {}): string[] {
  if (!isRecord(event)) return []
  const type = asString(event.type) ?? ''
  if (type === '') return []
  if (type === 'request/context') {
    const window = asNumber(dataOf(event).contextWindow)
    if (window !== undefined && window > 0) state.contextWindow = window
    return []
  }
  // These carry no information a person watching a run needs, or repeat the task prompt.
  if (['turn/start', 'step/start', 'step/end', 'request/header', 'user/message', 'system/message', 'developer/message', 'session/end-seed'].includes(type)) return []

  const data = dataOf(event)
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const toolChars = options.toolResults === 'full' ? maxChars : 300
  const line = (text: string, limit = maxChars): string => boundTraceLine(redactSecrets(text, options.secrets), limit)

  if (type === 'assistant/message') {
    const message = messageOf(data)
    const reasoning = blockText(message, ['reasoning'])
    const text = blockText(message, ['text'])
    const lines: string[] = []
    if (reasoning !== '') lines.push(line(`thinking: ${reasoning}`))
    if (text !== '' && options.includeText !== false) lines.push(line(`assistant: ${text}`))
    const usage = usageLine(data, state)
    if (usage !== undefined) lines.push(line(usage))
    return lines
  }

  if (type === 'tool/call') {
    const name = asString(data.name) ?? 'unknown'
    const args = asString(data.arguments) ?? ''
    return [line(`tool ${name}${args === '' ? '' : ` ${args}`}`, toolChars)]
  }

  if (type === 'tool/result') {
    const message = messageOf(data)
    const text = blockText(message, ['text'])
    const failed = message?.isError === true || isRecord(data.error)
    const error = isRecord(data.error) ? `${asString(data.error.code) ?? 'error'}: ${asString(data.error.reason) ?? asString(data.error.message) ?? ''}` : ''
    return [line(`result ${failed ? 'error' : 'ok'}${error === '' ? '' : ` (${error.trim()})`}${text === '' ? '' : `: ${text}`}`, toolChars)]
  }

  if (type === 'turn/end') {
    return [line(`turn end: ${reasonText(data.reason)}`)]
  }

  if (type === 'usage') {
    const input = asNumber(data.inputTokens) ?? asNumber(data.prompt_tokens)
    const output = asNumber(data.outputTokens) ?? asNumber(data.completion_tokens)
    if (input === undefined || output === undefined) return []
    return [line(`usage: in ${String(input)} out ${String(output)}`)]
  }

  const turn = asNumber(data.turn)
  const step = asNumber(data.step)
  const where = turn === undefined ? '' : ` ${String(turn)}${step === undefined ? '' : `.${String(step)}`}`
  return [line(`${type}${where}`)]
}

/** One line the runner writes to stderr; JSON keeps the decoded text exactly one line. */
export function encodeTraceLine(text: string, token = ''): string {
  return `${TRACE_PREFIX}${token === '' ? '' : `${token}:`} ${JSON.stringify(text)}`
}

/** The text of a trace line, or undefined for a line that is not one. */
export function decodeTraceLine(line: string, token?: string | undefined): string | undefined {
  const trimmed = line.trim()
  const prefix = token === undefined || token === '' ? TRACE_PREFIX : `${TRACE_PREFIX}${token}:`
  if (!trimmed.startsWith(prefix)) return undefined
  const raw = trimmed.slice(prefix.length).trim()
  if (raw === '') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Remove every trace line from captured stderr, so a failure message cannot leak it. */
export function stripTraceLines(text: string): string {
  return text.split('\n').filter(line => !line.trimStart().startsWith(TRACE_PREFIX)).join('\n')
}
