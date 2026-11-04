/**
 * Choose the two benchmark records the Overview compares by default.
 *
 * The site carries one summary per record, including the ids of the tasks the
 * record scored. Keeping the choice here makes it testable without a browser
 * and gives the page and its tests one definition of "most comparable".
 */

export interface PairRecord {
  id: string
  scoredTasks?: readonly string[]
}

/**
 * Pick a base (older) and head (newer) record.
 *
 * Explicit endpoints win, including a self-comparison. With one endpoint fixed,
 * the other is the best-scoring record on the correct side of it; with none,
 * the pair with the largest task intersection wins, then the newer head and the
 * closer base.
 * @param records - records for one suite and subject, newest first.
 * @param requestedBase - a base id from the URL, when present.
 * @param requestedHead - a head id from the URL, when present.
 */
export function choosePair(records: readonly PairRecord[], requestedBase?: string | undefined, requestedHead?: string | undefined): [string, string] {
  if (records.length === 0) return ['', '']
  if (records.length === 1) return [records[0]?.id ?? '', records[0]?.id ?? '']
  const baseIndex = records.findIndex(record => record.id === requestedBase)
  const headIndex = records.findIndex(record => record.id === requestedHead)
  if (baseIndex >= 0 && headIndex >= 0) return [records[baseIndex]?.id ?? '', records[headIndex]?.id ?? '']
  const ids = records.map(record => new Set(record.scoredTasks ?? []))
  const shared = (left: number, right: number): number => [...ids[left] ?? []].filter(task => ids[right]?.has(task) === true).length
  if (baseIndex >= 0) {
    let best = { index: -1, shared: -1 }
    for (let index = baseIndex - 1; index >= 0; index -= 1) {
      const count = shared(baseIndex, index)
      if (count > best.shared || (count === best.shared && (best.index === -1 || index > best.index))) best = { index, shared: count }
    }
    return best.index === -1 ? [records[baseIndex]?.id ?? '', records[baseIndex]?.id ?? ''] : [records[baseIndex]?.id ?? '', records[best.index]?.id ?? '']
  }
  if (headIndex >= 0) {
    let best = { index: -1, shared: -1 }
    for (let index = headIndex + 1; index < records.length; index += 1) {
      const count = shared(index, headIndex)
      if (count > best.shared || (count === best.shared && (best.index === -1 || index < best.index))) best = { index, shared: count }
    }
    return best.index === -1 ? [records[headIndex]?.id ?? '', records[headIndex]?.id ?? ''] : [records[best.index]?.id ?? '', records[headIndex]?.id ?? '']
  }
  let best = { baseIndex: 1, headIndex: 0, shared: -1 }
  for (let head = 0; head < records.length; head += 1) {
    for (let base = head + 1; base < records.length; base += 1) {
      const count = shared(base, head)
      if (count > best.shared || (count === best.shared && (head < best.headIndex || (head === best.headIndex && base < best.baseIndex)))) best = { baseIndex: base, headIndex: head, shared: count }
    }
  }
  return [records[best.baseIndex]?.id ?? '', records[best.headIndex]?.id ?? '']
}
