import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nanoid } from 'nanoid'
import type { WebSocket } from 'ws'
import { serializeAthDefinition } from './serialize.js'

type Project = {
  id: string
  dir: string
  config: Record<string, unknown>
  logs: string[]
  process: ReturnType<typeof spawn> | null
  wsClients: Set<WebSocket>
}

const projects = new Map<string, Project>()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..', '..')
const dataDir = path.join(repoRoot, '.athui-data')
const projectsDir = path.join(dataDir, 'projects')

function withUtf8Bom(text: string): string {
  if (!text) return '\ufeff'
  if (text.startsWith('\ufeff')) return text
  return `\ufeff${text}`
}

function toLines(textChunk: string): string[] {
  return textChunk
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .filter((l) => !/^Syntax error 2: 'GridExport(?::[^']+)?'$/.test(l))
}

function appendLogs(project: Project, lines: string[]) {
  if (lines.length === 0) return

  project.logs.push(...lines)
  if (project.logs.length > 10_000) project.logs.splice(0, project.logs.length - 10_000)

  const message = JSON.stringify({ type: 'logs:append', lines })
  for (const client of project.wsClients) client.send(message)
}

function broadcast(project: Project, payload: unknown) {
  const message = JSON.stringify(payload)
  for (const client of project.wsClients) client.send(message)
}

function ensureGridExportProfiles(cfgText: string): string {
  const lower = cfgText.toLowerCase()
  if (lower.includes('exportprofiles')) return cfgText

  return (
    cfgText +
    [
      '',
      'GridExport:athui = { ProfileRange = 0,9999 SliceRange = 0,9999 ExportProfiles = 1 ExportSlices = 0 Scale = 1.0 SeparateFiles = 0 FileExtension = "csv" Delimiter = ";" }',
    ].join('\n')
  )
}

function sanitizeCfgTextForAth2025(
  cfgText: string,
  opts?: {
    forceThroatProfile?: string | null
  },
): string {
  // Ath V2025-06 no longer supports the Rollback feature.
  // Also, `AxiMorph` currently triggers an access violation when meshing/STL output is enabled;
  // strip both to prevent hard crashes from stale configs or Advanced overrides.
  const stripped = cfgText
    .replace(/^\s*Rollback(?:\.[A-Za-z0-9_.:-]+)?\s*=.*\n/gm, '')
    .replace(/^\s*AxiMorph\s*=.*\n/gm, '')
    .replace(/^\s*Throat\.Profile\s*=\s*\n/gm, '')

  // If there are multiple Throat.Profile assignments, keep only the last one.
  // Some Ath builds appear to treat mixed string/numeric assignments as 0 (unknown profile).
  const lines = stripped.split('\n')
  let profileLine: string | null = null
  const profileRegex = /^\s*Throat\.Profile\s*=/i
  for (const line of lines) {
    if (profileRegex.test(line)) profileLine = line
  }

  const otherLines = lines.filter((line) => !profileRegex.test(line))
  const match = (profileLine ?? '').match(/^\s*Throat\.Profile\s*=\s*(.*)\s*$/i)
  const value = (match?.[1] ?? '').trim()
  const forcedProfile = typeof opts?.forceThroatProfile === 'string' ? opts.forceThroatProfile.trim() : ''

  // Prefer string profile types (like R-OSSE) over numeric if both are present
  const normalizedProfileLine = forcedProfile
    ? `Throat.Profile = ${forcedProfile}`
    : value && value !== '0'
      ? `Throat.Profile = ${value}`
      : 'Throat.Profile = 1'

  return [normalizedProfileLine, ...otherLines].join('\n')
}

export function getProject(id: string): Project | undefined {
  return projects.get(id)
}

export async function createProject(): Promise<Project> {
  await fs.mkdir(projectsDir, { recursive: true })

  const id = nanoid(10)
  const dir = path.join(projectsDir, id)
  await fs.mkdir(dir, { recursive: true })

  const project: Project = { id, dir, config: {}, logs: [], process: null, wsClients: new Set() }
  projects.set(id, project)
  return project
}

