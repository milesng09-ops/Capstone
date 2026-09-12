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

import { ToolRail } from '@/components/chart/ToolRail'
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
