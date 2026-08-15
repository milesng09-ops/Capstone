/** Compact form controls for the settings panels. */

import { useId, useState, type ReactNode } from 'react'

import { cn } from '@/utils/cn'

/**
 * Parse a decimal the user typed, accepting either separator.
 *
 * `<input type="number">` renders and parses according to the *browser's*
 * locale, so on a machine set to a comma-decimal locale these fields showed
 * `0,02` while every readout, price axis and percentage on the same screen
 * showed a dot -- two conventions in one panel. A text input with explicit
 * parsing pins the display to a dot, matching the rest of the UI, while still
 * accepting a comma from anyone who types one out of habit.
 *
 * Returns null for anything not yet a number, so a half-typed `1.` or a lone
 * `-` never reaches a request body.
 */
function parseDecimal(raw: string): number | null {
  const trimmed = raw.trim().replace(',', '.')
  if (trimmed === '' || !/^-?\d*\.?\d*$/.test(trimmed)) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/** Decimal places implied by a step, so 0.02 + 0.01 does not become 0.030000000000000002. */
function decimalsOf(step: number): number {
  return (String(step).split('.')[1] ?? '').length
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string
  hint?: string
  children: ReactNode
  className?: string
}) {
  return (
    <label className={cn('flex flex-col gap-1', className)}>
      <span className="label-caps" title={hint}>
        {label}
      </span>
      {children}
    </label>
  )
}

const CONTROL_CLASS =
  'h-8 w-full rounded-md border border-input bg-[hsl(var(--panel-raised))] px-2 text-xs ' +
  'text-foreground outline-none transition-colors focus:border-primary/60 ' +
  'focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

export function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  disabled,
}: {
  label: string
  hint?: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
  disabled?: boolean
}) {
  // While the field is being edited the raw text is shown, so a partial entry
  // like "0." survives the next keystroke instead of being normalised away.
  const [draft, setDraft] = useState<string | null>(null)

  const display = draft ?? (Number.isFinite(value) ? String(value) : '')
  const parsed = draft == null ? value : parseDecimal(draft)
  const outOfRange =
    parsed != null && ((min != null && parsed < min) || (max != null && parsed > max))

  const nudge = (direction: 1 | -1) => {
    const base = parsed ?? value
    if (!Number.isFinite(base)) return
    const next = Number((base + direction * step).toFixed(decimalsOf(step)))
    setDraft(null)
    onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next)))
  }

  return (
    <Field label={label} hint={hint}>
      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          className={cn(
            CONTROL_CLASS,
            'numeric',
            suffix && 'pr-7',
            outOfRange && 'border-destructive focus:border-destructive',
          )}
          value={display}
          disabled={disabled}
          aria-invalid={outOfRange || undefined}
          onChange={(event) => {
            const raw = event.target.value
            setDraft(raw)
            // Only publish once the text is a complete number; keep the last
            // good value otherwise rather than pushing NaN into a request.
            const next = parseDecimal(raw)
            if (next != null) onChange(next)
          }}
          onBlur={() => setDraft(null)}
          onKeyDown={(event) => {
            // Arrow stepping is the part of type="number" worth keeping.
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            nudge(event.key === 'ArrowUp' ? 1 : -1)
          }}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-2xs text-muted-foreground">
            {suffix}
          </span>
        )}
      </div>
    </Field>
  )
}

export function SelectField<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  hint?: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <Field label={label} hint={hint}>
      <select
        className={cn(CONTROL_CLASS, 'cursor-pointer')}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  )
}

export function ToggleField({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <label
        htmlFor={id}
        className={cn(
          'cursor-pointer text-xs text-muted-foreground',
          disabled && 'cursor-not-allowed opacity-50',
        )}
        title={hint}
      >
        {label}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-4 w-7 shrink-0 rounded-full border transition-colors',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          checked ? 'border-primary/60 bg-primary/70' : 'border-border bg-secondary',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-2.5 w-2.5 rounded-full bg-foreground transition-transform',
            checked ? 'translate-x-3.5' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  )
}

/** Segmented control: a row of mutually exclusive choices. */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  className,
  size = 'sm',
}: {
  value: T
  options: readonly { value: T; label: string; title?: string }[]
  onChange: (value: T) => void
  className?: string
  size?: 'sm' | 'md'
}) {
  return (
    <div
      role="group"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md border border-border bg-[hsl(var(--panel-raised))] p-0.5',
        className,
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded font-medium transition-colors',
            size === 'sm' ? 'px-2 py-1 text-2xs' : 'px-2.5 py-1.5 text-xs',
            option.value === value
              ? 'bg-primary/20 text-foreground'
              : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
