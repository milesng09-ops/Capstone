import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Button, Disclosure } from '@/components/ui/primitives'

describe('Disclosure', () => {
  it('folds and unfolds on the header', async () => {
    render(
      <Disclosure label="Selected setup" defaultOpen>
        <p>the setup</p>
      </Disclosure>,
    )

    const toggle = screen.getByRole('button', { name: /selected setup/i })
    expect(screen.getByText('the setup')).toBeInTheDocument()

    await userEvent.click(toggle)
    expect(screen.queryByText('the setup')).not.toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(toggle)
    expect(screen.getByText('the setup')).toBeInTheDocument()
  })

  it('names what is folded away, so the collapsed header is not a mystery box', async () => {
    render(
      <Disclosure label="Selected setup" defaultOpen summary="NQ · 12 candles">
        <p>the setup</p>
      </Disclosure>,
    )

    // Only once folded -- open, the contents already say it.
    expect(screen.queryByText('NQ · 12 candles')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /selected setup/i }))
    expect(screen.getByText('NQ · 12 candles')).toBeInTheDocument()
  })

  it('runs a header action without also folding the section', async () => {
    // The clear-selection button sits in the header next to the toggle. Nested
    // inside it, clearing the setup would collapse the panel out from under
    // you -- and would be invalid markup besides.
    const onClear = vi.fn()
    render(
      <Disclosure
        label="Selected setup"
        defaultOpen
        action={
          <Button size="icon" variant="ghost" onClick={onClear} aria-label="Clear selection">
            x
          </Button>
        }
      >
        <p>the setup</p>
      </Disclosure>,
    )

    const toggle = screen.getByRole('button', { name: /selected setup/i })
    expect(toggle.querySelector('button')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(onClear).toHaveBeenCalledOnce()
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('the setup')).toBeInTheDocument()
  })
})
