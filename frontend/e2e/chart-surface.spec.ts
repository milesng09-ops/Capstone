/**
 * The drawing surface, and whether it is where it claims to be.
 *
 * This file exists because of one bug that reached the user: every drawing
 * tool was dead. The cause was not the tools -- it was that the canvas they
 * answer on was 300x150 in the top-left corner of the pane instead of
 * covering it, so a drag anywhere else reached the chart and panned it. The
 * user's report was "it just moves the screen".
 *
 * Forty-six gesture tests passed throughout, and would have kept passing:
 * they render the overlay on its own under jsdom, which computes no layout,
 * so nothing ever asked how big it was. That is the gap these fill. Every
 * assertion here is about *geometry* -- a size, a position, a containment --
 * which is the one thing the fast suite structurally cannot check.
 *
 * The gestures deliberately start outside a 300x150 box at the pane's origin,
 * because that region is the whole point: it is where the old overlay ended
 * and the bug began.
 */

import { expect, test, type Page } from '@playwright/test'

import {
  OVERLAY,
  PANE,
  drawingCount,
  drawingKinds,
  levelRow,
  markerColumn,
  openWorkspace,
} from './fixtures'

/** The dead zone of the original bug. Gestures must begin beyond it. */
const OLD_OVERLAY = { width: 300, height: 150 }

test.beforeEach(async ({ page }) => {
  await openWorkspace(page)
})

/** Drag on the pane in pane-relative coordinates, with real input events. */
async function drag(
  page: Page,
  paneIndex: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const box = await page.locator(PANE).nth(paneIndex).boundingBox()
  if (!box) throw new Error('the pane has no box')

  await page.mouse.move(box.x + from.x, box.y + from.y)
  await page.mouse.down()
  // Several steps: the chart library starts a gesture on the *second* move,
  // so a single jump is read as a click and nothing is drawn.
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(
      box.x + from.x + ((to.x - from.x) * step) / 8,
      box.y + from.y + ((to.y - from.y) * step) / 8,
    )
  }
  await page.mouse.up()
}

test.describe('the drawing overlay', () => {
  test('covers its whole pane, not a corner of it', async ({ page }) => {
    const panes = page.locator(PANE)
    const count = await panes.count()
    expect(count).toBeGreaterThan(0)

    for (let index = 0; index < count; index += 1) {
      const pane = await panes.nth(index).boundingBox()
      const overlay = await page.locator(OVERLAY).nth(index).boundingBox()
      expect(pane, `pane ${index} has a box`).not.toBeNull()
      expect(overlay, `overlay ${index} has a box`).not.toBeNull()

      // Within a pixel: the canvas is positioned by CSS inset, so any real
      // difference means it is not sized by the rules it appears to be.
      expect(Math.abs(overlay!.width - pane!.width)).toBeLessThanOrEqual(1)
      expect(Math.abs(overlay!.height - pane!.height)).toBeLessThanOrEqual(1)

      // The exact failure, named: an intrinsic-sized canvas is 300x150.
      expect(overlay!.width).toBeGreaterThan(OLD_OVERLAY.width)
      expect(overlay!.height).toBeGreaterThan(OLD_OVERLAY.height)
    }
  })

  test('keeps covering the pane after the window is resized', async ({ page }) => {
    // The original bug only bit when a frame was never painted, so the size
    // has to hold across a relayout rather than merely on first load.
    await page.setViewportSize({ width: 1100, height: 700 })
    await expect
      .poll(async () => {
        const pane = await page.locator(PANE).first().boundingBox()
        const overlay = await page.locator(OVERLAY).first().boundingBox()
        return Math.abs((overlay?.width ?? 0) - (pane?.width ?? -1))
      })
      .toBeLessThanOrEqual(1)
  })
})

test.describe('every drawing tool', () => {
  // The three the user named, then the rest of the rail. Each is a drag well
  // clear of the old dead corner -- and starts inside the candle area. In the
  // test window the primary's candles end about 200px down, with the time
  // axis below them; three of these began on the axis, which is not a point
  // on the chart and no longer starts a shape.
  const tools: [string, string, { x: number; y: number }, { x: number; y: number }][] = [
    ['Trend line', 'trendline', { x: 440, y: 160 }, { x: 740, y: 100 }],
    ['Arrow', 'arrow', { x: 380, y: 180 }, { x: 620, y: 110 }],
    ['Zone', 'rectangle', { x: 340, y: 90 }, { x: 600, y: 200 }],
    ['Ray', 'ray', { x: 460, y: 190 }, { x: 780, y: 130 }],
    ['Level', 'horizontal', { x: 480, y: 120 }, { x: 720, y: 120 }],
    ['Level from here', 'horizontal_ray', { x: 500, y: 150 }, { x: 760, y: 150 }],
    ['Time marker', 'vertical', { x: 560, y: 80 }, { x: 560, y: 220 }],
    ['Fibonacci retracement', 'fib', { x: 410, y: 185 }, { x: 660, y: 60 }],
    ['Freehand', 'brush', { x: 360, y: 110 }, { x: 660, y: 190 }],
    ['Long position', 'long', { x: 420, y: 180 }, { x: 680, y: 100 }],
    ['Short position', 'short', { x: 430, y: 95 }, { x: 690, y: 210 }],
    ['Note', 'text', { x: 520, y: 170 }, { x: 520, y: 170 }],
  ]

  for (const [label, kind, from, to] of tools) {
    test(`${label} draws where the pointer is`, async ({ page }) => {
      // Guard the premise: a gesture inside the old corner would prove
      // nothing, since that region worked even when the bug was live.
      expect(
        from.x > OLD_OVERLAY.width || from.y > OLD_OVERLAY.height,
        'the gesture must start outside the old overlay',
      ).toBe(true)

      const before = await drawingCount(page)
      await page.getByRole('button', { name: label, exact: true }).click()
      await drag(page, 0, from, to)

      await expect.poll(() => drawingCount(page)).toBe(before + 1)
      expect(await drawingKinds(page)).toContain(kind)
    })
  }
})

