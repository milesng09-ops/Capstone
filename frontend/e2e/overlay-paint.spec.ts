/**
 * The drawing surface has to *paint*, not just be the right size.
 *
 * The geometry specs beside this one kept passing through a bug that left the
 * overlay blank. Under React's StrictMode the paint loop cancelled its own
 * first frame on the rehearsal unmount, then took the cancelled frame's handle
 * for a paint still on its way and never asked again -- so every gesture
 * landed and every drawing was stored, and nothing appeared on the chart. The
 * box was the size of the pane the whole time. Reading the canvas's pixels
 * back is the one check that sees it.
 */

import { expect, test, type Page } from '@playwright/test'

import { OVERLAY, PANE, levelRow, openWorkspace } from './fixtures'

test.beforeEach(async ({ page }) => {
  await openWorkspace(page)
})

/** How many pixels of the primary overlay carry any paint at all. */
async function ink(page: Page): Promise<number> {
  return page
    .locator(OVERLAY)
    .first()
    .evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext('2d')
      if (!context || canvas.width === 0 || canvas.height === 0) return 0
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let painted = 0
      for (let alpha = 3; alpha < pixels.length; alpha += 4) {
        if (pixels[alpha] > 0) painted += 1
      }
      return painted
    })
}

test('sizes its bitmap to the pane, which only a paint does', async ({ page }) => {
  const overlay = page.locator(OVERLAY).first()
  const box = await overlay.boundingBox()
  expect(box).not.toBeNull()

  // The element is sized by CSS; its bitmap only by the paint loop. Stuck at
  // the 300 default is the blank overlay, however the element measures.
  await expect
    .poll(() => overlay.evaluate((canvas: HTMLCanvasElement) => canvas.width))
    .toBeGreaterThan(300)
})

test('keeps a level on its price while the price axis is dragged', async ({ page }) => {
  // Scaling prices moves no time, and the overlay was only told about time:
  // the line stayed at its old height while the candles moved under it.
  const pane = await page.locator(PANE).first().boundingBox()
  if (!pane) throw new Error('the pane has no box')

  await page.getByRole('button', { name: 'Level', exact: true }).click()
  await page.mouse.click(pane.x + 480, pane.y + 50)
  await expect.poll(() => levelRow(page, 600)).not.toBeNull()
  const placed = await levelRow(page, 600)

  // Drag down the price axis, at the pane's right edge.
  const axisX = pane.x + pane.width - 25
  await page.mouse.move(axisX, pane.y + 60)
  await page.mouse.down()
  await page.mouse.move(axisX, pane.y + 160, { steps: 10 })
  await page.mouse.up()
  await expect.poll(() => levelRow(page, 600)).not.toBe(placed)
  const scaled = await levelRow(page, 600)

  // A zoom of the time axis repaints from scratch and, with the price scale
  // now fixed, moves no price -- so a line already in the right place stays.
  await page.mouse.move(pane.x + 480, pane.y + 150)
  await page.mouse.wheel(0, -120)
  await page.waitForTimeout(300)
  expect(await levelRow(page, 600)).toBe(scaled)
})

test('shows a level as soon as it is placed', async ({ page }) => {
  const pane = await page.locator(PANE).first().boundingBox()
  if (!pane) throw new Error('the pane has no box')

  // The chart starts clean, so anything painted after this is the level.
  const before = await ink(page)

  await page.getByRole('button', { name: 'Level', exact: true }).click()
  await page.mouse.click(pane.x + 480, pane.y + 140)

  // A horizontal line across the candle area: hundreds of pixels at least.
  await expect.poll(() => ink(page)).toBeGreaterThan(before + 300)
})
