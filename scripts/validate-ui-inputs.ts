import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { defaultSchema } from '../apps/studio/src/schema/defaultSchema'
import { buildProjectCfgText, isItemVisible } from '../apps/studio/src/schema/cfg'
import type { Condition, ItemSpec } from '../apps/studio/src/schema/types'
import { applyMeshQualityPreset, getMeshQualityPresetValues, meshQualityKeys } from '../apps/studio/src/mesh/qualityPresets'

type Issue = { level: 'error' | 'warn'; message: string }

function parseArgs(argv: string[]) {
  const flags = new Set(argv)
  return {
    verbose: flags.has('--verbose'),
  }
}

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

function parseCfgText(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const rawLine of text.replaceAll('\r\n', '\n').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    map.set(key, value)
  }
  return map
}

function collectUiKeysFromSchema(): string[] {
  const keys = new Set<string>()
  for (const section of defaultSchema.sections) {
    for (const group of section.groups) {
      for (const item of group.items) keys.add(item)
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b))
}

function defaultValues(): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(defaultSchema.items)) {
    if (spec.default !== undefined && values[key] === undefined) values[key] = spec.default
  }
  return values
}

function pickTruthyValue(spec: ItemSpec | undefined): unknown {
  if (!spec) return true
  switch (spec.valueType) {
    case 'b':
      return true
    case 'i':
    case 'f':
      return 1
    default:
      return '1'
  }
}

function pickFalsyValue(spec: ItemSpec | undefined): unknown {
  if (!spec) return false
  switch (spec.valueType) {
    case 'b':
      return false
    case 'i':
    case 'f':
      return 0
    default:
      return ''
  }
}

function satisfyCondition(values: Record<string, unknown>, condition: Condition) {
  const spec = defaultSchema.items[condition.key]
  const current = values[condition.key]

  switch (condition.op) {
    case 'eq': {
      values[condition.key] = condition.value
      return
    }
    case 'neq': {
      if (current !== condition.value) return
      if (spec?.ui.widget === 'select' && Array.isArray(spec.ui.options)) {
        const alt = spec.ui.options.map((o) => o.value).find((v) => v !== condition.value)
        values[condition.key] = alt ?? pickTruthyValue(spec)
        return
      }
      values[condition.key] = typeof condition.value === 'number' ? condition.value + 1 : String(condition.value) + '_x'
      return
    }
    case 'in': {
      if (Array.isArray(condition.value) && condition.value.length > 0) {
        values[condition.key] = condition.value[0]
      }
      return
    }
    case 'truthy': {
      values[condition.key] = pickTruthyValue(spec)
      return
    }
    case 'falsy': {
      values[condition.key] = pickFalsyValue(spec)
      return
    }
    case 'defined': {
      if (isDefined(values[condition.key])) return
      values[condition.key] = spec?.default ?? pickTruthyValue(spec)
      return
    }
    case 'undefined': {
      delete values[condition.key]
      return
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const b = asNumber(condition.value)
      const base = b ?? 0
      if (condition.op === 'gt') values[condition.key] = base + 1
      if (condition.op === 'gte') values[condition.key] = base
      if (condition.op === 'lt') values[condition.key] = base - 1
      if (condition.op === 'lte') values[condition.key] = base
      return
    }
    default: {
      const _exhaustive: never = condition.op
      void _exhaustive
    }
  }
}

function ensureVisibility(values: Record<string, unknown>, spec: ItemSpec) {
  for (const c of spec.visibleWhen ?? []) satisfyCondition(values, c)
  for (const c of spec.requiredWhen ?? []) satisfyCondition(values, c)
}

