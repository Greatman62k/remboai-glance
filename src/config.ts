const viteEnv = (import.meta as ImportMeta & {
  env?: {
    DEV?: boolean
    VITE_GLANCE_API_BASE?: string
    VITE_GLANCE_DEMO_FIXTURES?: string
  }
}).env

export const DEFAULT_API_BASE = 'https://remboai.duckdns.org/api/v1/glance'
export const API_BASE = (viteEnv?.VITE_GLANCE_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '')
export const DEMO_FIXTURES_ENABLED = viteEnv?.VITE_GLANCE_DEMO_FIXTURES === 'true'
export const DEVELOPMENT_BUILD = viteEnv?.DEV === true
