/**
 * The tests that need a browser, because jsdom has no layout.
 *
 * Every other test in this project runs under jsdom, which computes no
 * geometry at all: `getBoundingClientRect` returns zeros and nothing has a
 * size. That is fine for logic and fatal for a whole class of bug this app
 * has shipped twice.
 *
 * - The drawing overlay was 300x150 in the top-left corner of the pane
 *   instead of covering it, so every tool was dead outside that square and a
 *   drag anywhere else panned the chart. Forty-six gesture tests passed
 *   throughout, because they render the overlay alone and nothing ever asks
 *   how big it is.
 * - The chart settings menu was clamped against a written-down height of
 *   168px while the menu had grown to 251, inside an ancestor that hides its
 *   overflow, so the section that links the charts had nowhere to be.
 *
 * Both reached the user. Both were found by opening the app. The specs here
 * are that check, written down: they assert *size and position*, which is
 * precisely what the unit suite cannot.
 *
 * Kept separate from `npm run test` -- vitest owns `src/**` and Playwright
 * owns `e2e/**` -- so the fast suite stays fast and this one is opt-in via
 * `npm run test:e2e`.
 */

import { defineConfig, devices } from '@playwright/test'

/**
 * A port of its own, so a run never collides with the dev server someone is
 * already looking at. This project has had another repo's server take 5173
 * more than once.
 */
const PORT = 5199
/**
 * `localhost`, not `127.0.0.1`. Vite binds the hostname rather than the
 * address, and on a machine where `localhost` resolves to `::1` first the
 * loopback IPv4 address is never listening -- the server starts fine and
 * Playwright waits out its whole timeout probing an address nothing is on.
 */
const HOST = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  // The charts fetch bars on load; a first paint can genuinely take a moment.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Serial by default: the specs drive one workspace whose state persists in
  // localStorage, and parallel workers would read each other's drawings.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: HOST,
    // A stated size, because these tests are *about* geometry. Left to the
    // window, a narrow runner would stack the panes differently and the
    // assertions would be measuring a different layout than they describe.
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: HOST,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
