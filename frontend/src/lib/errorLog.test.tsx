import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ErrorLog, ErrorLogButton, WorkspaceErrorBoundary } from '@/components/layout/ErrorLog'
import { installErrorListeners, reportError, useErrorLog } from './errorLog'

beforeEach(() => {
  useErrorLog.getState().clear()
  useErrorLog.getState().setOpen(false)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

it('shows failures on screen, retains dismissed errors, and groups repeated failures', () => {
  reportError(new Error('Massive returned 503'), 'GET /api/bars?apiKey=private-value', 503, 'ref-1')
  reportError(new Error('Massive returned 503'), 'GET /api/bars?apiKey=private-value', 503, 'ref-2')
  render(<><ErrorLog /><ErrorLogButton /></>)
  expect(screen.getByRole('alert')).toHaveTextContent('Massive returned 503')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Error log (1)' }))
  expect(screen.getByRole('region', { name: 'Error log' })).toHaveTextContent('2 occurrences')
  expect(screen.getByRole('region', { name: 'Error log' })).toHaveTextContent('ref-2')
  expect(JSON.stringify(useErrorLog.getState().entries)).not.toContain('private-value')
  expect(console.error).toHaveBeenCalledTimes(1)
})

it('redacts credentials, persists the session log, and limits its size', () => {
  reportError('apiKey=private-value Bearer private-token', 'API')
  expect(sessionStorage.getItem('mrl.error-log')).not.toMatch(/private-value|private-token/)
  for (let i = 0; i < 105; i++) reportError(`Failure ${i}`, 'API')
  expect(useErrorLog.getState().entries).toHaveLength(100)
})

it('reports unhandled browser failures, ignores cancellations and cleans up listeners', () => {
  const remove = installErrorListeners()
  window.dispatchEvent(new ErrorEvent('error', { message: 'Unexpected failure' }))
  expect(useErrorLog.getState().entries[0].message).toBe('Unexpected failure')
  const rejection = new Event('unhandledrejection')
  Object.defineProperty(rejection, 'reason', { value: new Error('Rejected operation') })
  window.dispatchEvent(rejection)
  expect(useErrorLog.getState().entries).toHaveLength(2)
  reportError(new DOMException('Cancelled', 'AbortError'), 'Cancelled query')
  remove()
  window.dispatchEvent(new ErrorEvent('error', { message: 'After cleanup' }))
  expect(useErrorLog.getState().entries).toHaveLength(2)
})

it('keeps a visible recovery screen and error log when rendering fails', () => {
  function Broken(): never { throw new Error('Render failed') }
  render(<><WorkspaceErrorBoundary><Broken /></WorkspaceErrorBoundary><ErrorLog /></>)
  expect(screen.getByRole('button', { name: 'Reload workspace' })).toBeInTheDocument()
  expect(screen.getByText('Render failed')).toBeInTheDocument()
})
