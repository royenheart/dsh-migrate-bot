export const DEFAULT_OUTPUT_MAX_BYTES = 50 * 1024
export const DEFAULT_OUTPUT_MAX_LINES = 2_000
export const DEFAULT_DETAILS_MAX_BYTES = 16 * 1024

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

function lineCount(text) {
  return text === '' ? 0 : text.split('\n').length
}

function truncateUtf8(text, maxBytes) {
  if (byteLength(text) <= maxBytes) return text
  let bytes = 0
  let kept = ''
  for (const character of text) {
    const next = byteLength(character)
    if (bytes + next > maxBytes) break
    kept += character
    bytes += next
  }
  return kept
}

function truncateHead(text, maxBytes, maxLines) {
  const byLines = text.split('\n').slice(0, maxLines).join('\n')
  return truncateUtf8(byLines, maxBytes)
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function summarizeValue(value) {
  if (value === null) return { type: 'null' }
  if (Array.isArray(value)) return { type: 'array', itemCount: value.length }
  if (typeof value !== 'object') return { type: typeof value }
  const keys = Object.keys(value)
  return {
    type: 'object',
    keyCount: keys.length,
    keys: keys.slice(0, 20),
  }
}

async function trySave(ctx, exec, label, suggestedName, content) {
  const sessionId = exec.agent?.session?.header?.id
  const spillStore = ctx.get('spillStore')
  if (sessionId === undefined || spillStore === undefined) return undefined
  try {
    return await spillStore.saveText({
      owner: { sessionId },
      source: {
        toolName: exec.name,
        callId: exec.callId,
        label,
      },
      suggestedName,
      content,
    })
  } catch (error) {
    ctx.logger?.warn?.(`dsh-mcp-adapter: could not save ${label}: ${String(error)}`)
    return undefined
  }
}

function spillReference(ref) {
  if (ref === undefined) return undefined
  return {
    locator: ref.locator,
    bytes: ref.bytes,
    retrievalHint: ref.retrievalHint,
  }
}

function truncationNotice(stats, ref) {
  const prefix = `[MCP output truncated: original ${stats.lines} lines / ${stats.bytes} bytes.`
  if (ref === undefined) return `${prefix} Full output could not be saved.]`
  return `${prefix} Full text stored at: ${ref.locator}. ${ref.retrievalHint}]`
}

async function guardText(ctx, exec, serverName, toolName, text, limits) {
  const stats = { bytes: byteLength(text), lines: lineCount(text) }
  if (stats.bytes <= limits.maxBytes && stats.lines <= limits.maxLines) {
    return { text }
  }

  const ref = await trySave(
    ctx,
    exec,
    'mcp-output',
    `${serverName}__${toolName}.txt`,
    text,
  )
  const notice = truncationNotice(stats, ref)
  const noticeText = `\n\n${notice}`
  const preview = truncateHead(
    text,
    Math.max(0, limits.maxBytes - byteLength(noticeText)),
    Math.max(0, limits.maxLines - lineCount(noticeText)),
  )
  const guardedText = truncateUtf8(
    preview === '' ? notice : `${preview}${noticeText}`,
    limits.maxBytes,
  )
  return {
    text: guardedText,
    guard: {
      textTruncated: true,
      originalBytes: stats.bytes,
      originalLines: stats.lines,
      returnedBytes: byteLength(guardedText),
      returnedLines: lineCount(guardedText),
      ...(ref === undefined ? {} : { fullText: spillReference(ref) }),
    },
  }
}

async function guardDetails(ctx, exec, serverName, toolName, result, limits) {
  const raw = safeStringify(result)
  const bytes = byteLength(raw)
  if (bytes <= limits.detailsMaxBytes) return { data: result }

  const ref = await trySave(
    ctx,
    exec,
    'mcp-result',
    `${serverName}__${toolName}-result.json`,
    raw,
  )
  const content = Array.isArray(result?.content) ? result.content : []
  const data = {
    omitted: true,
    reason: 'Raw MCP result exceeded the details size limit.',
    rawResultBytes: bytes,
    isError: result?.isError === true,
    contentBlocks: content.length,
    ...(result?.structuredContent === undefined
      ? {}
      : { structuredContent: summarizeValue(result.structuredContent) }),
    ...(ref === undefined ? {} : { fullResult: spillReference(ref) }),
  }
  return {
    data,
    guard: {
      resultSummarized: true,
      rawResultBytes: bytes,
      ...(ref === undefined ? {} : { fullResult: spillReference(ref) }),
    },
  }
}

export async function guardMcpOutput(
  ctx,
  exec,
  serverName,
  toolName,
  result,
  text,
  {
    maxBytes = DEFAULT_OUTPUT_MAX_BYTES,
    maxLines = DEFAULT_OUTPUT_MAX_LINES,
    detailsMaxBytes = DEFAULT_DETAILS_MAX_BYTES,
  } = {},
) {
  const limits = { maxBytes, maxLines, detailsMaxBytes }
  const [guardedText, guardedDetails] = await Promise.all([
    guardText(ctx, exec, serverName, toolName, text, limits),
    guardDetails(ctx, exec, serverName, toolName, result, limits),
  ])
  return {
    text: guardedText.text,
    data: guardedDetails.data,
    ...(guardedText.guard === undefined && guardedDetails.guard === undefined
      ? {}
      : {
          guard: {
            ...guardedText.guard,
            ...guardedDetails.guard,
          },
        }),
  }
}
