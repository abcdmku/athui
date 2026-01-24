type HornPartProfile = {
  Profile: string
  k: number
  s: number
  n: number
  q: number
  a: number
  Length: number
}

type HornPart = {
  H: HornPartProfile
  V: HornPartProfile
}

function quoteString(value: string): string {
  const needsQuotes = /[\s"]/g.test(value)
  if (!needsQuotes) return value
  return `"${value.replaceAll('"', '\\"')}"`
}

function formatValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed.length) return null

    // Heuristics: Ath uses unquoted expressions and `{ ... }` objects frequently.
    // Only quote when it looks like a path/command and quoting is actually needed.
    const looksLikeObject = /[{}=]/.test(trimmed) || trimmed.includes('\n')
    if (looksLikeObject) return trimmed

    const hasWhitespace = /\s/.test(trimmed)
    const looksLikePathOrCmd =
      /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.includes('\\') || trimmed.includes('/') || trimmed.includes('%')

    if (hasWhitespace && !looksLikePathOrCmd) return trimmed
    return quoteString(trimmed)
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '' // explicit empty assignment: `Key =`
    const parts = value
      .map((v) => (typeof v === 'number' || typeof v === 'string' ? String(v).trim() : ''))
      .filter(Boolean)
    return parts.length ? parts.join(', ') : null
  }
  return null
}

function buildHornGeometry2Lines(flatConfig: Record<string, unknown>): { lines: string[]; keysToSkip: Set<string> } {
  const keysToSkip = new Set<string>()
  const lines: string[] = []

  const hornGeometry = flatConfig['HornGeometry']
  if (hornGeometry !== 2) return { lines, keysToSkip }

  function numberFromUnknown(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'string') {
      const s = value.trim()
      if (!s.length) return null
      const parsed = Number(s)
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }

  function exprFromUnknown(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (typeof value === 'string') {
      const s = value.trim()
      return s.length ? s : null
    }
    return null
  }

  // Emit HornGeometry
  lines.push('HornGeometry = 2')
  keysToSkip.add('HornGeometry')

  // Ath V2025-06 requires multi-line object blocks for `Horn.Adapter` and expects:
  // { Length, Throat.Angle, Width, Height, k, NC }.
  //
  // UI uses `Horn.Adapter.*` fields; map them into the expected object keys.
  const adapterWidthKey = 'Horn.Adapter.Width'
  const adapterHeightKey = 'Horn.Adapter.Height'
  const adapterKKey = 'Horn.Adapter.k'
  const adapterSegmentsKey = 'Horn.Adapter.Segments'
  const adapterLengthKey = 'Horn.Adapter.Length'

  for (const k of [adapterWidthKey, adapterHeightKey, adapterKKey, adapterSegmentsKey, adapterLengthKey]) keysToSkip.add(k)

  const widthDefault = 28
  const heightDefault = 121.5
  const lengthDefault = 0

  let width = numberFromUnknown(flatConfig[adapterWidthKey]) ?? widthDefault
  let height = numberFromUnknown(flatConfig[adapterHeightKey]) ?? heightDefault
  const k = numberFromUnknown(flatConfig[adapterKKey]) ?? 0
  const nc = Math.max(0, Math.round(numberFromUnknown(flatConfig[adapterSegmentsKey]) ?? 0))
  const length = Math.max(0, numberFromUnknown(flatConfig[adapterLengthKey]) ?? lengthDefault)

  if (!Number.isFinite(width) || width <= 0) width = widthDefault
  if (!Number.isFinite(height) || height <= 0) height = heightDefault

  const throatAngleExpr = exprFromUnknown(flatConfig['Throat.Angle']) ?? '0'

  lines.push('Horn.Adapter = {')
  lines.push(`  Length = ${length}`)
  lines.push(`  Throat.Angle = ${throatAngleExpr}`)
  lines.push(`  Width = ${width}`)
  lines.push(`  Height = ${height}`)
  lines.push(`  k = ${k}`)
  lines.push(`  NC = ${nc}`)
  lines.push('}')

  // Emit Horn.Part:N blocks from _athui.HornParts array.
  // Ath V2025-06 expects a single `Horn.Part:<n>` object that includes both H and V parameter sets.
  const defaultProfile: HornPartProfile = { Profile: 'OS-SE', k: 0.5, s: 0.5, n: 4, q: 0.95, a: 0.3, Length: 50 }
  const defaultParts: HornPart[] = [{ H: { ...defaultProfile }, V: { ...defaultProfile } }]
  const rawParts = flatConfig['_athui.HornParts'] as HornPart[] | undefined
  const parts = Array.isArray(rawParts) && rawParts.length > 0 ? rawParts : defaultParts

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part) continue
    const partNum = i + 1

    const h = part.H
    const v = part.V
    const l = Math.max(0, numberFromUnknown(h.Length) ?? numberFromUnknown(v.Length) ?? 50)
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

export function serializeAthDefinition(flatConfig: Record<string, unknown>): string {
  const { lines: hornLines, keysToSkip } = buildHornGeometry2Lines(flatConfig)
  const lines: string[] = [...hornLines]

  for (const [key, raw] of Object.entries(flatConfig).sort(([a], [b]) => a.localeCompare(b))) {
    if (key.startsWith('_athui.')) continue
    if (keysToSkip.has(key)) continue
    const formatted = formatValue(raw)
    if (formatted === null) continue
    lines.push(`${key} = ${formatted}`)
  }
  return lines.join('\n') + '\n'
}
