/**
 * Every simulated trade, in order.
 *
 * This is also the table view that keeps the panel readable without colour:
 * each row states its outcome in words and carries a signed number, so the
 * green/red tint is reinforcement rather than the only signal.
 */

import { Badge } from '@/components/ui/primitives'
import { EXIT_REASON_LABELS, type Trade } from '@/types/backtest'
import { cn } from '@/utils/cn'
import { directionClass, formatDateTime, formatPercent, formatPrice } from '@/utils/format'

export function TradesTable({ trades }: { trades: Trade[] }) {
  if (trades.length === 0) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-2xs text-muted-foreground">
        No trades were executed. Every match was skipped, or none passed the similarity
        threshold.
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-2xs">
        <thead className="sticky top-0 z-10 bg-[hsl(var(--panel))]">
          <tr className="border-b border-border text-left">
            <Th className="w-8">#</Th>
            <Th>Symbol</Th>
            <Th>Entry</Th>
            <Th className="text-right">Entry px</Th>
            <Th className="text-right">Exit px</Th>
            <Th>Outcome</Th>
            <Th className="text-right">Net</Th>
            <Th className="text-right">Bars</Th>
            <Th className="text-right">Match</Th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade) => {
            const outcome =
              trade.net_return > 0 ? 'Win' : trade.net_return < 0 ? 'Loss' : 'Flat'
            return (
              <tr
                key={trade.id}
                className="border-b border-border/50 transition-colors hover:bg-secondary/50"
              >
                <Td className="numeric text-muted-foreground">{trade.trade_number}</Td>
                <Td>
                  <span className="font-medium">{trade.symbol}</span>
                  <span className="ml-1 text-muted-foreground">
                    {trade.direction === 'long' ? 'L' : 'S'}
                  </span>
                </Td>
                <Td className="numeric whitespace-nowrap text-muted-foreground">
                  {formatDateTime(trade.entry_time)}
                </Td>
                <Td className="numeric text-right">{formatPrice(trade.entry_price)}</Td>
                <Td className="numeric text-right">{formatPrice(trade.exit_price)}</Td>
                <Td>
                  <div className="flex items-center gap-1">
                    {/* The word is the signal; the colour only reinforces it. */}
                    <span className={cn('font-medium', directionClass(trade.net_return))}>
                      {outcome}
                    </span>
                    <span className="text-muted-foreground">
                      {EXIT_REASON_LABELS[trade.exit_reason] ?? trade.exit_reason}
                    </span>
                    {trade.same_bar_ambiguity && (
                      <Badge
                        tone="warn"
                        title="One candle touched both the stop and the target. The stop was assumed to trigger first."
                      >
                        !
                      </Badge>
                    )}
                  </div>
                </Td>
                <Td className={cn('numeric text-right', directionClass(trade.net_return))}>
                  {formatPercent(trade.net_return)}
                </Td>
                <Td className="numeric text-right text-muted-foreground">
                  {trade.holding_bars}
                </Td>
                <Td className="numeric text-right text-muted-foreground">
                  {trade.similarity_score.toFixed(3)}
                </Td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'whitespace-nowrap px-2 py-1.5 font-medium uppercase tracking-wider text-muted-foreground',
        className,
      )}
    >
      {children}
    </th>
  )
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn('px-2 py-1.5', className)}>{children}</td>
}
