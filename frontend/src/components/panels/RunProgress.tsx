/**
 * What a running backtest is doing, under the run button.
 *
 * Before this the button said "Testing..." for as long as the run took, and a
 * GXT run over months of 1-minute candles takes ten minutes or more -- nearly
 * all of it waiting on Massive's five-requests-a-minute quota. A run that was
 * working and a run that was stuck looked identical, so people refreshed, and
 * that lost the run. This says which market is loading, how far through it
 * is, and when it is waiting out the quota, how long for.
 */

import { useEffect, useState } from 'react'

import { useWorkspace } from '@/store/workspace'

export function RunProgress() {
  const job = useWorkspace((state) => state.runJob)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!job) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [job])

  if (!job || job.status !== 'running') return null

  const elapsed = Math.max(0, Math.round(now / 1000 - job.started_at))
  const waitLeft = job.waiting_until ? Math.max(0, Math.ceil(job.waiting_until - now / 1000)) : null
  const counted = job.total != null && job.done != null && job.total > 1
  const percent = counted ? Math.round((job.done! / job.total!) * 100) : null

  return (
    <div
      role="status"
      aria-live="polite"
      className="space-y-1 rounded-md border border-border bg-surface-2 p-2 text-2xs leading-relaxed"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-foreground">
          {job.stage}
          {counted && ` · part ${Math.min(job.done! + 1, job.total!)} of ${job.total}`}
        </span>
        <span className="numeric shrink-0 text-muted-foreground">{formatElapsed(elapsed)}</span>
      </div>
      {percent != null && (
        <div className="h-1 overflow-hidden rounded bg-border" aria-hidden>
          <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      )}
      {job.detail && (
        <p className={waitLeft ? 'text-amber-300' : 'text-muted-foreground'}>
          {waitLeft != null && waitLeft > 0
            ? job.detail.replace(/Waiting \d+s/, `Waiting ${waitLeft}s`)
            : job.detail}
        </p>
      )}
      <p className="text-muted-foreground">
        Runs on the server: refreshing the page will not lose it. Fetched candles are cached, so a
        re-run over the same window is quick.
      </p>
    </div>
  )
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}
