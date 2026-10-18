/**
 * The rail, and the guard that it lists everything.
 *
 * The bug this file exists for: the ray, the level-from-here, the arrow, the
 * time marker and the note were all implemented end to end -- icons, hit
 * tests, paint code, store wiring -- and none of them had a button. Nothing
 * failed. A tool missing from an array is not a type error, and no test
 * asked whether a tool could be reached, so the suite stayed green while five
 * tools were reachable by nothing at all.
 *
 * `TOOL_LABELS` is keyed by `ToolMode`, so the compiler already forces a new
 * tool to be named. The test below forces it to be *offered*.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { ChartSettingsBody, ToolRail } from '@/components/chart/ToolRail'
import { useWorkspace } from '@/store/workspace'
import { TOOL_LABELS, type ToolMode } from '@/types/drawing'

const ALL_TOOLS = Object.keys(TOOL_LABELS) as ToolMode[]

describe('ToolRail', () => {
  beforeEach(() => {
    useWorkspace.setState({ tool: 'cursor', drawings: [], focusMode: false })
  })

  it.each(ALL_TOOLS)('offers %s', (mode) => {
    render(<ToolRail />)

    expect(screen.getByRole('button', { name: TOOL_LABELS[mode] })).toBeTruthy()
  })

  it('holds the tool that was pressed', () => {
    render(<ToolRail />)

    fireEvent.click(screen.getByRole('button', { name: TOOL_LABELS.ray }))

    expect(useWorkspace.getState().tool).toBe('ray')
  })

  it('marks only the held tool as pressed', () => {
    useWorkspace.setState({ tool: 'text' })
    render(<ToolRail />)

    const pressed = ALL_TOOLS.filter(
      (mode) =>
        screen.getByRole('button', { name: TOOL_LABELS[mode] }).getAttribute('aria-pressed') ===
        'true',
    )
    expect(pressed).toEqual(['text'])
  })

  it('explains what each tool does, since a 40px rail is all icons', () => {
    render(<ToolRail />)

    for (const mode of ALL_TOOLS) {
      const title = screen.getByRole('button', { name: TOOL_LABELS[mode] }).getAttribute('title')
      expect(title).toContain(TOOL_LABELS[mode])
      // The hint, not just the name: an icon alone never says what "zone" or
      // "level from here" means to someone opening this for the first time.
      expect(title!.length).toBeGreaterThan(TOOL_LABELS[mode].length + 10)
    }
  })
})

describe('ChartSettingsBody', () => {
  it('explains the chart links in a colour that can be read', () => {
    // These two lines are the only place that says what the switches govern,
    // and `text-muted` -- the muted background token -- drew them at about
    // 1.1:1 against the panel.
    const { container } = render(<ChartSettingsBody />)

    expect(container.querySelectorAll('.text-muted')).toHaveLength(0)
    expect(screen.getByText(/chart (scrolls|moves)|charts? (scroll|move)/i).className).toContain(
      'text-muted-foreground',
    )
    expect(screen.getByText(/bar size/).className).toContain('text-muted-foreground')
  })
})
