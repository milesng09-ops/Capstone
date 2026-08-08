import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import App from '@/App'
import '@/index.css'

const queryClient = new QueryClient({
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

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root element #root is missing from index.html')
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
