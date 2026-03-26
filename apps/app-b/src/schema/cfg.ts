import type { AthUiSchema, Condition, ItemSpec, ValueType } from './types'
import type { HornPart, HornPartProfile } from '../components/HornPartsEditor'

const SIMPLE_RECT_THROAT_KEY = '_athui.Designer.ThroatShape'
const SIMPLE_RECT_COVERAGE_H_KEY = '_athui.Designer.CoverageH'
const SIMPLE_RECT_COVERAGE_V_KEY = '_athui.Designer.CoverageV'
const SIMPLE_RECT_ADAPTER_ZMAP = '0.5,0.4,0.5,0.5'
const SIMPLE_RECT_PART_ZMAP = '0.5,0.3,0.5,0.9'

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
    // Ath 4.8.2 bundled with this repo errors on ABEC.SimProfile=-1 (even though docs mention -1 disables).
    // Treat -1 as "unset" to keep Advanced mode runs working by default.
    if (spec.key === 'ABEC.SimProfile' && Math.trunc(n) === -1) return null
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
    // Avoid emitting a legacy default that triggers warnings in the bundled ath.exe.
    if (spec.key === 'ABEC.Polars:SPL' && trimmed === '{ MapAngleRange = 0,90,19 Offset = 95 }') return null
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

function buildSimpleRectThroatLines(values: Record<string, unknown>): { lines: string[]; keysToSkip: Set<string> } {
  const keysToSkip = new Set<string>()
  const lines: string[] = []

  if (values[SIMPLE_RECT_THROAT_KEY] !== 'rect') return { lines, keysToSkip }

  function asExpr(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (typeof value === 'string') {
      const s = value.trim()
      return s.length ? s : null
    }
    return null
  }

  for (const key of [
    'HornGeometry',
    'Horn.Adapter.Width',
    'Horn.Adapter.Height',
    'Horn.Adapter.Length',
    'Horn.Adapter.k',
    'Horn.Adapter.Segments',
    'Throat.Profile',
    'Throat.Diameter',
    'Throat.Angle',
    'Coverage.Angle',
    'OS.k',
    'Term.s',
    'Term.q',
    'Term.n',
  ]) {
    keysToSkip.add(key)
  }

  let width = asNumber(values['Horn.Adapter.Width']) ?? 28
  let height = asNumber(values['Horn.Adapter.Height']) ?? 121.5
  const throatDiameter = asExpr(values['Throat.Diameter']) ?? '25.4'
  const throatAngle = asExpr(values['Throat.Angle']) ?? '7'
  const coverageH = Math.min(160, Math.max(20, asNumber(values[SIMPLE_RECT_COVERAGE_H_KEY]) ?? 90))
  const coverageV = Math.min(160, Math.max(20, asNumber(values[SIMPLE_RECT_COVERAGE_V_KEY]) ?? 60))
  const partSegments = Math.max(16, Math.round(asNumber(values['Mesh.LengthSegments']) ?? 16))
  const osK = asExpr(values['OS.k']) ?? '1'
  const termS = asExpr(values['Term.s']) ?? '0.5'
  const termQ = asExpr(values['Term.q']) ?? '0.996'
  const termN = asExpr(values['Term.n']) ?? '4'

  if (!Number.isFinite(width) || width <= 0) width = 28
  if (!Number.isFinite(height) || height <= 0) height = 121.5

  lines.push('HornGeometry = 2')
  lines.push(`Throat.Diameter = ${throatDiameter}`)
  lines.push(`Throat.Angle = ${throatAngle}`)
  lines.push('Horn.Adapter = {')
  lines.push('  L = 0')
  lines.push('  k = 0')
  lines.push(`  Width = ${width}`)
  lines.push(`  Height = ${height}`)
  lines.push('  SC = 0')
  lines.push('  Segments = 0')
  lines.push(`  ZMap = ${SIMPLE_RECT_ADAPTER_ZMAP}`)
  lines.push('}')
  lines.push('Horn.Part:1 = {')
  lines.push('  L = 1')
  lines.push(`  Segments = ${partSegments}`)
  lines.push('  H = {')
  lines.push(`    r0 = ${width / 2}`)
  lines.push(`    a0 = ${throatAngle}`)
  lines.push(`    k = ${osK}`)
  lines.push(`    s = ${termS}`)
  lines.push(`    a = ${coverageH / 2}`)
  lines.push(`    n = ${termN}`)
  lines.push(`    q = ${termQ}`)
  lines.push('  }')
  lines.push('  V = {')
  lines.push(`    r0 = ${height / 2}`)
  lines.push(`    a0 = ${throatAngle}`)
  lines.push(`    k = ${osK}`)
  lines.push(`    s = ${termS}`)
  lines.push(`    a = ${coverageV / 2}`)
  lines.push(`    n = ${termN}`)
  lines.push(`    q = ${termQ}`)
  lines.push('  }')
  lines.push(`  ZMap = ${SIMPLE_RECT_PART_ZMAP}`)
  lines.push('}')

  return { lines, keysToSkip }
}

