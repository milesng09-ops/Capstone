/**
 * Ids on an origin that is not secure.
 *
 * `crypto.randomUUID` is missing there -- the dev server opened from a phone
 * on the same network is the everyday case -- and every caller that minted an
 * id with it threw.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { newId } from '@/lib/id'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('newId', () => {
  it('uses randomUUID where the platform has it', () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => '11111111-2222-4333-8444-555555555555',
      getRandomValues: crypto.getRandomValues.bind(crypto),
    })

    expect(newId()).toBe('11111111-2222-4333-8444-555555555555')
  })

  it('still answers with a UUID on an origin without randomUUID', () => {
    // http://<lan-ip>: `getRandomValues` is there, `randomUUID` is not.
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })

    const ids = Array.from({ length: 50 }, () => newId())

    for (const id of ids) expect(id).toMatch(UUID)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('does not throw even with no crypto at all', () => {
    vi.stubGlobal('crypto', undefined)

    const first = newId()
    const second = newId()

    expect(first).not.toBe(second)
    expect(first.length).toBeGreaterThan(8)
  })
})
