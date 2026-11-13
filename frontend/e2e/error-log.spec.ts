import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { stubApi } from './fixtures'

test('API errors are visible, downloadable and retained after refresh', async ({ page }) => {
  await stubApi(page)
  await page.route('**/api/bars?**', route => route.fulfill({
    status: 503, headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'test-reference' },
    body: JSON.stringify({ detail: 'Massive is temporarily unavailable apiKey=private-value' }),
  }))
  await page.goto('/')
  await expect(page.getByRole('alert').filter({ hasText: 'An error occurred' })).toBeVisible()
  await page.getByRole('button', { name: 'Show error log' }).click()
  const panel = page.getByRole('region', { name: 'Error log' })
  await expect(panel).toContainText('test-reference')
  await expect(panel).not.toContainText('private-value')
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download log' }).click()
  const download = await downloaded
  const saved = await readFile((await download.path())!, 'utf8')
  expect(saved).toContain('test-reference')
  expect(saved).not.toContain('private-value')
  await page.reload()
  await expect(page.getByRole('button', { name: /Error log \([1-9]/ })).toBeVisible()
})
