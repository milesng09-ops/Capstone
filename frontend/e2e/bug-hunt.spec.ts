import { expect, test } from '@playwright/test'
import { PANE, openWorkspace } from './fixtures'

test.beforeEach(async ({ page }) => { await openWorkspace(page) })

test('F in a focused dropdown leaves the workspace layout alone', async ({ page }) => {
  const dropdown = page.locator('select').first()
  await dropdown.focus()
  await dropdown.press('f')
  await expect(page.getByRole('button', { name: 'Focus on the charts', exact: true }))
    .toHaveAttribute('aria-pressed', 'false')
})

test('the note toolbar and Delete button fit inside the chart pane', async ({ page }) => {
  const pane = page.locator(PANE).first()
  const box = await pane.boundingBox()
  if (!box) throw new Error('the chart pane has no box')
  await page.getByRole('button', { name: 'Note', exact: true }).click()
  await page.mouse.click(box.x + box.width - 120, box.y + 170)
  const toolbar = page.getByRole('toolbar', { name: 'Note actions' })
  await expect(toolbar).toBeVisible()
  await expect.poll(async () => {
    const bar = await toolbar.boundingBox()
    return bar ? bar.x + bar.width <= box.x + box.width : false
  }).toBe(true)
  const remove = toolbar.getByRole('button', { name: 'Delete drawing', exact: true })
  await expect(remove).toBeVisible()
  await remove.click()
  await expect(toolbar).toBeHidden()
})
