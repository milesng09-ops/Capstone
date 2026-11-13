import { create } from 'zustand'

export interface ErrorEntry {
  id: string
  time: string
  context: string
  message: string
  status?: number
  requestId?: string
  count: number
  dismissed: boolean
}
const KEY = 'mrl.error-log'
const LIMIT = 100

/** Never retain request bodies, headers, query strings, or credentials. */
export function redact(value: string): string {
  return value
    .replace(/(bearer\s+)[^\s"'<>]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|\w*token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s&"'<>]+/gi, '$1[redacted]')
    .slice(0, 2000)
}

/*
 * Restored entries come back dismissed: they stay in the log but never pop up
 * again. An error from before the refresh is history, and showing it as news is
 * how a backend that was back up still read "Cannot reach" after a reload.
 */
function restore(): ErrorEntry[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(e => e && typeof e.id === 'string' && typeof e.message === 'string'
      && typeof e.context === 'string' && typeof e.time === 'string').slice(0, LIMIT)
      .map(e => ({ id: e.id, time: e.time, context: redact(e.context.split('?')[0]),
        message: redact(e.message), status: typeof e.status === 'number' ? e.status : undefined,
        requestId: typeof e.requestId === 'string' ? redact(e.requestId) : undefined,
        count: Number.isSafeInteger(e.count) && e.count > 0 ? e.count : 1, dismissed: true }))
  } catch { return [] }
}
function persist(entries: ErrorEntry[]) {
  try { sessionStorage.setItem(KEY, JSON.stringify(entries)) } catch { /* Storage can be unavailable. */ }
}

export const useErrorLog = create<{
  entries: ErrorEntry[]
  open: boolean
  setOpen: (open: boolean) => void
  dismiss: () => void
  clear: () => void
}>(set => ({
  entries: restore(),
  open: false,
  setOpen: open => set({ open }),
  dismiss: () => set(state => {
    const entries = state.entries.map(entry => ({ ...entry, dismissed: true }))
    persist(entries)
    return { entries }
  }),
  clear: () => { persist([]); set({ entries: [] }) },
}))

export function reportError(error: unknown, context: string, status?: number, requestId?: string) {
  if ((error as { name?: string })?.name === 'AbortError') return
  const message = redact(error instanceof Error ? error.message : typeof error === 'string' ? error : 'An unexpected error occurred.')
  const safeContext = redact(context.split('?')[0])
  const entries = useErrorLog.getState().entries
  const previous = entries.find(e => e.context === safeContext && e.message === message && e.status === status)
  const entry: ErrorEntry = {
    id: previous?.id ?? crypto.randomUUID(), time: new Date().toISOString(),
    message, context: safeContext, status, requestId: requestId ? redact(requestId) : undefined,
    count: (previous?.count ?? 0) + 1, dismissed: false,
  }
  const next = [entry, ...entries.filter(e => e.id !== entry.id)].slice(0, LIMIT)
  persist(next)
  useErrorLog.setState({ entries: next })
  if (!previous) console.error('[Market Replay Lab]', entry)
}

/**
 * The backend answered: any "cannot reach it" notice still on screen is over.
 *
 * Those entries (status 0) stay in the log as a record, but the notification
 * is withdrawn -- otherwise a blip while the server restarted kept saying the
 * backend was down long after every request was succeeding again.
 */
export function noteBackendReachable() {
  const entries = useErrorLog.getState().entries
  if (!entries.some(entry => entry.status === 0 && !entry.dismissed)) return
  const next = entries.map(entry => entry.status === 0 ? { ...entry, dismissed: true } : entry)
  persist(next)
  useErrorLog.setState({ entries: next })
}

export function installErrorListeners(): () => void {
  const onError = (event: ErrorEvent) => reportError(event.error ?? event.message, 'Application')
  const onRejection = (event: PromiseRejectionEvent) => reportError(event.reason, 'Unhandled operation')
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
