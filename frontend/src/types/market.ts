/** Canonical market-data types. Mirrors the backend Pydantic models. */

/** The only symbols this workspace supports. */
export const SYMBOLS = ['ES', 'NQ', 'YM'] as const
export type SymbolKey = (typeof SYMBOLS)[number]

export const INTERVALS = ['5m', '15m', '1h', '4h', '6h', '1d'] as const
export type Interval = (typeof INTERVALS)[number]

export const INTERVAL_LABELS: Record<Interval, string> = {
  '5m': '5m',
  '15m': '15m',
  '1h': '1H',
  '4h': '4H',
  '6h': '6H',
  '1d': '1D',
}

/** Milliseconds per interval. Used for range maths on the client. */
export const INTERVAL_MS: Record<Interval, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
}

export interface Instrument {
  symbol: string
  display_name: string
  exchange: string
  currency: string
  asset_type: string
  timezone: string
  price_precision: number
  tick_size: number
  contract_note: string
}

/** One OHLCV bar. `time` is always Unix **milliseconds** on the client. */
export interface Candle {
  symbol: string
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type DataQuality = 'live' | 'delayed' | 'cached' | 'demo'
export type ProviderName = 'massive' | 'yahoo' | 'demo' | 'auto'

export const PROVIDER_LABELS: Record<string, string> = {
  massive: 'Massive',
  yahoo: 'Yahoo Finance',
  demo: 'Demo Data',
  auto: 'Automatic',
}

export const QUALITY_LABELS: Record<DataQuality, string> = {
  live: 'Live provider',
  delayed: 'Delayed data',
  cached: 'Cached data',
  demo: 'Demo mode',
}

export interface BarsResponse {
  symbol: string
  interval: Interval
  provider: string
  cached: boolean
  fallback_active: boolean
  fallback_reason: string | null
  quality: DataQuality
  bars: Candle[]
}

export interface ProviderStatus {
  name: string
  display_name: string
  configured: boolean
  available: boolean
  healthy: boolean
  last_error: string | null
  last_checked_ms: number | null
  cooldown_until_ms: number | null
  notes: string | null
}

export interface FallbackEvent {
  timestamp_ms: number
  from_provider: string
  to_provider: string
  reason: string
}

export interface ProviderStatusResponse {
  active_provider: string
  requested_provider: string
  fallback_active: boolean
  fallback_reason: string | null
  massive_api_key_configured: boolean
  providers: ProviderStatus[]
  fallback_history: FallbackEvent[]
}

export interface HealthResponse {
  status: string
  provider: string
  fallback_active: boolean
  database: string
  version: string
  environment: string
}

export interface CacheSymbolStat {
  symbol: string
  interval: string
  candles: number
  first_time: number | null
  last_time: number | null
  provider: string | null
}

export interface CacheStatsResponse {
  total_candles: number
  per_symbol: CacheSymbolStat[]
  database_path: string
  last_fetch_ms: number | null
}

/** A user-drawn period, stored in market coordinates -- never in pixels. */
export interface SelectionRange {
  symbol: string
  start_time: number
  end_time: number
  source_interval: Interval
}

export interface SelectionSummary {
  symbol: string
  startTime: number
  endTime: number
  candleCount: number
  priceChange: number
  priceChangePercent: number
  highest: number
  lowest: number
  volatility: number
}
