import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'

import App from '@/App'
import { ErrorLog, WorkspaceErrorBoundary } from '@/components/layout/ErrorLog'
import { installErrorListeners, reportError } from '@/lib/errorLog'
import { ApiError } from '@/services/api'
import '@/index.css'

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: error => {
    if (!(error instanceof ApiError)) reportError(error, 'Data loading')
  } }),
  mutationCache: new MutationCache({ onError: error => {
    if (!(error instanceof ApiError)) reportError(error, 'Requested operation')
  } }),
  defaultOptions: {
    queries: {
      // Market data is fetched through a server-side cache already, so the
      // browser refetching on every window focus buys nothing and costs a
      // provider call.
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // A backend that is not running, or a request the server rejected as
        // invalid, will not fix itself by being asked again.
        const status = (error as { status?: number })?.status
        if (status != null && status !== 0 && status < 500) return false
        return failureCount < 2
      },
    },
  },
})
const removeErrorListeners = installErrorListeners()
if (import.meta.hot) import.meta.hot.dispose(removeErrorListeners)

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root element #root is missing from index.html')
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <WorkspaceErrorBoundary><App /></WorkspaceErrorBoundary>
      <ErrorLog />
    </QueryClientProvider>
  </StrictMode>,
)
