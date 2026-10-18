/**
 * The price on screen, kept live.
 *
 * The chart's window only moves on the hour, and nothing else asked for the
 * bars again: the bar forming now was fetched once and left as it was, so
 * the price in the legend and on the axis could be most of an hour old. These
 * run on a fake clock set inside and outside the futures session, and serve a
 * different close for the forming bar from the second request on.
 */

import { expect, test, type Page } from '@playwright/test'

import { PANE, barsResponse, stubApi } from './fixtures'

/** Wednesday 8 July 2026, 10:00 in Chicago: the market is trading. */
const TRADING = new Date('2026-07-08T15:00:00Z')
/** Saturday 11 July 2026, noon in Chicago: it is shut. */
const WEEKEND = new Date('2026-07-11T17:00:00Z')

const MOVED_CLOSE = 12_345.75

/**
 * Open the workspace at `time`, counting the primary's bar requests.
 *
 * The forming bar's close moves when `move` is called rather than on some
 * numbered request: under StrictMode in dev each series is asked for twice
 * at mount, the first abandoned, so a count says nothing about which answer
 * reached the screen.
 */
async function openAt(page: Page, time: Date) {
  await page.clock.install({ time })
  await stubApi(page)
  const state = { requests: 0, moved: false }
  // Registered after the stub, so it is asked first; anything not the
  // primary's bars falls through to the stub.
  await page.route('**/api/bars**', (route) => {
    const url = new URL(route.request().url())
    const symbol = url.searchParams.get('symbol') ?? 'ES'
    if (symbol !== 'NQ') return route.fallback()
    state.requests += 1
    const body = barsResponse(
      symbol,
      url.searchParams.get('interval') ?? '1h',
      state.moved ? MOVED_CLOSE : undefined,
    )
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.addInitScript(() => window.localStorage.removeItem('mrl.workspace'))
  await page.goto('/')
  await page.locator('.chart-legend').first().waitFor({ state: 'visible' })
  return {
    requests: () => state.requests,
    move: () => {
      state.moved = true
    },
  }
}

/** The primary's last price, as the legend prints it. */
function legendPrice(page: Page) {
  return page.locator(PANE).first().locator('.chart-legend .numeric').first()
}

test('asks again every minute while the market trades, and shows the new price', async ({
  page,
}) => {
  const live = await openAt(page, TRADING)
  await expect(legendPrice(page)).toBeVisible()
  await page.waitForTimeout(500)
  const before = live.requests()
  live.move()

  await page.clock.fastForward(61_000)

  await expect.poll(() => live.requests()).toBeGreaterThan(before)
  await expect(legendPrice(page)).toContainText('12,345.75')
})

test('leaves the bars alone while the market is shut', async ({ page }) => {
  const live = await openAt(page, WEEKEND)
  await expect(legendPrice(page)).toBeVisible()
  await page.waitForTimeout(500)
  const before = live.requests()
  live.move()

  await page.clock.fastForward(61_000)
  await page.waitForTimeout(500)

  expect(live.requests()).toBe(before)
  await expect(legendPrice(page)).not.toContainText('12,345.75')
})

test("measures the change from the previous session's close, and says so", async ({
  page,
}) => {
  await openAt(page, TRADING)
  await expect(legendPrice(page)).toHaveAttribute(
    'title',
    /since the previous session's close/,
  )
})
