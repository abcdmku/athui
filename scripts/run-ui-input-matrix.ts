import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { defaultSchema } from '../apps/studio/src/schema/defaultSchema'
import { buildProjectCfgText, isItemVisible } from '../apps/studio/src/schema/cfg'
import type { Condition, ItemSpec } from '../apps/studio/src/schema/types'

type RunResult = {
  runDir: string
  outputsDir: string
  exitCode: number | null
  signal: string | null
  files: Map<string, { size: number; sha256: string }>
}

function parseArgs(argv: string[]) {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq > 0) {
      args.set(a.slice(2, eq), a.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      args.set(a.slice(2), next)
      i++
    } else {
      args.set(a.slice(2), 'true')
    }
  }
  const keys = (args.get('keys') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const section = (args.get('section') ?? '').trim()
  const maxRuns = Number.parseInt(args.get('max') ?? '', 10)

  return {
    clean: args.get('clean') === 'true',
    verbose: args.get('verbose') === 'true',
    keys,
    section: section.length ? section : null,
    maxRuns: Number.isFinite(maxRuns) && maxRuns > 0 ? maxRuns : null,
    timeoutMs: Number.parseInt(args.get('timeoutMs') ?? '180000', 10),
  }
}

function withUtf8Bom(text: string): string {
  if (!text) return '\ufeff'
  if (text.startsWith('\ufeff')) return text
  return `\ufeff${text}`
}

function defaultValues(): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(defaultSchema.items)) {
    if (spec.default !== undefined && values[key] === undefined) values[key] = spec.default
  }
  return values
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
      if (Array.isArray(condition.value) && condition.value.length > 0) values[condition.key] = condition.value[0]
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

function pickTestOverride(spec: ItemSpec, current: unknown): unknown {
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
    case 'i':
      return (asNumber(current ?? d) ?? 0) + 1
    case 'f':
      return (asNumber(current ?? d) ?? 0) + 0.5
    case 'i[]':
      return [1, 2, 3]
    case 'f[]':
      return [0.1, 0.2, 0.3]
    case 'ex': {
      const s = typeof (current ?? d) === 'string' ? String(current ?? d) : ''
      return s.trim().length ? `${s.trim()} + 1` : '1'
    }
    case 'c':
    case '{}': {
      const s = typeof (current ?? d) === 'string' ? String(current ?? d) : ''
      return s.trim().length ? `${s.trim()} ` : '{ X = 1 }'
    }
    default: {
      const s = typeof (current ?? d) === 'string' ? String(current ?? d) : ''
      return s.trim().length ? `${s.trim()}_x` : 'test'
    }
  }
}

async function listFilesRecursively(rootDir: string): Promise<string[]> {
  const results: string[] = []
  async function walk(current: string) {
    const children = await fs.readdir(current, { withFileTypes: true })
    for (const child of children) {
      const full = path.join(current, child.name)
      if (child.isDirectory()) await walk(full)
      else if (child.isFile()) results.push(full)
    }
  }
  await walk(rootDir)
  return results
}

async function hashFile(filePath: string): Promise<{ size: number; sha256: string }> {
  const buf = await fs.readFile(filePath)
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
  return { size: buf.byteLength, sha256 }
}

function projectRoot(): string {
  return path.resolve(process.cwd())
}

function resolveAthExe(): string {
  const root = projectRoot()
  const p = path.join(root, 'ath-2025-06', 'ath.exe')
  return p
}

function resolveLocalGmshExe(): string {
  const root = projectRoot()
  return path.join(root, '.athui-data', 'tools', 'gmsh', 'gmsh.exe')
}

async function runAthOnce(opts: {
  runDir: string
  values: Record<string, unknown>
  timeoutMs: number
  verbose: boolean
}): Promise<RunResult> {
  const athExe = resolveAthExe()
  const gmshExe = resolveLocalGmshExe()

  await fs.mkdir(opts.runDir, { recursive: true })
  const outputsDir = path.join(opts.runDir, 'outputs')
  await fs.mkdir(outputsDir, { recursive: true })

  // ath.cfg lives in cwd; project.cfg is passed on the CLI.
  const meshCmd =
    typeof opts.values['_athui.MeshCmd'] === 'string' && opts.values['_athui.MeshCmd'].trim().length
      ? String(opts.values['_athui.MeshCmd']).trim()
      : `${gmshExe} %f -`
  const gnuplotPath =
    typeof opts.values['_athui.GnuplotPath'] === 'string' && opts.values['_athui.GnuplotPath'].trim().length
      ? String(opts.values['_athui.GnuplotPath']).trim()
      : null

  const athCfgLines = [`OutputRootDir = ${JSON.stringify(outputsDir)}`, `MeshCmd = ${JSON.stringify(meshCmd)}`]
  if (gnuplotPath) athCfgLines.push(`GnuplotPath = ${JSON.stringify(gnuplotPath)}`)
  await fs.writeFile(path.join(opts.runDir, 'ath.cfg'), athCfgLines.join('\n') + '\n', 'utf8')

  const { text: projectCfgText, errors } = buildProjectCfgText(defaultSchema, opts.values, { includeAdvanced: true })
  if (errors.length) throw new Error(`Config errors:\n${errors.map((e) => `- ${e}`).join('\n')}`)
  const projectCfgPath = path.join(opts.runDir, 'project.cfg')
  await fs.writeFile(projectCfgPath, withUtf8Bom(projectCfgText), 'utf8')

  const child = spawn(athExe, [projectCfgPath], { cwd: opts.runDir, windowsHide: true })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')))
  child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')))

  const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    const t = setTimeout(() => {
      child.kill()
      resolve({ code: null, signal: 'timeout' })
    }, opts.timeoutMs)

    child.on('error', (err) => {
      clearTimeout(t)
      reject(err)
    })
    child.on('close', (code, signal) => {
      clearTimeout(t)
      resolve({ code, signal: signal ?? null })
    })
  })

  if (opts.verbose) {
    // eslint-disable-next-line no-console
    console.log(`[ath] exit code=${code ?? 'null'} signal=${signal ?? 'null'}`)
    if (stdout.trim()) console.log(stdout.trim())
    if (stderr.trim()) console.error(stderr.trim())
  }

  // Ath sometimes nests outputs under OutputRootDir/project.
  const nested = path.join(outputsDir, 'project')
  let outputScanRoot = outputsDir
  try {
    const stat = await fs.stat(nested)
    if (stat.isDirectory()) outputScanRoot = nested
  } catch {
    // ignore
  }

  const files = new Map<string, { size: number; sha256: string }>()
  for (const full of await listFilesRecursively(outputScanRoot)) {
    const rel = path.relative(outputScanRoot, full).replaceAll(path.sep, '/')
    files.set(rel, await hashFile(full))
  }

  return { runDir: opts.runDir, outputsDir: outputScanRoot, exitCode: code, signal, files }
}