test.describe('the reference pane', () => {
  test('draws on itself rather than on the primary', async ({ page }) => {
    // The overlay is per pane, so the sizing bug could return on one of them
    // alone -- and the reference pane is the short one, where it would.
    const panes = page.locator(PANE)
    test.skip((await panes.count()) < 2, 'needs a reference chart')

    const before = await drawingCount(page)
    await page.getByRole('button', { name: 'Trend line', exact: true }).click()
    await drag(page, 1, { x: 420, y: 70 }, { x: 700, y: 40 })

    await expect.poll(() => drawingCount(page)).toBe(before + 1)

    const symbols = await page.evaluate(() => {
      const raw = window.localStorage.getItem('mrl.workspace')
      return (JSON.parse(raw ?? '{}')?.state?.drawings ?? []).map(
        (d: { symbol: string }) => d.symbol,
      )
    })
    const primary = await page
      .locator(`${PANE} .chart-legend`)
      .first()
      .innerText()
    expect(symbols.at(-1)).not.toBe(primary.split('\n')[0].trim())
  })
})

test.describe("the chart's own controls while a tool is held", () => {
  /*
   * A held tool gives the overlay the pointer, and the overlay covers the
   * whole pane. It used to take the axes and the wheel with it: neither
   * scale could be dragged, and the wheel zoomed nothing, until the tool was
   * put down. Each of these holds the trend line tool and checks the chart
   * still answered -- by a shape drawn earlier moving on screen -- and that
   * nothing was drawn and the tool is still in hand.
   */
  async function placeThenHoldTrendLine(page: Page, tool: string, at: { x: number; y: number }) {
    const pane = await page.locator(PANE).first().boundingBox()
    if (!pane) throw new Error('the pane has no box')
    await page.getByRole('button', { name: tool, exact: true }).click()
    await page.mouse.click(pane.x + at.x, pane.y + at.y)
    await page.getByRole('button', { name: 'Trend line', exact: true }).click()
    return pane
  }

  async function stillHolding(page: Page, count: number) {
    expect(await drawingCount(page)).toBe(count)
    await expect(page.getByRole('button', { name: 'Trend line', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  }

  async function dragFrom(
    page: Page,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse.move(
        from.x + ((to.x - from.x) * step) / 10,
        from.y + ((to.y - from.y) * step) / 10,
      )
    }
    await page.mouse.up()
  }

  test('lets the price axis be dragged', async ({ page }) => {
    const pane = await placeThenHoldTrendLine(page, 'Level', { x: 480, y: 50 })
    await expect.poll(() => levelRow(page, 600)).not.toBeNull()
    const before = await levelRow(page, 600)
    const count = await drawingCount(page)

    const axisX = pane.x + pane.width - 25
    await dragFrom(page, { x: axisX, y: pane.y + 60 }, { x: axisX, y: pane.y + 160 })

    await expect.poll(() => levelRow(page, 600)).not.toBe(before)
    await stillHolding(page, count)
  })

  test('lets the time axis be dragged', async ({ page }) => {
    const pane = await placeThenHoldTrendLine(page, 'Time marker', { x: 560, y: 120 })
    await expect.poll(() => markerColumn(page, 120)).not.toBeNull()
    const before = await markerColumn(page, 120)
    const count = await drawingCount(page)

    const axisY = pane.y + pane.height - 12
    await dragFrom(page, { x: pane.x + 500, y: axisY }, { x: pane.x + 300, y: axisY })

    await expect.poll(() => markerColumn(page, 120)).not.toBe(before)
    await stillHolding(page, count)
  })

  test('zooms with the wheel over the candles, and the tool still draws', async ({ page }) => {
    const pane = await placeThenHoldTrendLine(page, 'Time marker', { x: 560, y: 120 })
    await expect.poll(() => markerColumn(page, 120)).not.toBeNull()
    const before = await markerColumn(page, 120)
    const count = await drawingCount(page)

    await page.mouse.move(pane.x + 300, pane.y + 150)
    await page.mouse.wheel(0, -300)

    await expect.poll(() => markerColumn(page, 120)).not.toBe(before)
    await stillHolding(page, count)

    // The candle area is still the tool's.
    await drag(page, 0, { x: 440, y: 160 }, { x: 740, y: 100 })
    await expect.poll(() => drawingCount(page)).toBe(count + 1)
  })
})
