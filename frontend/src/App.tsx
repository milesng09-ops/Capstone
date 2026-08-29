import { useDrawingShortcuts } from '@/hooks/useDrawingShortcuts'
import { Workspace } from '@/pages/Workspace'

export default function App() {
  // Bound at the root because these are window-level keys: the chart is a
  // canvas and never holds focus, so there is nothing lower down to bind to.
  useDrawingShortcuts()

  return <Workspace />
}