function collectUiKeys(opts: { section: string | null }): string[] {
  const keys = new Set<string>()
  for (const section of defaultSchema.sections) {
    if (opts.section && section.id !== opts.section) continue
    for (const group of section.groups) {
      for (const k of group.items) keys.add(k)
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b))
}

function diffFiles(a: RunResult, b: RunResult): { changed: string[]; added: string[]; removed: string[] } {
  const changed: string[] = []
  const added: string[] = []
  const removed: string[] = []

  for (const [k, vb] of b.files) {
    const va = a.files.get(k)
    if (!va) {
      added.push(k)
      continue
    }
    if (va.sha256 !== vb.sha256 || va.size !== vb.size) changed.push(k)
  }
  for (const k of a.files.keys()) {
    if (!b.files.has(k)) removed.push(k)
  }
  return { changed, added, removed }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const athExe = resolveAthExe()
  const gmshExe = resolveLocalGmshExe()
  try {
    await fs.access(athExe)
  } catch {
    throw new Error(`ath.exe not found at: ${athExe}`)
  }
  try {
    await fs.access(gmshExe)
  } catch {
    throw new Error(`gmsh.exe not found at: ${gmshExe} (run: npm run setup:gmsh)`)
  }

  const baseValues = defaultValues()
  // Ensure we generate enough artifacts to detect changes.
  baseValues['Output.STL'] = true
  baseValues['Output.ABECProject'] = true

  const runRoot = path.join(projectRoot(), '.athui-data', 'validation', 'ui-input-matrix', String(Date.now()))
  await fs.mkdir(runRoot, { recursive: true })

  const keysFromSchema = collectUiKeys({ section: args.section })
  const keys = (args.keys.length ? args.keys : keysFromSchema).filter((k) => defaultSchema.items[k])
  const picked = args.maxRuns ? keys.slice(0, args.maxRuns) : keys

  // eslint-disable-next-line no-console
  console.log(`[athui] Running Ath matrix: ${picked.length} input(s) in ${runRoot}`)

  const baselineDir = path.join(runRoot, '_baseline')
  const baseline = await runAthOnce({ runDir: baselineDir, values: baseValues, timeoutMs: args.timeoutMs, verbose: args.verbose })
  if (baseline.exitCode !== 0) {
    throw new Error(`Baseline run failed (code=${baseline.exitCode ?? 'null'} signal=${baseline.signal ?? 'null'}). See: ${baselineDir}`)
  }

  const failures: { key: string; reason: string; runDir: string }[] = []

  for (const key of picked) {
    const spec = defaultSchema.items[key]
    if (!spec) continue

    const values = { ...baseValues }
    ensureVisibility(values, spec)

    // _athui.* keys are still valuable here (they influence ath.cfg generation).
    values[key] = pickTestOverride(spec, values[key])

    const runDir = path.join(runRoot, key.replaceAll(/[^\w.-]+/g, '_'))
    const result = await runAthOnce({ runDir, values, timeoutMs: args.timeoutMs, verbose: args.verbose })
    if (result.exitCode !== 0) {
      failures.push({
        key,
        reason: `run failed (code=${result.exitCode ?? 'null'} signal=${result.signal ?? 'null'})`,
        runDir,
      })
      continue
    }

    const { changed, added, removed } = diffFiles(baseline, result)
    const anyChange = changed.length > 0 || added.length > 0 || removed.length > 0
    if (!anyChange) {
      failures.push({ key, reason: 'no output files changed vs baseline', runDir })
      continue
    }
  }

  if (failures.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`[athui] OK: all ${picked.length} input(s) changed outputs (or completed successfully).`)
    if (args.clean) {
      await fs.rm(runRoot, { recursive: true, force: true })
    }
    return
  }

  // eslint-disable-next-line no-console
  console.error(`[athui] FAIL: ${failures.length}/${picked.length} input(s) produced no detectable change or failed.`)
  for (const f of failures) {
    // eslint-disable-next-line no-console
    console.error(`- ${f.key}: ${f.reason} (see: ${f.runDir})`)
  }
  process.exitCode = 1
}

void main()
