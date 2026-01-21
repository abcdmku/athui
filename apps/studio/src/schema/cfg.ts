import type { AthUiSchema, Condition, ItemSpec, ValueType } from './types'

function isDefined(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function evalCondition(condition: Condition, values: Record<string, unknown>): boolean {
  const v = values[condition.key]
  switch (condition.op) {
    case 'eq':
      return v === condition.value
    case 'neq':
      return v !== condition.value
    case 'in':
      return Array.isArray(condition.value) && condition.value.includes(v as never)
    case 'truthy':
      return Boolean(v)
    case 'falsy':
      return !v
    case 'defined':
      return isDefined(v)
    case 'undefined':
      return !isDefined(v)
    case 'gt': {
      const a = asNumber(v)
      const b = asNumber(condition.value)
      return a !== null && b !== null && a > b
    }
    case 'gte': {
      const a = asNumber(v)
      const b = asNumber(condition.value)
      return a !== null && b !== null && a >= b
    }
    case 'lt': {
      const a = asNumber(v)
      const b = asNumber(condition.value)
      return a !== null && b !== null && a < b
    }
    case 'lte': {
      const a = asNumber(v)
      const b = asNumber(condition.value)
      return a !== null && b !== null && a <= b
    }
    default: {
      const _exhaustive: never = condition.op
      return Boolean(_exhaustive)
    }
  }
}

export function areConditionsMet(conditions: Condition[] | undefined, values: Record<string, unknown>): boolean {
  if (!conditions || conditions.length === 0) return true
  return conditions.every((c) => evalCondition(c, values))
}

export function isItemVisible(spec: ItemSpec, values: Record<string, unknown>): boolean {
  return areConditionsMet(spec.visibleWhen, values)
}

export function isItemRequired(spec: ItemSpec, values: Record<string, unknown>): boolean {
  if (spec.required) return true
  if (!spec.requiredWhen || spec.requiredWhen.length === 0) return false
  return areConditionsMet(spec.requiredWhen, values)
}

function quoteString(value: string): string {
  if (!/[\s"]/g.test(value)) return value
  return `"${value.replaceAll('"', '\\"')}"`
}

function formatNumberList(value: unknown, valueType: ValueType): string | null {
  if (value === undefined) return null
  if (value === null) return '' // explicit empty assignment: `Key =`
  if (Array.isArray(value)) {
    if (value.length === 0) return ''
    const numbers = value
      .map((v) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN))
      .filter((n) => Number.isFinite(n))
    if (numbers.length === 0) return ''
    if (valueType === 'i[]') return numbers.map((n) => String(Math.trunc(n))).join(', ')
    return numbers.map((n) => String(n)).join(', ')
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    if (trimmed === '[]') return ''
    return trimmed
  }
  return null
}

function formatCfgValue(spec: ItemSpec, raw: unknown): string | null {
  const valueType = spec.valueType

  if (raw === undefined) return null

  if (valueType === 'b') {
    if (raw === null) return null
    return Boolean(raw) ? '1' : '0'
  }

  if (valueType === 'i') {
    if (raw === null || raw === '') return null
    const n = asNumber(raw)
    if (n === null) return typeof raw === 'string' ? raw.trim() : null
    return String(Math.trunc(n))
  }

  if (valueType === 'f') {
    if (raw === null || raw === '') return null
    const n = asNumber(raw)
    if (n === null) return typeof raw === 'string' ? raw.trim() : null
    return String(n)
  }

  if (valueType === 'ex') {
    if (raw === null) return null
    if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : null
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      return trimmed.length ? trimmed : null
    }
    return null
  }

  if (valueType === 's') {
    if (raw === null) return null
    if (typeof raw !== 'string') return null
    const trimmed = raw.trim()
    return trimmed.length ? quoteString(trimmed) : null
  }

  if (valueType === 'i[]' || valueType === 'f[]') return formatNumberList(raw, valueType)

  if (valueType === 'c' || valueType === '{}') {
    if (raw === null) return null
    if (typeof raw !== 'string') return null
    const trimmed = raw.trim()
    return trimmed.length ? trimmed : null
  }

  return null
}

function maybeWrap(spec: ItemSpec, formatted: string): string {
  const wrap = spec.cfg?.wrap
  if (!wrap) return formatted
  const trimmed = formatted.trimStart()
  if (trimmed.toLowerCase().startsWith(wrap.prefix.toLowerCase())) return formatted
  return `${wrap.prefix}${formatted}${wrap.suffix}`
}

export function buildProjectCfgText(
  schema: AthUiSchema,
  values: Record<string, unknown>,
  opts: { includeAdvanced: boolean },
): { text: string; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  const emitted = new Set<string>()

  function emitItem(spec: ItemSpec) {
    if (spec.key.startsWith('_athui.')) return
    if (!opts.includeAdvanced && spec.ui.advanced) return
    if (!isItemVisible(spec, values)) return

    const required = isItemRequired(spec, values)
    const formatted = formatCfgValue(spec, values[spec.key])

    if (required && formatted === null) errors.push(`${spec.label} (${spec.key}) is required`)
    if (formatted === null) return

    if (emitted.has(spec.key)) return
    emitted.add(spec.key)
    lines.push(`${spec.key} = ${maybeWrap(spec, formatted)}`)
  }

  for (const section of schema.sections) {
    for (const group of section.groups) {
      for (const key of group.items) {
        const spec = schema.items[key]
        if (!spec) continue
        emitItem(spec)
      }
    }
  }

  const text = lines.join('\n') + '\n'
  return { text, errors }
}