function buildHornGeometry2Lines(values: Record<string, unknown>): { lines: string[]; keysToSkip: Set<string> } {
  const simpleRect = buildSimpleRectThroatLines(values)
  if (simpleRect.lines.length > 0) return simpleRect

  const keysToSkip = new Set<string>()
  const lines: string[] = []

  const hornGeometry = values['HornGeometry']
  if (hornGeometry !== 2) return { lines, keysToSkip }

  // Emit HornGeometry
  lines.push('HornGeometry = 2')
  keysToSkip.add('HornGeometry')

  function asNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim().length) {
      const n = Number(value)
      return Number.isFinite(n) ? n : null
    }
    return null
  }

  function asExpr(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (typeof value === 'string') {
      const s = value.trim()
      return s.length ? s : null
    }
    return null
  }

  // Ath V2025-06 requires multi-line object blocks for `Horn.Adapter` and expects:
  // { Length, Throat.Angle, Width, Height, k, NC }.
  const adapterWidthKey = 'Horn.Adapter.Width'
  const adapterHeightKey = 'Horn.Adapter.Height'
  const adapterKKey = 'Horn.Adapter.k'
  const adapterSegmentsKey = 'Horn.Adapter.Segments'
  const adapterLengthKey = 'Horn.Adapter.Length'

  for (const k of [adapterWidthKey, adapterHeightKey, adapterKKey, adapterSegmentsKey, adapterLengthKey]) keysToSkip.add(k)

  const widthDefault = 28
  const heightDefault = 121.5
  const lengthDefault = 0

  let width = asNumber(values[adapterWidthKey]) ?? widthDefault
  let height = asNumber(values[adapterHeightKey]) ?? heightDefault
  const k = asNumber(values[adapterKKey]) ?? 0
  const nc = Math.max(0, Math.round(asNumber(values[adapterSegmentsKey]) ?? 0))
  const length = Math.max(0, asNumber(values[adapterLengthKey]) ?? lengthDefault)

  if (!Number.isFinite(width) || width <= 0) width = widthDefault
  if (!Number.isFinite(height) || height <= 0) height = heightDefault

  const throatAngleExpr = asExpr(values['Throat.Angle']) ?? '0'

  lines.push('Horn.Adapter = {')
  lines.push(`  Length = ${length}`)
  lines.push(`  Throat.Angle = ${throatAngleExpr}`)
  lines.push(`  Width = ${width}`)
  lines.push(`  Height = ${height}`)
  lines.push(`  k = ${k}`)
  lines.push(`  NC = ${nc}`)
  lines.push('}')

  // Emit Horn.Part:N blocks from _athui.HornParts array.
  const defaultProfile: HornPartProfile = { Profile: 'OS-SE', k: 0.5, s: 0.5, n: 4, q: 0.95, a: 0.3, Length: 50 }
  const defaultParts: HornPart[] = [{ H: { ...defaultProfile }, V: { ...defaultProfile } }]
  const rawParts = values['_athui.HornParts'] as HornPart[] | undefined
  const parts = Array.isArray(rawParts) && rawParts.length > 0 ? rawParts : defaultParts

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part) continue
    const partNum = i + 1

    const h = part.H
    const v = part.V
    const l = Math.max(0, asNumber(h.Length) ?? asNumber(v.Length) ?? 50)
    const hVec = `[${h.k},${h.a},${h.s},${h.q}]`
    const vVec = `[${v.k},${v.a},${v.s},${v.q}]`

    lines.push(`Horn.Part:${partNum} = {`)
    lines.push(`  Segments = 0`)
    lines.push(`  Inclination = 0`)
    lines.push(`  L = ${l}`)
    lines.push(`  H = ${hVec}`)
    lines.push(`  V = ${vVec}`)
    lines.push(`}`)
  }

  return { lines, keysToSkip }
}

