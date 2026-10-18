import type { GxtEvidence, Trade } from '@/types/backtest'
import { useTimeZone } from '@/store/workspace'
import { formatDateTime, formatPrice } from '@/utils/format'

export function GxtTradeEvidence({ trade, evidence }: { trade: Trade; evidence?: GxtEvidence }) {
  useTimeZone()
  return (
    <div className="space-y-2 rounded border border-primary/30 bg-primary/5 p-2 text-2xs">
      <p className="font-semibold">GXT research · #{trade.trade_number} {trade.direction} {trade.symbol}</p>
      {evidence ? <>
        <p>4H profile closed {formatDateTime(evidence.context_end)}.
          {' '}Entry confirmed {formatDateTime(evidence.confirmed_at)}.</p>
        <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
          {evidence.steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
        <p>Swept level {formatPrice(evidence.swept_level)}; confirmation gap{' '}
          {formatPrice(evidence.gap_bottom)}–{formatPrice(evidence.gap_top)}.</p>
        <p>Entry {formatPrice(trade.entry_price)} · Stop {formatPrice(trade.stop_price)} · Target {formatPrice(trade.target_price)}</p>
        <p>New York entry time: {evidence.entry_session_ny}.</p>
        <p>Opposite candle bodies: {evidence.opposed_close_symbols.join(', ') || 'none'}.
          {' '}This observation alone is not a verified PSP or Strength Switch.</p>
      </> : <p>No saved sequence evidence is available for this trade.</p>}
      {trade.same_bar_ambiguity && <p>Stop and target touched in one candle; stop assumed first.</p>}
      {trade.exit_reason === 'end_of_data' && <p>Trade truncated at the end of available contiguous data.</p>}
    </div>
  )
}
