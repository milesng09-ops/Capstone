import { Component, type ReactNode } from 'react'
import { reportError, useErrorLog } from '@/lib/errorLog'
import { Button } from '@/components/ui/primitives'

export class WorkspaceErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error) { reportError(error, 'Workspace rendering') }
  render() {
    if (this.state.failed) return <main className="grid h-screen place-content-center gap-3 p-6" role="alert">
      <p>The workspace encountered an error. Its details are in the error log.</p>
      <Button onClick={() => window.location.reload()}>Reload workspace</Button>
      <ErrorLogButton />
    </main>
    return this.props.children
  }
}

export function ErrorLog() {
  const { entries, dismiss, clear, open, setOpen } = useErrorLog()
  const latest = entries.find(entry => !entry.dismissed)
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'market-replay-errors.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <aside className="pointer-events-none fixed bottom-8 right-3 z-[100] w-[min(32rem,calc(100vw-1.5rem))] text-xs" aria-label="Application errors">
    {latest && !open && <div role="alert" className="pointer-events-auto mb-2 rounded-md border border-bear bg-background p-3 shadow-xl">
      <p className="font-semibold">An error occurred · {latest.context}</p>
      <p className="text-2xs text-muted-foreground">{ago(latest.time)}{latest.count > 1 ? ` · ${latest.count} times` : ''}</p>
      <p className="mt-1 break-words">{latest.message}</p>
      {latest.requestId && <p className="mt-1 text-muted-foreground">Reference: {latest.requestId}</p>}
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={() => setOpen(true)}>Show error log</Button>
        <Button size="sm" onClick={dismiss}>Dismiss notification</Button>
      </div>
    </div>}
    {open && <section aria-label="Error log" className="pointer-events-auto mb-2 flex max-h-[60dvh] flex-col rounded-md border border-border bg-background p-3 shadow-xl">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <strong className="mr-auto">Error log ({entries.length})</strong>
        <Button size="sm" disabled={!entries.length} onClick={download}>Download log</Button>
        <Button size="sm" onClick={clear}>Clear log</Button>
        <Button size="sm" onClick={() => { setOpen(false); dismiss() }}>Close log</Button>
      </div>
      <div className="min-h-0 space-y-3 overflow-y-auto" aria-live="polite">
        {!entries.length && <p>No errors recorded in this tab.</p>}
        {entries.map(entry => <article key={entry.id} className="break-words border-t border-border pt-2">
          <p className="font-semibold">{entry.context}{entry.status ? ` · HTTP ${entry.status}` : ''}{entry.count > 1 ? ` · ${entry.count} occurrences` : ''}</p>
          <p className="mt-1">{entry.message}</p>
          <p className="mt-1 text-2xs text-muted-foreground">{entry.time}{entry.requestId ? ` · Reference: ${entry.requestId}` : ''}</p>
        </article>)}
      </div>
    </section>}
  </aside>
}

export function ErrorLogButton() {
  const { entries, open, setOpen } = useErrorLog()
  return <Button size="sm" variant="toolbar" onClick={() => setOpen(!open)} aria-expanded={open}>Error log ({entries.length})</Button>
}

/** "just now", "3 min ago": an old error should look old. */
function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (!Number.isFinite(seconds) || seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  return new Date(iso).toLocaleTimeString()
}
