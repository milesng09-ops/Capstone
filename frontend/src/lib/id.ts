/**
 * Random ids that work on any origin.
 *
 * `crypto.randomUUID` only exists in a secure context -- https, or localhost.
 * Opening the dev server from another device on the network, at
 * `http://<lan-ip>:5173`, left it undefined, so everything that minted an id
 * threw: the tab's session id fell back to one shared bucket, and drawing on
 * the chart did nothing at all. `getRandomValues` has no such restriction, so
 * the fallback is still random rather than a counter that two tabs could
 * agree on.
 */

let counter = 0

/** A version-4 UUID, or something just as unique where the platform lacks one. */
export function newId(): string {
  const source = globalThis.crypto as Crypto | undefined

  if (typeof source?.randomUUID === 'function') return source.randomUUID()

  if (typeof source?.getRandomValues === 'function') {
    const bytes = source.getRandomValues(new Uint8Array(16))
    // The two fields that make sixteen random bytes a version-4, RFC 4122
    // UUID, so the fallback is indistinguishable from the real thing.
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-')
  }

  // No `crypto` at all: nothing modern ships without it, but an id that is
  // unique within this page is still better than a throw.
  counter += 1
  const random = Math.random().toString(36).slice(2, 10)
  return `id-${Date.now().toString(36)}-${random}-${counter}`
}
