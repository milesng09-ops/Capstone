/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the FastAPI backend is reachable. */
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
