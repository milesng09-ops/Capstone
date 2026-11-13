import { expect, test } from '@playwright/test'
import { stubApi, OVERLAY } from './fixtures'

const BACKEND = 'http://127.0.0.1:8199'
const BASE = Date.parse('2026-01-05T23:00:00Z')
const HOUR = 3_600_000

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(BASE + 15 * HOUR))
  await stubApi(page)
  // Keep unrelated provider/status endpoints offline, but every backtest
  // POST/GET goes through the actual Python API and an isolated database.
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.startsWith('/api/backtests')) {
      const response = await route.fetch({ url: BACKEND + url.pathname + url.search })
      return route.fulfill({ response })
    }
    if (url.pathname === '/api/bars') {
      const response = await page.request.get(`${BACKEND}/test/market?symbol=${url.searchParams.get('symbol')}`)
      const bars = (await response.json()).filter((bar: { time: number }) =>
        bar.time >= Number(url.searchParams.get('from')) && bar.time <= Number(url.searchParams.get('to')))
      return route.fulfill({ json: {
        symbol: url.searchParams.get('symbol'), interval: url.searchParams.get('interval'),
        bars, provider: 'fixture', quality: 'demo', cached: true, fallback_active: false,
        from_time: Number(url.searchParams.get('from')), to_time: Number(url.searchParams.get('to')),
      } })
    }
    return route.fallback()
  })
  await page.addInitScript(({ start, end }) => {
    localStorage.setItem('mrl.workspace', JSON.stringify({ version: 4, state: {
      strategy: 'gxt_research', primarySymbol: 'NQ', compareSymbols: ['ES'],
      interval: '1h', rangeDays: 7, resultsOpen: true, sidePanel: 'strategy',
      gxt: { sequence_model: 'legacy_gap', direction: 'both', require_cross_asset: true, confirmation_bars: 12,
        minimum_body_fraction: 0.5, stop_buffer_ticks: 1, minimum_reward_risk: 1.5, ny_morning_only: false },
      testWindow: { start_time: start, end_time: end },
    } }))
  }, { start: BASE + 9 * HOUR, end: BASE + 14 * HOUR })
})

test('GXT submits, simulates, saves and displays a warmup-context trade', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator(OVERLAY).first()).toBeVisible()
  const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/backtests') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Backtest GXT research' }).click()
  const response = await responsePromise
  expect(response.status()).toBe(201)
  const result = await response.json()
  expect(result.trades).toHaveLength(1)
  expect(result.trades[0].target_price).toBe(140)
  const row = page.getByRole('row').filter({ hasText: 'NQ' })
  await expect(row).toHaveCount(1)
  await row.click()
  await expect(row).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('GXT research · #1 long NQ')).toBeVisible()
  // A mounted canvas can still be completely blank; inspect the actual
  // painted pixels, not just its CSS size or the trade table.
  await expect.poll(() => page.locator(OVERLAY).first().evaluate(canvas => {
    const element = canvas as HTMLCanvasElement
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
    return pixels.some((value, index) => index % 4 === 3 && value > 0)
  })).toBe(true)
  const saved = await page.request.get(`${BACKEND}/api/backtests/${result.id}`)
  expect((await saved.json()).trades).toEqual(result.trades)
  await page.screenshot({ path: 'test-results/gxt-backtest-trade.png' })
})

test('selecting an old trade loads its candles outside the live chart range', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-07-01T12:00:00Z'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Backtest GXT research' }).click()
  const row = page.getByRole('row').filter({ hasText: 'NQ' })
  await expect(row).toHaveCount(1)
  const historicalBars = page.waitForResponse(r => {
    const url = new URL(r.url())
    return url.pathname === '/api/bars' && Number(url.searchParams.get('from')) < BASE + 11 * HOUR
      && Number(url.searchParams.get('to')) > BASE + 12 * HOUR
  })
  await row.click()
  expect((await (await historicalBars).json()).bars.length).toBeGreaterThan(0)
  await expect(page.locator(OVERLAY).first()).toBeVisible()
  await expect(page.getByText('GXT research · #1 long NQ')).toBeVisible()
})

test('a valid no-trade run displays the actual rejection reason', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Minimum reward/risk').fill('20')
  await page.getByLabel('Minimum reward/risk').blur()
  await page.getByRole('button', { name: 'Backtest GXT research' }).click()
  await expect(page.getByText('Why this GXT run has no trades')).toBeVisible()
  await expect(page.getByText('Win rate').locator('..')).toContainText('N/A')
  await expect(page.getByRole('listitem').filter({ hasText: 'The next-open reward/risk is below the configured minimum.' })).toBeVisible()
})

test('source-linked continuation trades at the 4H open and displays its lesson evidence', async ({ page }) => {
  await page.addInitScript(({ start, end }) => {
    const persisted = JSON.parse(localStorage.getItem('mrl.workspace')!)
    persisted.state.primarySymbol = 'YM'
    persisted.state.testWindow = { start_time: start, end_time: end }
    persisted.state.gxt.sequence_model = 'c2_continuation'
    localStorage.setItem('mrl.workspace', JSON.stringify(persisted))
  }, { start: BASE, end: BASE+6*HOUR })
  await page.goto('/')
  const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/backtests') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Backtest GXT research' }).click()
  const response = await responsePromise
  expect(response.status()).toBe(201)
  const run = await response.json()
  expect(run.summary.gxt.version).toBe('gxt-c2-continuation-v2')
  expect(run.trades).toHaveLength(1)
  expect(run.trades[0].entry_time).toBe(BASE+4*HOUR)
  await page.locator('tr[title="Show this trade on the chart"]').filter({ hasText: 'YM' }).click()
  await expect(page.getByText('GXT research · #1 long YM')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Garrett lesson at the rule timestamp' })).toHaveCount(2)
  await page.screenshot({ path: 'test-results/gxt-continuation-trade.png' })
})