export async function updateProjectConfig(project: Project, config: Record<string, unknown>) {
  project.config = config
  await fs.writeFile(path.join(project.dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8')
}

function stringFromConfig(project: Project, key: string): string | null {
  const value = project.config[key]
  return typeof value === 'string' && value.trim().length ? value.trim() : null
}

function numberFromConfig(project: Project, key: string): number | null {
  const value = project.config[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function resolveMeshCmd(project: Project): string | null {
  const explicit = stringFromConfig(project, '_athui.MeshCmd') ?? (process.env.ATHUI_MESHCMD?.trim() || null)
  if (explicit) return explicit

  // Preferred: local install via `npm run setup:gmsh`
  const localGmsh = path.join(repoRoot, '.athui-data', 'tools', 'gmsh', 'gmsh.exe')
  const probe = spawnSync(localGmsh, ['-version'], { windowsHide: true })
  if (probe.status === 0) return `${localGmsh} %f -`

  // Best-effort auto-detect (Windows): if gmsh is on PATH, enable meshing.
  if (process.platform === 'win32') {
    const where = spawnSync('where.exe', ['gmsh.exe'], { encoding: 'utf8' })
    const first = where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0]
    if (first) return `${first} %f -`
  }

  return null
}

function extractExeFromMeshCmd(meshCmd: string): string | null {
  const s = meshCmd.trim()
  if (!s) return null
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1)
    if (end > 1) return s.slice(1, end)
    return null
  }
  const first = s.split(/\s+/)[0]
  return first || null
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function smoothstep01(t: number): number {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

type RollbackSpec = { kind: 'angle'; angleDeg: number } | { kind: 'mm'; mm: number }

function computeRollbackMmFromAngle(angleDeg: number, rMax: number): number {
  if (!Number.isFinite(angleDeg) || !Number.isFinite(rMax) || rMax <= 0) return 0
  // Map angles to a stable, intuitive distance:
  // - 0 disables
  // - ~180 => moderate rollback (around ~15mm for a ~54mm mouth radius)
  // - ~220 => stronger
  const t = clamp01((angleDeg - 90) / 180) // 90 => 0, 270 => 1
  return rMax * 0.55 * t
}

function resolveRollbackMm(spec: RollbackSpec, rMax: number): number {
  if (spec.kind === 'mm') return spec.mm
  return computeRollbackMmFromAngle(spec.angleDeg, rMax)
}

function applyRollbackToZ({
  x,
  y,
  z,
  zMax,
  rMax,
  rollbackMm,
}: {
  x: number
  y: number
  z: number
  zMax: number
  rMax: number
  rollbackMm: number
}): number {
  const span = Math.max(rollbackMm * 2, 1e-6)
  const tZ = (z - (zMax - span)) / span
  const wZ = smoothstep01(tZ)

  const r = Math.hypot(x, y)
  const tR = rMax > 0 ? clamp01(r / rMax) : 1
  const wR = tR * tR

  return z - rollbackMm * wZ * wR
}

async function findGeoFiles(rootDir: string): Promise<string[]> {
  const results: string[] = []
  async function walk(current: string) {
    const children = await fs.readdir(current, { withFileTypes: true })
    for (const child of children) {
      const full = path.join(current, child.name)
      if (child.isDirectory()) {
        await walk(full)
      } else if (child.isFile() && child.name.toLowerCase().endsWith('.geo')) {
        results.push(full)
        if (results.length > 50) return
      }
    }
  }
  await walk(rootDir)
  return results
}

async function listFilesRecursively(rootDir: string): Promise<string[]> {
  const results: string[] = []
  async function walk(current: string) {
    const children = await fs.readdir(current, { withFileTypes: true })
    for (const child of children) {
      const full = path.join(current, child.name)
      if (child.isDirectory()) {
        if (child.name === 'node_modules') continue
        if (child.name.toLowerCase().startsWith('abec_')) continue
        await walk(full)
      } else if (child.isFile()) {
        results.push(full)
        if (results.length > 2_000) return
      }
    }
  }
  await walk(rootDir)
  return results
}

function isBinaryStl(buffer: Buffer): boolean {
  if (buffer.length < 84) return false
  const triCount = buffer.readUInt32LE(80)
  const expected = 84 + triCount * 50
  return expected === buffer.length
}

function isRollbackDerivedFilePath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return lower.endsWith('_rollback.stl') || lower.endsWith('_rollback.csv')
}

function rollbackDerivedPath(filePath: string): string {
  const ext = path.extname(filePath)
  const base = ext ? filePath.slice(0, -ext.length) : filePath
  return `${base}_rollback${ext}`
}

type RollbackAppliedFile = {
  srcPath: string
  outPath: string
  rollbackMm: number
  rMax: number
  zMax: number
}

async function applyRollbackToStlFile(srcPath: string, outPath: string, rollback: RollbackSpec): Promise<RollbackAppliedFile | null> {
  const buf = await fs.readFile(srcPath)
  if (!isBinaryStl(buf)) return null

  const triCount = buf.readUInt32LE(80)
  if (triCount <= 0) return null

  let zMax = Number.NEGATIVE_INFINITY
  let rMax = 0

  for (let i = 0; i < triCount; i++) {
    const triOffset = 84 + i * 50
    for (let v = 0; v < 3; v++) {
      const vertexOffset = triOffset + 12 + v * 12
      const x = buf.readFloatLE(vertexOffset)
      const y = buf.readFloatLE(vertexOffset + 4)
      const z = buf.readFloatLE(vertexOffset + 8)
      if (Number.isFinite(z) && z > zMax) zMax = z
      const r = Math.hypot(x, y)
      if (Number.isFinite(r) && r > rMax) rMax = r
    }
  }

  if (!Number.isFinite(zMax) || zMax === Number.NEGATIVE_INFINITY) return null

  const rollbackMm = resolveRollbackMm(rollback, rMax)
  if (!Number.isFinite(rollbackMm) || rollbackMm <= 0) return null

  const out = Buffer.from(buf)

  for (let i = 0; i < triCount; i++) {
    const triOffset = 84 + i * 50
    const v: [number, number, number][] = []

    for (let vi = 0; vi < 3; vi++) {
      const vertexOffset = triOffset + 12 + vi * 12
      const x = out.readFloatLE(vertexOffset)
      const y = out.readFloatLE(vertexOffset + 4)
      const z = out.readFloatLE(vertexOffset + 8)
      const nextZ = applyRollbackToZ({ x, y, z, zMax, rMax, rollbackMm })
      out.writeFloatLE(nextZ, vertexOffset + 8)
      v.push([x, y, nextZ])
    }

    const [v1, v2, v3] = v
    if (!v1 || !v2 || !v3) continue
    const ax = v2[0] - v1[0]
    const ay = v2[1] - v1[1]
    const az = v2[2] - v1[2]
    const bx = v3[0] - v1[0]
    const by = v3[1] - v1[1]
    const bz = v3[2] - v1[2]
    let nx = ay * bz - az * by
    let ny = az * bx - ax * bz
    let nz = ax * by - ay * bx
    const nLen = Math.hypot(nx, ny, nz)
    if (nLen > 0) {
      nx /= nLen
      ny /= nLen
      nz /= nLen
    } else {
      nx = 0
      ny = 0
      nz = 0
    }
    out.writeFloatLE(nx, triOffset + 0)
    out.writeFloatLE(ny, triOffset + 4)
    out.writeFloatLE(nz, triOffset + 8)
  }

  await fs.writeFile(outPath, out)
  return { srcPath, outPath, rollbackMm, rMax, zMax }
}

async function applyRollbackToCsvFile(srcPath: string, outPath: string, rollback: RollbackSpec): Promise<RollbackAppliedFile | null> {
  const raw = await fs.readFile(srcPath, 'utf8')
  const normalized = raw.replaceAll('\r\n', '\n')
  const lines = normalized.split('\n')

  let zMax = Number.NEGATIVE_INFINITY
  let rMax = 0
  let parseable = 0
  let delimiter: ';' | ',' = ';'

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#')) continue
    if (line.includes(',')) delimiter = ','

    const parts = line.split(delimiter)
    if (parts.length < 3) continue
    const x = Number.parseFloat(parts[0] ?? '')
    const y = Number.parseFloat(parts[1] ?? '')
    const z = Number.parseFloat(parts[2] ?? '')
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    parseable++
    if (z > zMax) zMax = z
    const r = Math.hypot(x, y)
    if (r > rMax) rMax = r
  }

  if (parseable < 10 || !Number.isFinite(zMax) || zMax === Number.NEGATIVE_INFINITY) return null

  const rollbackMm = resolveRollbackMm(rollback, rMax)
  if (!Number.isFinite(rollbackMm) || rollbackMm <= 0) return null

  const outLines = lines.map((rawLine) => {
    const line = rawLine.trim()
    if (!line) return ''
    if (line.startsWith('#')) return line
    const parts = line.split(delimiter)
    if (parts.length < 3) return rawLine
    const x = Number.parseFloat(parts[0] ?? '')
    const y = Number.parseFloat(parts[1] ?? '')
    const z = Number.parseFloat(parts[2] ?? '')
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return rawLine

    const nextZ = applyRollbackToZ({ x, y, z, zMax, rMax, rollbackMm })
    return `${x.toFixed(6)}${delimiter}${y.toFixed(6)}${delimiter}${nextZ.toFixed(6)}`
  })

  const outText = outLines.join('\n').replace(/\n+$/, '\n')
  await fs.writeFile(outPath, outText, 'utf8')
  return { srcPath, outPath, rollbackMm, rMax, zMax }
}

async function applyRollbackPostProcess(project: Project, outputsDir: string) {
  const runOutputsDir = path.join(outputsDir, 'project')
  let root = outputsDir
  try {
    const stat = await fs.stat(runOutputsDir)
    if (stat.isDirectory()) root = runOutputsDir
  } catch {
    // ignore
  }

  let files: string[] = []
  try {
    files = await listFilesRecursively(root)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendLogs(project, [`[athui] rollback scan failed: ${message}`])
    return
  }

  const derived = files.filter((p) => isRollbackDerivedFilePath(p))

  const termination = stringFromConfig(project, '_athui.MouthTermination')?.toLowerCase() ?? null
  const throatProfile = stringFromConfig(project, 'Throat.Profile')?.toLowerCase() ?? null
  const terminationEnabled = termination === 'r-osse'
  const profileEnabled = throatProfile === 'r-osse'

  const angleDeg = numberFromConfig(project, '_athui.RollbackAngleDeg')
  const distanceMm = numberFromConfig(project, '_athui.RollbackMm')

  let rollback: RollbackSpec | null = null
  if (angleDeg !== null) {
    if (angleDeg <= 0) rollback = null
    else rollback = { kind: 'angle', angleDeg }
  } else if (distanceMm !== null) {
    if (distanceMm <= 0) rollback = null
    else rollback = { kind: 'mm', mm: distanceMm }
  } else if (terminationEnabled) {
    // Default behavior for Quick Setup: a moderate rollback.
    rollback = { kind: 'angle', angleDeg: 180 }
  }

  if ((!terminationEnabled && !profileEnabled) || !rollback) {
    if (derived.length > 0) {
      let removed = 0
      for (const fp of derived) {
        try {
          await fs.unlink(fp)
          removed++
        } catch {
          // ignore
        }
      }
      if (removed > 0) appendLogs(project, [`[athui] rollback disabled; removed ${removed} derived file${removed === 1 ? '' : 's'}`])
    }
    return
  }

  const stlSources = files.filter((filePath) => {
    const lower = filePath.toLowerCase()
    if (!lower.endsWith('.stl')) return false
    if (isRollbackDerivedFilePath(lower)) return false
    if (lower.includes('bem_mesh')) return false
    return true
  })

  const csvSources = files.filter((filePath) => {
    const lower = filePath.toLowerCase()
    if (!lower.endsWith('.csv')) return false
    if (isRollbackDerivedFilePath(lower)) return false
    if (!lower.includes('profiles') && !lower.includes('slices')) return false
    return true
  })

  if (stlSources.length === 0 && csvSources.length === 0) {
    appendLogs(project, [`[athui] rollback enabled, but no STL/CSV outputs found in: ${root}`])
    return
  }

  let applied = 0
  let example: RollbackAppliedFile | null = null
  try {
    for (const src of stlSources) {
      const outPath = rollbackDerivedPath(src)
      const result = await applyRollbackToStlFile(src, outPath, rollback)
      if (result) {
        applied++
        if (!example) example = result
      }
    }
    for (const src of csvSources) {
      const outPath = rollbackDerivedPath(src)
      const result = await applyRollbackToCsvFile(src, outPath, rollback)
      if (result) {
        applied++
        if (!example) example = result
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendLogs(project, [`[athui] rollback post-process failed: ${message}`])
    return
  }

  const modeLabel = rollback.kind === 'angle' ? `${rollback.angleDeg} deg` : `${rollback.mm} mm`
  if (applied > 0 && example) {
    appendLogs(project, [
      `[athui] rollback applied: ${modeLabel} -> ${example.rollbackMm.toFixed(2)} mm (mouth r=${example.rMax.toFixed(2)}), wrote ${applied} file${applied === 1 ? '' : 's'}`,
    ])
  } else if (applied > 0) {
    appendLogs(project, [`[athui] rollback applied: ${modeLabel}, wrote ${applied} file${applied === 1 ? '' : 's'}`])
  }
}

async function runGmshToStl({
  gmshExe,
  geoPath,
  outPath,
  cwd,
  project,
}: {
  gmshExe: string
  geoPath: string
  outPath: string
  cwd: string
  project: Project
}): Promise<void> {
  appendLogs(project, [`[gmsh] ${gmshExe} ${geoPath} -3 -format stl -o ${outPath} -bin`])

  await new Promise<void>((resolve) => {
    const child = spawn(gmshExe, [geoPath, '-3', '-format', 'stl', '-o', outPath, '-bin', '-v', '0'], {
      cwd,
      windowsHide: true,
    })
    child.stdout.on('data', (b: Buffer) => appendLogs(project, toLines(b.toString('utf8'))))
    child.stderr.on('data', (b: Buffer) => appendLogs(project, toLines(b.toString('utf8'))))
    child.on('error', (err) => {
      appendLogs(project, [`[gmsh] process error: ${err.message}`])
      resolve()
    })
    child.on('close', (code) => {
      appendLogs(project, [`[gmsh] exit code=${code ?? 'null'}`])
      resolve()
    })
  })
}

async function postProcessOutputs(project: Project, outputsDir: string, meshCmd: string | null) {
  if (!meshCmd) return
  const gmshExe = extractExeFromMeshCmd(meshCmd)
  if (!gmshExe) return

  try {
    const geoFiles = await findGeoFiles(outputsDir)
    for (const geo of geoFiles) {
      const base = path.basename(geo, path.extname(geo))
      const outPath = path.join(path.dirname(geo), `${base}.stl`)

      // Check if STL needs regeneration: missing or older than .geo file
      let needsRegen = false
      try {
        const [geoStat, stlStat] = await Promise.all([fs.stat(geo), fs.stat(outPath)])
        needsRegen = geoStat.mtimeMs > stlStat.mtimeMs
      } catch {
        // STL doesn't exist, needs generation
        needsRegen = true
      }

      if (!needsRegen) continue
      await runGmshToStl({ gmshExe, geoPath: geo, outPath, cwd: path.dirname(geo), project })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendLogs(project, [`[gmsh] post-process failed: ${message}`])
  }
}

export async function runProject(project: Project) {
  if (project.process) throw new Error('Project is already running')

  const athExe = process.env.ATHUI_ATH_EXE
    ? path.resolve(process.env.ATHUI_ATH_EXE)
    : path.join(repoRoot, 'ath-2025-06', 'ath.exe')

  try {
    await fs.access(athExe)
  } catch {
    throw new Error(`ath.exe not found at: ${athExe}`)
  }

  const outputsDir = path.join(project.dir, 'outputs')
  await fs.mkdir(outputsDir, { recursive: true })

  // Ath reads `ath.cfg` from the working directory. The bundled `ath-2025-06/ath.cfg`
  // points to a machine-specific `D:\\Horns` output root; use a project-local output root instead.
  const athCfgLines = [`OutputRootDir = ${JSON.stringify(outputsDir)}`]

  const meshCmd = resolveMeshCmd(project)
  if (meshCmd) athCfgLines.push(`MeshCmd = ${JSON.stringify(meshCmd)}`)

  const gnuplotPath =
    stringFromConfig(project, '_athui.GnuplotPath') ?? (process.env.ATHUI_GNUPLOT_PATH?.trim() || null)
  if (gnuplotPath) athCfgLines.push(`GnuplotPath = ${JSON.stringify(gnuplotPath)}`)

  const runtimeAthCfg = athCfgLines.join('\n') + '\n'
  await fs.writeFile(path.join(project.dir, 'ath.cfg'), runtimeAthCfg, 'utf8')

  const definitionPath = path.join(project.dir, 'project.cfg')

  // Build effective config and optional cfg-text override from the UI.
  const effectiveConfig = { ...project.config }
  const forceThroatProfile = effectiveConfig['_athui.MouthTermination'] === 'r-osse' ? 'R-OSSE' : null

  const cfgTextOverrideRaw = effectiveConfig['_athui.cfgText']
  const cfgTextOverride =
    typeof cfgTextOverrideRaw === 'string' && cfgTextOverrideRaw.trim().length > 0 ? cfgTextOverrideRaw : null

  if (!cfgTextOverride && forceThroatProfile) {
    // For backwards compatibility (older UI clients): ensure the override applies when the server generates cfg text.
    effectiveConfig['Throat.Profile'] = forceThroatProfile
  }

  const cfgText = cfgTextOverride ?? serializeAthDefinition(effectiveConfig)
  const sanitized = sanitizeCfgTextForAth2025(cfgText, { forceThroatProfile })
  await fs.writeFile(definitionPath, withUtf8Bom(ensureGridExportProfiles(sanitized)), 'utf8')

  appendLogs(project, [`[run] ${athExe} ${definitionPath}`])
  appendLogs(project, [`[run] OutputRootDir = ${outputsDir}`])
  appendLogs(project, [`[run] MeshCmd = ${meshCmd ?? '(not set)'}`])

  const child = spawn(athExe, [definitionPath], {
    cwd: project.dir,
    windowsHide: true,
  })

  project.process = child

  const timeoutMs = Number.parseInt(process.env.ATHUI_TIMEOUT_MS ?? '120000', 10)
  const timeout = setTimeout(() => {
    appendLogs(project, [`[run] timeout after ${timeoutMs}ms; killing process`])
    child.kill()
  }, timeoutMs)

  child.stdout.on('data', (b: Buffer) => appendLogs(project, toLines(b.toString('utf8'))))
  child.stderr.on('data', (b: Buffer) => appendLogs(project, toLines(b.toString('utf8'))))
  child.on('error', (err) => appendLogs(project, [`[run] process error: ${err.message}`]))
  child.on('close', (code, signal) => {
    clearTimeout(timeout)
    appendLogs(project, [`[run] exit code=${code ?? 'null'} signal=${signal ?? 'null'}`])
    project.process = null

    if (code === 0) {
      void (async () => {
        await postProcessOutputs(project, outputsDir, meshCmd)
        await applyRollbackPostProcess(project, outputsDir)
        const files = await listProjectFiles(project)
        broadcast(project, { type: 'files:update', files })
        broadcast(project, { type: 'run:done', ok: true, code, signal })
      })()
      return
    }

    broadcast(project, { type: 'run:done', ok: false, code, signal })
  })
}

export async function listProjectFiles(project: Project): Promise<{ path: string; size: number }[]> {
  const entries: { path: string; size: number }[] = []

  async function walk(current: string) {
    const children = await fs.readdir(current, { withFileTypes: true })
    for (const child of children) {
      const full = path.join(current, child.name)
      const rel = path.relative(project.dir, full).replaceAll(path.sep, '/')
      if (child.isDirectory()) {
        if (child.name === 'node_modules') continue
        await walk(full)
      } else if (child.isFile()) {
        const stat = await fs.stat(full)
        entries.push({ path: rel, size: stat.size })
        if (entries.length > 500) return
      }
    }
  }

  await walk(project.dir)
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

export async function resolveProjectFile(project: Project, relativePath: string): Promise<string | null> {
  const normalized = relativePath.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null

  const full = path.resolve(project.dir, normalized)
  const rel = path.relative(project.dir, full)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null

  try {
    const stat = await fs.stat(full)
    if (!stat.isFile()) return null
    return full
  } catch {
    return null
  }
}