function sampleOverride(spec: ItemSpec, current: unknown): unknown {
  const d = spec.default

  if (spec.ui.widget === 'select' && Array.isArray(spec.ui.options)) {
    const options = spec.ui.options.map((o) => o.value)
    const curr = current ?? d
    const alt = options.find((v) => v !== curr)
    return alt ?? curr ?? options[0] ?? '1'
  }

  switch (spec.valueType) {
    case 'b':
      return !Boolean(current ?? d)
    case 'i': {
      const n = asNumber(current ?? d)
      if (n !== null) return Math.trunc(n) + 1
      return 1
    }
    case 'f': {
      const n = asNumber(current ?? d)
      if (n !== null) return n + 0.5
      return 1.5
    }
    case 'i[]':
      return [1, 2, 3]
    case 'f[]':
      return [0.1, 0.2, 0.3]
    case 's': {
      const s = typeof (current ?? d) === 'string' ? String(current ?? d) : ''
      return s.trim().length ? `${s.trim()}_x` : 'test'
    }
    case 'ex': {
      const s = typeof (current ?? d) === 'string' ? String(current ?? d) : ''
      return s.trim().length ? `${s.trim()} + 1` : '1'
    }
    case 'c':
    case '{}': {
      const s = typeof (current ?? d) === 'string' ? String(current ?? d) : ''
      return s.trim().length ? `${s.trim()} ` : '{ X = 1 }'
    }
    default:
      return 'test'
  }
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const issues: Issue[] = []

  const uiKeys = collectUiKeysFromSchema()
  if (uiKeys.length === 0) issues.push({ level: 'error', message: 'No UI keys found from schema sections.' })

  // Schema integrity: every referenced key must exist as an item.
  for (const key of uiKeys) {
    if (!defaultSchema.items[key]) issues.push({ level: 'error', message: `Schema references missing item: ${key}` })
  }

  // Basic formatting expectation: _athui keys are UI-only and should never be emitted in cfg text.
  const base = defaultValues()
  const baseText = buildProjectCfgText(defaultSchema, base, { includeAdvanced: true }).text
  const baseCfg = parseCfgText(baseText)
  for (const key of uiKeys.filter((k) => k.startsWith('_athui.'))) {
    if (baseCfg.has(key)) issues.push({ level: 'error', message: `UI-only key unexpectedly emitted into cfg: ${key}` })
  }

  // Per-input check: changing the value changes emitted cfg line (for Ath keys).
  for (const key of uiKeys) {
    const spec = defaultSchema.items[key]
    if (!spec) continue

    const values0 = defaultValues()
    ensureVisibility(values0, spec)

    // Skip keys that still aren't visible in "show all settings" mode.
    if (!isItemVisible(spec, values0)) {
      issues.push({ level: 'warn', message: `Skipping hidden item (conditions not satisfied by defaults+autofix): ${key}` })
      continue
    }

    const text0 = buildProjectCfgText(defaultSchema, values0, { includeAdvanced: true }).text
    const cfg0 = parseCfgText(text0)

    const values1 = { ...values0 }
    values1[key] = sampleOverride(spec, values1[key])
    const text1 = buildProjectCfgText(defaultSchema, values1, { includeAdvanced: true }).text
    const cfg1 = parseCfgText(text1)

    if (key.startsWith('_athui.')) {
      if (cfg1.has(key)) issues.push({ level: 'error', message: `UI-only key emitted into cfg after override: ${key}` })
      continue
    }

    // Some UI keys are serialized into composed items (multi-line blocks) rather than emitted as `Key = Value`.
    // For those, validate by checking that the overall cfg text changes when the input changes.
    const isComposedKey = values0['HornGeometry'] === 2 && /^Horn\.Adapter\./.test(key)
    if (isComposedKey) {
      if (text0 === text1) issues.push({ level: 'error', message: `CFG text unchanged after override for: ${key}` })
      continue
    }

    const line0 = cfg0.get(key) ?? null
    const line1 = cfg1.get(key) ?? null
    if (line1 === null) {
      issues.push({ level: 'error', message: `Changing value did not emit cfg assignment for: ${key}` })
      continue
    }
    if (line0 !== null && line0 === line1) {
      issues.push({ level: 'error', message: `Changing value did not change emitted cfg for: ${key}` })
      continue
    }
    if (line0 === null && cfg0.size === cfg1.size && text0 === text1) {
      issues.push({ level: 'error', message: `CFG text unchanged after override for: ${key}` })
      continue
    }

    if (args.verbose) {
      const suffix = line0 === null ? '(was absent)' : `(was: ${line0})`
      // eslint-disable-next-line no-console
      console.log(`[ok] ${key}: ${line1} ${suffix}`)
    }
  }

  // Mesh quality presets: selecting a preset must materialize all mesh keys (non-custom path).
  for (const preset of ['low', 'medium', 'high', 'ultra'] as const) {
    const next = getMeshQualityPresetValues(preset)
    const missing = meshQualityKeys.filter((k) => next[k] === undefined)
    if (missing.length) issues.push({ level: 'error', message: `Mesh preset "${preset}" missing keys: ${missing.join(', ')}` })
  }
  {
    const values = defaultValues()
    values['_athui.MeshQuality'] = 'low'
    const applied = applyMeshQualityPreset(values)
    for (const k of meshQualityKeys) {
      if (applied[k] === undefined) issues.push({ level: 'error', message: `applyMeshQualityPreset did not set ${k} for preset "low"` })
    }
  }

  // Static wiring: every _athui.* input should be referenced somewhere outside the schema (UI logic or server).
  const serverProjectsTs = await readTextIfExists(path.join('apps', 'server', 'src', 'projects.ts'))
  const studioAppTsx = await readTextIfExists(path.join('apps', 'studio', 'src', 'App.tsx'))
  const athuiKeys = uiKeys.filter((k) => k.startsWith('_athui.'))
  for (const k of athuiKeys) {
    const mentioned = serverProjectsTs.includes(k) || studioAppTsx.includes(k)
    if (!mentioned) issues.push({ level: 'warn', message: `UI-only key not referenced outside schema: ${k}` })
  }

  const errors = issues.filter((i) => i.level === 'error')
  const warns = issues.filter((i) => i.level === 'warn')

  // eslint-disable-next-line no-console
  console.log(`[athui] UI input validation: ${uiKeys.length} inputs, ${errors.length} error(s), ${warns.length} warning(s)`)

  for (const i of issues) {
    // eslint-disable-next-line no-console
    console.log(`${i.level === 'error' ? 'ERROR' : 'WARN '} ${i.message}`)
  }

  process.exitCode = errors.length ? 1 : 0
}

void main()