function buildHornAdapterLines(values: Record<string, unknown>): { lines: string[]; keysToSkip: Set<string> } {
  const keysToSkip = new Set<string>()
  const lines: string[] = []
  return { lines, keysToSkip }
}

function shouldAlwaysEmitAdvanced(spec: ItemSpec, values: Record<string, unknown>, formatted: string): boolean {
  if (formatted === null) return false

  switch (spec.key) {
    case 'GCurve.Dist':
    case 'GCurve.Width':
    case 'GCurve.AspectRatio':
    case 'GCurve.SE.n':
    case 'GCurve.SF':
    case 'GCurve.Rot':
      return isDefined(values['GCurve.Type'])
    case 'Morph.FixedPart':
    case 'Morph.Rate':
    case 'Morph.AllowShrinkage':
      return asNumber(values['Morph.TargetShape']) !== null && asNumber(values['Morph.TargetShape']) !== 0
    default:
      return false
  }
}

export function buildProjectCfgText(
  schema: AthUiSchema,
  values: Record<string, unknown>,
  opts: { includeAdvanced: boolean },
): { text: string; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  const emitted = new Set<string>()
  let adapterLinesInserted = false

  // Handle HornGeometry=2 special serialization
  const { lines: hornLines, keysToSkip } = buildHornGeometry2Lines(values)
  const { lines: adapterLines, keysToSkip: adapterKeysToSkip } = buildHornAdapterLines(values)
  for (const key of adapterKeysToSkip) keysToSkip.add(key)

  function emitItem(spec: ItemSpec) {
    if (spec.key.startsWith('_athui.')) return
    if (!isItemVisible(spec, values)) return
    if (keysToSkip.has(spec.key)) return

    const required = isItemRequired(spec, values)
    const formatted = formatCfgValue(spec, values[spec.key])

    if (required && formatted === null) errors.push(`${spec.label} (${spec.key}) is required`)
    if (formatted === null) return

    // Quick Setup should still serialize advanced keys when the user (or the UI) changes them away from defaults.
    // This keeps Quick Setup runs simple, while still allowing composed/derived flows (e.g. the horn designer).
    if (!opts.includeAdvanced && spec.ui.advanced) {
      if (shouldAlwaysEmitAdvanced(spec, values, formatted)) {
        // Keep guide/morph helper fields when the governing feature is enabled.
      } else {
      const defaultFormatted = spec.default !== undefined ? formatCfgValue(spec, spec.default) : null
      if (defaultFormatted === formatted) return
      }
    }

    if (emitted.has(spec.key)) return
    emitted.add(spec.key)
    lines.push(`${spec.key} = ${maybeWrap(spec, formatted)}`)
  }

  for (const section of schema.sections) {
    for (const group of section.groups) {
      const groupStart = lines.length
      const isAdapterGroup = adapterLines.length > 0 && group.items.some((key) => adapterKeysToSkip.has(key))
      if (isAdapterGroup && !adapterLinesInserted) {
        lines.push(...adapterLines)
        adapterLinesInserted = true
      }
      for (const key of group.items) {
        const spec = schema.items[key]
        if (!spec) continue
        emitItem(spec)
      }
      const groupEmitted = lines.length > groupStart
      if (groupEmitted) lines.push('')
    }
  }

  // Prepend HornGeometry=2 lines if present.
  if (hornLines.length > 0) {
    lines.unshift(...hornLines, '')
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const text = lines.join('\n') + '\n'
  return { text, errors }
}
