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

/** What a setting can hold. Mirrors the backend's own field constraints. */
interface Bounds {
  min?: number
  max?: number
  /** `min` itself is refused, as a stop or a target of zero is. */
  minExclusive?: boolean
  /** Whole numbers only: a bar count of 2.5 is a typo, not a setting. */
  integer?: boolean
}

/**
 * Whether a parsed number may be handed to the store.
 *
 * Asked *before* publishing, not merely to colour the field afterwards. A
 * value the backend refuses fails the whole run with "The configuration could
 * not be used as entered", naming no field -- and a fractional swing strength
 * failed the analysis request outright, which took every detection off the
 * chart without a word.
 */
function accepts(value: number, { min, max, minExclusive, integer }: Bounds): boolean {
  if (!Number.isFinite(value)) return false
  if (integer && !Number.isInteger(value)) return false
  if (min != null && (minExclusive ? value <= min : value < min)) return false
  if (max != null && value > max) return false
  return true
}

/** The rule a marked field broke, in words, for its tooltip. */
function describeBounds({ min, max, minExclusive, integer }: Bounds): string {
  const kind = integer ? 'A whole number' : 'A number'
  if (min != null && max != null) {
    return `${kind} ${minExclusive ? 'above' : 'from'} ${min} to ${max}`
  }
  if (min != null) return `${kind} ${minExclusive ? 'above' : 'of at least'} ${min}`
  if (max != null) return `${kind} of at most ${max}`
  return kind
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
  minExclusive,
  integer,
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
  /** Refuse `min` itself, for settings the backend wants strictly positive. */
  minExclusive?: boolean
  /** Whole numbers only, for every setting the backend types as an integer. */
  integer?: boolean
  step?: number
  suffix?: string
  disabled?: boolean
}) {
  // While the field is being edited the raw text is shown, so a partial entry
  // like "0." survives the next keystroke instead of being normalised away.
  const [draft, setDraft] = useState<string | null>(null)

  const bounds: Bounds = { min, max, minExclusive, integer }
  const display = draft ?? (Number.isFinite(value) ? String(value) : '')
  const parsed = draft == null ? value : parseDecimal(draft)
  // A complete number the setting cannot hold. Half-typed text -- "", "-",
  // "." on the way somewhere -- is not marked: it is not an answer yet.
  const invalid = parsed != null && !accepts(parsed, bounds)

  const nudge = (direction: 1 | -1) => {
    const base = parsed ?? value
    if (!Number.isFinite(base)) return
    // From a fraction in a whole-number field, step to the neighbouring whole
    // number rather than carrying the fraction along: 2.5 up is 3, not 3.5.
    const from = integer ? (direction > 0 ? Math.floor(base) : Math.ceil(base)) : base
    const stepped = Number((from + direction * step).toFixed(decimalsOf(step)))
    let next = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, stepped))
    // Clamped onto an exclusive floor, the nearest value it allows is a step
    // above it.
    if (minExclusive && min != null && next <= min) {
      next = Number((min + step).toFixed(decimalsOf(step)))
    }
    setDraft(null)
    if (accepts(next, bounds)) onChange(next)
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
            invalid && 'border-destructive focus:border-destructive',
          )}
          value={display}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          title={invalid ? describeBounds(bounds) : undefined}
          onChange={(event) => {
            const raw = event.target.value
            setDraft(raw)
            // Only publish a complete number the setting can hold. Anything
            // else stays on screen as typed, marked, while the last good value
            // stays in force -- and is what the field shows again on blur.
            const next = parseDecimal(raw)
            if (next != null && accepts(next, bounds)) onChange(next)
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

/**
 * Segmented control: a row of mutually exclusive choices.
 *
 * `boxed` is the settings-panel form -- a bordered well, so the group reads as
 * one control among other fields. `plain` is the toolbar form: bare text
 * buttons with no container, the way an interval strip is drawn in charting
 * software, where a dozen of these sit side by side and the boxes would be all
 * you could see.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  className,
  size = 'sm',
  variant = 'boxed',
}: {
  value: T
  options: readonly { value: T; label: string; title?: string; disabled?: boolean }[]
  onChange: (value: T) => void
  className?: string
  size?: 'sm' | 'md'
  variant?: 'boxed' | 'plain'
}) {
  const plain = variant === 'plain'
  return (
    <div
      role="group"
      className={cn(
        'inline-flex items-center',
        plain
          ? 'gap-px'
          : 'gap-0.5 rounded-md border border-border bg-[hsl(var(--panel-raised))] p-0.5',
        className,
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          // The reason an option is out of reach lives in `title`, which a
          // keyboard or screen-reader user never sees. Naming the button with
          // it puts the explanation on the same footing as the tooltip.
          aria-label={option.disabled && option.title ? option.title : undefined}
          aria-pressed={option.value === value}
          // An option that cannot be chosen keeps its place in the row and
          // says why on hover, rather than disappearing and leaving a control
          // whose length changes underneath the pointer.
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded font-medium transition-colors',
            size === 'sm' ? 'px-2 py-1 text-2xs' : 'px-2.5 py-1.5 text-xs',
            option.value === value
              ? plain
                ? 'bg-secondary text-foreground'
                : 'bg-primary/20 text-foreground'
              : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            option.disabled &&
              'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
