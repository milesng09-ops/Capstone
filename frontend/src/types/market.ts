/** Canonical market-data types. Mirrors the backend Pydantic models. */

/** The only symbols this workspace supports. */
export const SYMBOLS = ['ES', 'NQ', 'YM'] as const
export type SymbolKey = (typeof SYMBOLS)[number]

/**
 * Every interval the workspace can chart, finest first.
 *
 * The month is `1mo`, not `1M`: interval keys travel through query strings,
 * `localStorage` and a SQLite column, and `1M` differing from `1m` only in
 * case is a bug waiting for a collation somewhere along that path. The label
 * below is free to say `1M`; the wire never does.
 */
export const INTERVALS = [
  '1m',
  '2m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '90m',
  '4h',
  '6h',
  '1d',
  '1w',
  '1mo',
] as const
export type Interval = (typeof INTERVALS)[number]

export const INTERVAL_LABELS: Record<Interval, string> = {
  '1m': '1m',
  '2m': '2m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1H',
  '90m': '90m',
  '4h': '4H',
  '6h': '6H',
  '1d': '1D',
  '1w': '1W',
  '1mo': '1M',
}

/**
 * The intervals shown inline in the top bar until the trader changes them.
 *
 * Thirteen buttons do not fit a toolbar, and a list that long is slower to
 * read than it is to open a menu. These five are the ones the workspace
 * shipped with; anything can be pinned beside them.
 */
export const DEFAULT_FAVOURITE_INTERVALS: Interval[] = ['5m', '15m', '1h', '4h', '1d']

/** How the full list is grouped in the picker. */
export const INTERVAL_GROUPS: { label: string; intervals: Interval[] }[] = [
  { label: 'Minutes', intervals: ['1m', '2m', '3m', '5m', '15m', '30m'] },
  { label: 'Hours', intervals: ['1h', '90m', '4h', '6h'] },
  { label: 'Days', intervals: ['1d', '1w', '1mo'] },
]

/**
 * Milliseconds per interval. Used for range maths on the client.
 *
 * `1mo` is nominal -- months are not all the same length, and the backend
 * places monthly buckets from the calendar rather than from this number. It
 * is here for estimating how many bars a window holds and nothing else.
 */
export const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60_000,
  '2m': 2 * 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '90m': 90 * 60_000,
  '4h': 4 * 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
  '1mo': 30 * 24 * 60 * 60_000,
}

/**
 * The longest history each interval can be asked for in one request.
 *
 * The backend refuses a window holding more than 20,000 bars, counted against
 * the trading calendar -- roughly 115 open hours in every 168. These are the
 * presets that fit under that, with headroom for where in the week a window
 * happens to start. Offering more than this is offering a button that returns
 * an error: during the 2026-09-05 review, 90 days of 5-minute bars was
 * selected, failed, and cost twenty minutes of working out why.
 *
 * The cap is a property of the interval the backend *stores*, not the one on
 * screen: 4h, 6h, 1d, 1w and 1mo are all built from the same hourly series,
 * so they share its limit -- which is also why a monthly chart reaches about
 * two years rather than ten. One- to three-minute bars are stored as minutes
 * and run out far sooner; 1m is held to a week because that is all Yahoo
 * keeps, and a silently truncated week looks like missing market rather than
 * a vendor limit.
 *
 * Keep in step with `max_bars_per_request` in the backend settings.
 */
export const MAX_RANGE_DAYS: Record<Interval, number> = {
  '1m': 7,
  '2m': 14,
  '3m': 14,
  '5m': 90,
  '15m': 180,
  '30m': 180,
  '1h': 730,
  '90m': 180,
  '4h': 730,
  '6h': 730,
  '1d': 730,
  '1w': 730,
  '1mo': 730,
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

/**
 * `partial` means a provider fetch for part of the window failed, so the bars
 * on screen are whatever the cache already held. `unknown` is the pre-response
 * state -- the UI must not claim a provenance it has not been told yet.
 */
export type DataQuality = 'live' | 'delayed' | 'cached' | 'demo' | 'partial' | 'unknown'
export type ProviderName = 'massive' | 'yahoo' | 'demo' | 'auto'

export const PROVIDER_LABELS: Record<string, string> = {
  massive: 'Massive',
  yahoo: 'Yahoo Finance',
  // Reachable only via DATA_PROVIDER=demo. It is no longer an automatic
  // fallback, so seeing this label means someone asked for it by name.
  demo: 'Demo Data',
  auto: 'Automatic',
}

export const QUALITY_LABELS: Record<DataQuality, string> = {
  live: 'Live provider',
  delayed: 'Delayed data',
  cached: 'Cached data',
  demo: 'Demo mode',
  partial: 'Incomplete data',
  unknown: 'Loading...',
}

/** Qualities that mean "do not trust a win rate computed on this". */
export const UNRELIABLE_QUALITIES: ReadonlySet<DataQuality> = new Set<DataQuality>([
  'demo',
  'partial',
])

export interface BarsResponse {
  symbol: string
  interval: Interval
  provider: string
  cached: boolean
  fallback_active: boolean
  fallback_reason: string | null
  quality: DataQuality
  /**
   * True when a provider quota, not an outage, is why part of this window is
   * missing. Structured rather than folded into `fallback_reason`, because
   * the UI acts on it -- it counts down and refetches -- and inferring that
   * intent from an English sentence is not something a component should do.
   */
  rate_limited: boolean
  retry_after_seconds: number | null
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
  /** True while this provider is cooling off from a quota rejection. */
  rate_limited: boolean
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

/**
 * A span of market time, in Unix milliseconds.
 *
 * Used for the backtest window: the stretch of history the engine is allowed
 * to look in. Bars outside it stay on the chart and stay untouched -- they
 * are simply not searched.
 */
export interface TimeWindow {
  start_time: number
  end_time: number
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


/**
 * How the chart itself looks, as opposed to what is on it.
 *
 * Traders read charts they have set up to their own eye -- Miles works on a
 * white background with no grid and black-and-white candles -- and a chart
 * that cannot be adjusted is one they have to translate in their head on
 * every glance. None of this touches the data; it is the frame around it.
 *
 * `null` on a colour means "follow the theme", which is not the same as a
 * colour that happens to match it today: the theme colour tracks light and
 * dark, a stored one does not.
 */
export interface ChartSettings {
  showGrid: boolean
  showVolume: boolean
  bullColor: string | null
  bearColor: string | null
}

export const DEFAULT_CHART_SETTINGS: ChartSettings = {
  showGrid: true,
  showVolume: true,
  bullColor: null,
  bearColor: null,
}

/** Candle colour choices offered, beyond following the theme. */
export const CANDLE_COLORS = [
  '#22c55e',
  '#ef4444',
  '#e2e8f0',
  '#0f172a',
  '#3b82f6',
  '#f59e0b',
] as const
