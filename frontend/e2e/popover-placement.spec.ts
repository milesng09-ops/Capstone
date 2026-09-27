/**
 * Menus that have to fit on the screen they open on.
 *
 * The other bug this app shipped: the chart settings menu was positioned
 * against a written-down height of 168px while the menu had grown to 251, and
 * it opened inside an ancestor that hides its overflow. The section it cut
 * off was the one holding the chart-link switches -- so the control for
 * "stop moving all three charts at once" was unreachable from both of the two
 * places that offer it.
 *
 * Nothing in the unit suite can see this. jsdom gives every element a zero
 * box, so a menu is never too tall for anything and never outside anything.
 * The assertions here are containment: is the panel inside the viewport, and
 * is its last section actually on screen.
 */

import { expect, test, type Page } from '@playwright/test'

import { PANE, openWorkspace } from './fixtures'

/** The settings panel, by the name it answers to. */
const PANEL = '[role="group"][aria-label="Chart appearance and links"]'

test.beforeEach(async ({ page }) => {
  await openWorkspace(page)
})

async function expectOnScreen(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox()
  const viewport = page.viewportSize()
  expect(box, 'the panel has a box').not.toBeNull()
  expect(viewport, 'the viewport has a size').not.toBeNull()

  expect(box!.y, 'not off the top').toBeGreaterThanOrEqual(0)
  expect(box!.x, 'not off the left').toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height, 'not below the fold').toBeLessThanOrEqual(viewport!.height)
  expect(box!.x + box!.width, 'not past the right edge').toBeLessThanOrEqual(viewport!.width)
}

test.describe('the chart settings menu', () => {
  test('opens fully on screen from the rail', async ({ page }) => {
    await page.getByRole('button', { name: 'Chart appearance', exact: true }).click()
    await expect(page.locator(PANEL)).toBeVisible()
    await expectOnScreen(page, PANEL)

    // The section that was cut off is the reason this test exists, so assert
    // the switch itself is on screen rather than merely present.
    await expect(page.getByText('Link charts')).toBeVisible()
    await expect(page.getByText('Scroll & zoom')).toBeInViewport()
  })

  test('opens fully on screen from a right-click low in a short pane', async ({ page }) => {
    // The worst case: the menu is taller than the reference pane, and the
    // pane clips its overflow. Clamping it to the pane cannot work, which is
    // why it is clamped to the window instead.
    const panes = page.locator(PANE)
    const index = (await panes.count()) > 1 ? 1 : 0
    const box = await panes.nth(index).boundingBox()
    if (!box) throw new Error('the pane has no box')

    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 12, { button: 'right' })
    await expect(page.locator(PANEL)).toBeVisible()
    await expectOnScreen(page, PANEL)
    await expect(page.getByText('Scroll & zoom')).toBeInViewport()
  })

  test('scrolls rather than spilling when the window is shorter than it', async ({ page }) => {
    // Clamping can only move a panel. One taller than the window has to be
    // allowed to be smaller than its own contents, or the bottom is
    // unreachable again -- this time because of the window, not a constant.
    await page.setViewportSize({ width: 1280, height: 260 })
    await page.getByRole('button', { name: 'Chart appearance', exact: true }).click()
    await expect(page.locator(PANEL)).toBeVisible()
    await expectOnScreen(page, PANEL)

    const scrollable = await page.locator(PANEL).evaluate((el) => ({
      canScroll: el.scrollHeight > el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }))
    expect(scrollable.overflowY).toBe('auto')
    expect(scrollable.canScroll).toBe(true)
  })

  test('is placed again when the window shrinks under it', async ({ page }) => {
    // Measured before this was fixed: shrinking 900 -> 420 left the whole
    // panel 353px below the fold, and `position: fixed` means there is
    // nothing to scroll to reach it.
    await page.getByRole('button', { name: 'Chart appearance', exact: true }).click()
    await expect(page.locator(PANEL)).toBeVisible()

    await page.setViewportSize({ width: 1440, height: 420 })
    await expect
      .poll(async () => {
        const box = await page.locator(PANEL).boundingBox()
        return box ? box.y + box.height : Number.MAX_SAFE_INTEGER
      })
      .toBeLessThanOrEqual(420)
  })

  test('closes on Escape without dropping the held drawing tool', async ({ page }) => {
    // Escape used to reach the window-level shortcuts as well, so dismissing
    // the menu also put the rail back to the cursor.
    await page.getByRole('button', { name: 'Trend line', exact: true }).click()
    const trendLine = page.getByRole('button', { name: 'Trend line', exact: true })
    await expect(trendLine).toHaveAttribute('data-active', 'true')

    await page.getByRole('button', { name: 'Chart appearance', exact: true }).click()
    await expect(page.locator(PANEL)).toBeVisible()
    await page.keyboard.press('Escape')

    await expect(page.locator(PANEL)).toBeHidden()
    await expect(trendLine, 'the tool survives the dismissal').toHaveAttribute(
      'data-active',
      'true',
    )
  })
})
