function quoteString(value: string): string {
  const needsQuotes = /[\s"]/g.test(value)
  if (!needsQuotes) return value
  return `"${value.replaceAll('"', '\\"')}"`
}

function formatValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'string') return value.length ? quoteString(value) : null
  if (Array.isArray(value)) {
    if (value.length === 0) return null
    const parts = value
      .map((v) => (typeof v === 'number' || typeof v === 'string' ? String(v).trim() : ''))
      .filter(Boolean)
    return parts.length ? parts.join(', ') : null
  }
  return null
}

export function serializeAthDefinition(flatConfig: Record<string, unknown>): string {
  const lines: string[] = []
  for (const [key, raw] of Object.entries(flatConfig).sort(([a], [b]) => a.localeCompare(b))) {
    if (key.startsWith('_athui.')) continue
    const formatted = formatValue(raw)
    if (formatted === null) continue
    lines.push(`${key} = ${formatted}`)
  }
  return lines.join('\n') + '\n'
}
