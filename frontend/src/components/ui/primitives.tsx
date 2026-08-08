/** Small styled building blocks shared across the workspace. */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

import { cn } from '@/utils/cn'

// --------------------------------------------------------------------------
// Button
// --------------------------------------------------------------------------
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'toolbar'
type ButtonSize = 'sm' | 'md' | 'icon'

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-primary/40',
  secondary:
    'bg-secondary text-secondary-foreground hover:bg-secondary/80 border border-border',
  ghost: 'text-muted-foreground hover:bg-secondary hover:text-foreground',
  danger: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  toolbar:
    'border border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground data-[active=true]:border-primary/60 data-[active=true]:bg-primary/15 data-[active=true]:text-foreground',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-2xs',
  md: 'h-9 px-3.5 text-sm',
  icon: 'h-8 w-8',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium',
        'transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  )
})

// --------------------------------------------------------------------------
// Panel
// --------------------------------------------------------------------------
interface PanelProps {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}

export function Panel({ title, actions, children, className, bodyClassName }: PanelProps) {
  return (
    <section className={cn('panel flex flex-col rounded-lg', className)}>
      {(title || actions) && (
        <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
          <h2 className="label-caps truncate">{title}</h2>
          {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </header>
      )}
      <div className={cn('min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  )
}

// --------------------------------------------------------------------------
// Badge
// --------------------------------------------------------------------------
type BadgeTone = 'neutral' | 'bull' | 'bear' | 'accent' | 'warn'

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-secondary text-muted-foreground border-border',
  bull: 'bg-bull/15 text-bull border-bull/30',
  bear: 'bg-bear/15 text-bear border-bear/30',
  accent: 'bg-primary/15 text-primary border-primary/30',
  warn: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
}

export function Badge({
  children,
  tone = 'neutral',
  className,
  title,
}: {
  children: ReactNode
  tone?: BadgeTone
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-2xs font-medium',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

// --------------------------------------------------------------------------
// Feedback
// --------------------------------------------------------------------------
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent',
        className,
      )}
    />
  )
}

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-2 p-6 text-center',
        className,
      )}
    >
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && (
        <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {action}
    </div>
  )
}

export function ErrorState({
  message,
  onRetry,
  className,
}: {
  message: string
  onRetry?: () => void
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-3 p-6 text-center',
        className,
      )}
    >
      <p className="max-w-sm text-xs leading-relaxed text-bear">{message}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

/** A labelled number, the workhorse of the results panel. */
export function Metric({
  label,
  value,
  hint,
  tone,
  className,
}: {
  label: string
  value: ReactNode
  hint?: string
  tone?: string
  className?: string
}) {
  return (
    <div className={cn('rounded-md border border-border bg-[hsl(var(--panel-raised))] p-2.5', className)}>
      <p className="label-caps truncate" title={hint ?? label}>
        {label}
      </p>
      <p className={cn('numeric mt-1 text-base font-semibold leading-none', tone)}>{value}</p>
    </div>
  )
}
