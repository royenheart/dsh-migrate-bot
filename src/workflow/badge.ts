import type { Projection } from './projection.ts'

/** A shields.io endpoint badge. */
export interface Badge {
  schemaVersion: 1
  label: string
  message: string
  color: string
}

const OUTCOME_LABEL: Record<string, string> = {
  awaitingMerge: 'proposed',
  reporting: 'proposed',
  failed: 'failed',
  rejected: 'rejected',
  superseded: 'proposed',
  unpublished: 'changed',
}

/**
 * The README badge: the verified release, and the newest processed release when
 * it is a different one, with what happened to it.
 * @param projection - the projected consumer state.
 */
export function badgeOf(projection: Projection): Badge {
  const verified = projection.verified?.tag ?? 'unverified'
  const latest = projection.processed
  const tail = latest === undefined || latest.target.tag === projection.verified?.tag
    ? ''
    : ` | ${latest.target.tag} ${OUTCOME_LABEL[latest.state] ?? latest.state}`
  const color = tail === ''
    ? (projection.verified === undefined ? 'lightgrey' : '0E7C66')
    : latest?.state === 'failed' ? 'red' : 'yellow'
  return { schemaVersion: 1, label: 'dsh', message: `${verified}${tail}`, color }
}
