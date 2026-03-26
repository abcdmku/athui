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

type RectGuideMorphSpec = {
  guideType: 1 | 2
  guideWidth: number
  guideHeight: number
  guideDist: number
  guideRotRad: number
  superellipseN: number
  superformula: [number, number, number, number, number, number]
  targetWidth: number
  targetHeight: number
  baseExtentX: number
  baseExtentY: number
}

type XYRow = { x: number; y: number; z: number }
type BoundarySlice = { z: number; radii: Float64Array }
type DimensionSlice = { z: number; width: number; height: number }
type SliceLoop = { z: number; points: XYRow[] }
type RectGuideMeshSpec = {
  angularSegments: number
  lengthSegments: number
  cornerSegments: number
  throatResolution: number
  mouthResolution: number
}

const RECT_GUIDE_ANGLE_BINS = 720
const RECT_GUIDE_SAMPLE_COUNT = 4096

function normalizeAngleRad(theta: number): number {
  const tau = Math.PI * 2
  let out = theta % tau
  if (out < 0) out += tau
  return out
}

function parseGuideSuperformula(value: unknown): [number, number, number, number, number, number] {
  const defaults: [number, number, number, number, number, number] = [1, 1, 4, 0.8, 8, 2]
  const values =
    Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(',').map((part) => part.trim())
        : []
  const nums = values
    .map((entry) => (typeof entry === 'number' ? entry : Number(entry)))
    .filter((entry) => Number.isFinite(entry))
  if (nums.length < 6) return defaults
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!, nums[4]!, nums[5]!]
}

function evaluateGuideBaseRadius(
  guideType: RectGuideMorphSpec['guideType'],
  superellipseN: number,
  superformula: RectGuideMorphSpec['superformula'],
  theta: number,
): number {
  if (guideType === 1) {
    const n = Math.max(superellipseN, 2)
    const c = Math.abs(Math.cos(theta))
    const s = Math.abs(Math.sin(theta))
    const denom = c ** n + s ** n
    return denom > 1e-12 ? denom ** (-1 / n) : 0
  }

  const [aRaw, bRaw, m, n1Raw, n2, n3] = superformula
  const a = Math.max(Math.abs(aRaw), 1e-6)
  const b = Math.max(Math.abs(bRaw), 1e-6)
  const n1 = Math.max(Math.abs(n1Raw), 1e-6)
  const t1 = Math.abs(Math.cos((m * theta) / 4) / a) ** n2
  const t2 = Math.abs(Math.sin((m * theta) / 4) / b) ** n3
  const denom = (t1 + t2) ** (1 / n1)
  return denom > 1e-12 ? 1 / denom : 0
}

function measureGuideBaseExtents(
  guideType: RectGuideMorphSpec['guideType'],
  superellipseN: number,
  superformula: RectGuideMorphSpec['superformula'],
): { baseExtentX: number; baseExtentY: number } {
  let maxX = 0
  let maxY = 0

  for (let i = 0; i < RECT_GUIDE_SAMPLE_COUNT; i++) {
    const theta = (i / RECT_GUIDE_SAMPLE_COUNT) * Math.PI * 2
    const r = evaluateGuideBaseRadius(guideType, superellipseN, superformula, theta)
    const x = Math.abs(r * Math.cos(theta))
    const y = Math.abs(r * Math.sin(theta))
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }

  return {
    baseExtentX: Math.max(maxX, 1e-6),
    baseExtentY: Math.max(maxY, 1e-6),
  }
}

function resolveRectGuideMorphSpec(project: Project): RectGuideMorphSpec | null {
  const throatShape = stringFromConfig(project, '_athui.Designer.ThroatShape')?.toLowerCase() ?? null
  const hornGeometry = numberFromConfig(project, 'HornGeometry')
  const guideType = numberFromConfig(project, '_athui.Designer.GuideType') ?? numberFromConfig(project, 'GCurve.Type')
  if (guideType !== 1 && guideType !== 2) return null
  if (throatShape !== 'rect' && hornGeometry !== 2) return null

  const targetWidth =
    numberFromConfig(project, 'Morph.TargetWidth') ?? numberFromConfig(project, '_athui.Designer.MouthWidthMm')
  const targetHeight =
    numberFromConfig(project, 'Morph.TargetHeight') ?? numberFromConfig(project, '_athui.Designer.MouthHeightMm')
  if (targetWidth === null || targetHeight === null || targetWidth <= 0 || targetHeight <= 0) {
    return null
  }

  const guideWidth = numberFromConfig(project, 'GCurve.Width') ?? numberFromConfig(project, '_athui.Designer.GuideWidthMm')
  const guideHeight =
    numberFromConfig(project, '_athui.Designer.GuideHeightMm') ??
    ((guideWidth ?? 0) * (numberFromConfig(project, 'GCurve.AspectRatio') ?? 1))
  const guideDistRaw =
    numberFromConfig(project, 'GCurve.Dist') ??
    ((numberFromConfig(project, '_athui.Designer.GuideDistPercent') ?? 50) / 100)
  const guideRotDeg = numberFromConfig(project, 'GCurve.Rot') ?? 0
  const superellipseN = numberFromConfig(project, 'GCurve.SE.n') ?? numberFromConfig(project, '_athui.Designer.GuideSEN') ?? 3
  const superformula = parseGuideSuperformula(project.config['_athui.Designer.GuideSF'] ?? project.config['GCurve.SF'])

  if (guideWidth === null || guideHeight === null || guideWidth <= 0 || guideHeight <= 0) return null

  const { baseExtentX, baseExtentY } = measureGuideBaseExtents(guideType, superellipseN, superformula)

  return {
    guideType,
    guideWidth,
    guideHeight,
    guideDist: guideDistRaw,
    guideRotRad: (guideRotDeg * Math.PI) / 180,
    superellipseN,
    superformula,
    targetWidth,
    targetHeight,
    baseExtentX,
    baseExtentY,
  }
}

function resolveRectGuideMeshSpec(project: Project): RectGuideMeshSpec {
  const angularRaw = Math.round(numberFromConfig(project, 'Mesh.AngularSegments') ?? 192)
  const lengthRaw = Math.round(numberFromConfig(project, 'Mesh.LengthSegments') ?? 120)
  const cornerRaw = Math.round(numberFromConfig(project, 'Mesh.CornerSegments') ?? 0)
  const throatResolutionRaw = numberFromConfig(project, 'Mesh.ThroatResolution') ?? 1
  const mouthResolutionRaw = numberFromConfig(project, 'Mesh.MouthResolution') ?? throatResolutionRaw
  const angularSegments = Math.max(16, angularRaw - (angularRaw % 4))
  const lengthSegments = Math.max(8, lengthRaw)
  const cornerSegments = Math.max(0, Math.min(angularSegments - 4, cornerRaw))
  const throatResolution = Number.isFinite(throatResolutionRaw) && throatResolutionRaw > 1e-6 ? throatResolutionRaw : 1
  const mouthResolution = Number.isFinite(mouthResolutionRaw) && mouthResolutionRaw > 1e-6 ? mouthResolutionRaw : throatResolution
  return { angularSegments, lengthSegments, cornerSegments, throatResolution, mouthResolution }
}

function angleBinPosition(theta: number, binCount = RECT_GUIDE_ANGLE_BINS): number {
  return (normalizeAngleRad(theta) / (Math.PI * 2)) * binCount
}

function fillPolarLookup(radii: Float64Array) {
  const n = radii.length
  if (n === 0) return
  let last = -1
  for (let i = 0; i < n * 2; i++) {
    const idx = i % n
    if (radii[idx]! > 0) {
      if (last >= 0) {
        const gap = i - last
        const from = radii[last % n]!
        const to = radii[idx]!
        for (let step = 1; step < gap; step++) {
          const k = (last + step) % n
          if (radii[k]! > 0) continue
          const t = step / gap
          radii[k] = from + (to - from) * t
        }
      }
      last = i
    }
  }
  let fallback = 0
  for (const value of radii) {
    if (value > fallback) fallback = value
  }
  if (fallback <= 0) fallback = 1
  for (let i = 0; i < n; i++) {
    if (radii[i]! <= 0) radii[i] = fallback
  }
}

function polarLookupRadius(radii: Float64Array, theta: number): number {
  const binCount = radii.length
  if (binCount === 0) return 0
  const pos = angleBinPosition(theta, binCount)
  const i0 = Math.floor(pos) % binCount
  const i1 = (i0 + 1) % binCount
  const t = pos - Math.floor(pos)
  return radii[i0]! + (radii[i1]! - radii[i0]!) * t
}

function buildDimensionSlices(rows: XYRow[]): DimensionSlice[] {
  const groups = new Map<
    string,
    { zSum: number; count: number; minX: number; maxX: number; minY: number; maxY: number }
  >()
  for (const row of rows) {
    if (!Number.isFinite(row.x) || !Number.isFinite(row.y) || !Number.isFinite(row.z)) continue
    const key = row.z.toFixed(4)
    let group = groups.get(key)
    if (!group) {
      group = {
        zSum: 0,
        count: 0,
        minX: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      }
      groups.set(key, group)
    }
    group.zSum += row.z
    group.count++
    if (row.x < group.minX) group.minX = row.x
    if (row.x > group.maxX) group.maxX = row.x
    if (row.y < group.minY) group.minY = row.y
    if (row.y > group.maxY) group.maxY = row.y
  }

  return [...groups.values()]
    .map((group) => ({
      z: group.zSum / Math.max(group.count, 1),
      width: Math.max(group.maxX - group.minX, 1e-6),
      height: Math.max(group.maxY - group.minY, 1e-6),
    }))
    .sort((a, b) => a.z - b.z)
}

function buildBoundarySlices(rows: XYRow[]): BoundarySlice[] {
  const groups = new Map<string, { zSum: number; count: number; radii: Float64Array }>()
  for (const row of rows) {
    if (!Number.isFinite(row.x) || !Number.isFinite(row.y) || !Number.isFinite(row.z)) continue
    const key = row.z.toFixed(4)
    let group = groups.get(key)
    if (!group) {
      group = { zSum: 0, count: 0, radii: new Float64Array(RECT_GUIDE_ANGLE_BINS) }
      groups.set(key, group)
    }
    group.zSum += row.z
    group.count++
    const r = Math.hypot(row.x, row.y)
    const bin = Math.floor(angleBinPosition(Math.atan2(row.y, row.x))) % RECT_GUIDE_ANGLE_BINS
    if (r > group.radii[bin]!) group.radii[bin] = r
  }

  return [...groups.values()]
    .map((group) => {
      fillPolarLookup(group.radii)
      return { z: group.zSum / Math.max(group.count, 1), radii: group.radii }
    })
    .sort((a, b) => a.z - b.z)
}

function lookupBoundaryRadius(slices: BoundarySlice[], z: number, theta: number): number {
  if (slices.length === 0) return 0
  if (slices.length === 1) return polarLookupRadius(slices[0]!.radii, theta)
  if (z <= slices[0]!.z) return polarLookupRadius(slices[0]!.radii, theta)
  if (z >= slices[slices.length - 1]!.z) return polarLookupRadius(slices[slices.length - 1]!.radii, theta)

  for (let i = 1; i < slices.length; i++) {
    const prev = slices[i - 1]!
    const next = slices[i]!
    if (z > next.z) continue
    const span = Math.max(next.z - prev.z, 1e-6)
    const t = clamp01((z - prev.z) / span)
    const r0 = polarLookupRadius(prev.radii, theta)
    const r1 = polarLookupRadius(next.radii, theta)
    return r0 + (r1 - r0) * t
  }

  return polarLookupRadius(slices[slices.length - 1]!.radii, theta)
}

function lookupDimensionSlice(slices: DimensionSlice[], z: number): DimensionSlice {
  if (slices.length === 0) return { z, width: 1, height: 1 }
  if (slices.length === 1) return slices[0]!
  if (z <= slices[0]!.z) return slices[0]!
  if (z >= slices[slices.length - 1]!.z) return slices[slices.length - 1]!

  for (let i = 1; i < slices.length; i++) {
    const prev = slices[i - 1]!
    const next = slices[i]!
    if (z > next.z) continue
    const span = Math.max(next.z - prev.z, 1e-6)
    const t = clamp01((z - prev.z) / span)
    return {
      z,
      width: prev.width + (next.width - prev.width) * t,
      height: prev.height + (next.height - prev.height) * t,
    }
  }

  return slices[slices.length - 1]!
}

function resolveGuideStrength(spec: RectGuideMorphSpec, guideBase: DimensionSlice): number {
  const widthRatio = clamp01(spec.guideWidth / Math.max(guideBase.width, 1e-6))
  const heightRatio = clamp01(spec.guideHeight / Math.max(guideBase.height, 1e-6))
  const sizeHint = 1 - Math.min(widthRatio, heightRatio)
  return 0.25 + 0.75 * sizeHint
}

function resolveGuidePlaneZ(zMin: number, zMax: number, spec: RectGuideMorphSpec): number {
  const span = Math.max(zMax - zMin, 1e-6)
  const dist = spec.guideDist
  if (dist > 1) return Math.max(zMin, Math.min(zMin + dist, zMax))
  return zMin + clamp01(dist) * span
}

function rotateLoopPoints(points: XYRow[], startIndex: number): XYRow[] {
  if (points.length === 0) return []
  if (startIndex <= 0 || startIndex >= points.length) return points.map((point) => ({ ...point }))
  return points.slice(startIndex).concat(points.slice(0, startIndex)).map((point) => ({ ...point }))
}

function findLoopAnchorIndex(points: XYRow[]): number {
  let bestIndex = 0
  let bestScore = Number.NEGATIVE_INFINITY

  for (let i = 0; i < points.length; i++) {
    const point = points[i]!
    const score = point.x - Math.abs(point.y) * 1e-3
    if (score > bestScore) {
      bestScore = score
      bestIndex = i
    }
  }

  return bestIndex
}

function alignLoopPhase(points: XYRow[], reference?: XYRow[]): XYRow[] {
  if (!reference || reference.length !== points.length) {
    return rotateLoopPoints(points, findLoopAnchorIndex(points))
  }

  const step = Math.max(1, Math.floor(points.length / 48))
  let bestShift = 0
  let bestScore = Number.POSITIVE_INFINITY

  for (let shift = 0; shift < points.length; shift++) {
    let score = 0
    for (let i = 0; i < points.length; i += step) {
      const a = reference[i]!
      const b = points[(i + shift) % points.length]!
      const dx = a.x - b.x
      const dy = a.y - b.y
      score += dx * dx + dy * dy
      if (score >= bestScore) break
    }

    if (score < bestScore) {
      bestScore = score
      bestShift = shift
    }
  }

  return rotateLoopPoints(points, bestShift)
}

function normalizeLoopPoints(points: XYRow[], reference?: XYRow[]): XYRow[] {
  if (points.length < 3) return points.map((point) => ({ ...point }))

  const z = points.reduce((sum, point) => sum + point.z, 0) / points.length
  const centerX = points.reduce((sum, point) => sum + point.x, 0) / points.length
  const centerY = points.reduce((sum, point) => sum + point.y, 0) / points.length

  const ordered = points
    .map((point) => ({
      point,
      theta: normalizeAngleRad(Math.atan2(point.y - centerY, point.x - centerX)),
      radius: Math.hypot(point.x - centerX, point.y - centerY),
    }))
    .sort((a, b) => {
      const thetaDelta = a.theta - b.theta
      if (Math.abs(thetaDelta) > 1e-9) return thetaDelta
      return a.radius - b.radius
    })
    .map(({ point }) => ({ x: point.x, y: point.y, z: point.z }))

  const rotated = alignLoopPhase(ordered, reference)
  return rotated.map((point) => ({ x: point.x, y: point.y, z }))
}

function lookupGuideRadius(spec: RectGuideMorphSpec, width: number, height: number, theta: number): number {
  const scaleX = Math.max(width / 2, 1e-6) / Math.max(spec.baseExtentX, 1e-6)
  const scaleY = Math.max(height / 2, 1e-6) / Math.max(spec.baseExtentY, 1e-6)
  const localRayAngle = normalizeAngleRad(theta - spec.guideRotRad)
  const invX = Math.cos(localRayAngle) / scaleX
  const invY = Math.sin(localRayAngle) / scaleY
  const invLen = Math.hypot(invX, invY)
  if (invLen <= 1e-9) return Math.max(width, height) / 2

  const sourceTheta = Math.atan2(invY, invX)
  const baseRadius = evaluateGuideBaseRadius(spec.guideType, spec.superellipseN, spec.superformula, sourceTheta)
  return baseRadius / invLen
}

function transformRectGuideRows(rows: XYRow[], spec: RectGuideMorphSpec): XYRow[] | null {
  const slices = buildDimensionSlices(rows)
  const boundarySlices = buildBoundarySlices(rows)
  if (slices.length < 2 || boundarySlices.length < 2) return null

  const zMin = slices[0]!.z
  const zMax = slices[slices.length - 1]!.z
  const guideZ = resolveGuidePlaneZ(zMin, zMax, spec)
  const guideBase = lookupDimensionSlice(slices, guideZ)
  const guideStrength = resolveGuideStrength(spec, guideBase)

  let changed = false
  const transformed = rows.map((row) => {
    const dims = lookupDimensionSlice(slices, row.z)
    const theta = Math.atan2(row.y, row.x)
    const currentRadius = Math.hypot(row.x, row.y)
    const currentBoundary = lookupBoundaryRadius(boundarySlices, row.z, theta)
    if (!Number.isFinite(currentRadius) || currentRadius <= 1e-6 || !Number.isFinite(currentBoundary) || currentBoundary <= 1e-6) {
      return row
    }

    const targetWidth = dims.width
    const targetHeight = dims.height
    const guideBoundary = lookupGuideRadius(spec, targetWidth, targetHeight, theta)
    const shapeMix =
      guideStrength *
      (row.z <= guideZ
        ? smoothstep01((row.z - zMin) / Math.max(guideZ - zMin, 1e-6))
        : 1)
    const targetBoundary = currentBoundary + (guideBoundary - currentBoundary) * shapeMix
    const targetRadius = targetBoundary * (currentRadius / currentBoundary)
    const nextX = Math.cos(theta) * targetRadius
    const nextY = Math.sin(theta) * targetRadius
    if (Math.abs(nextX - row.x) > 1e-6 || Math.abs(nextY - row.y) > 1e-6) changed = true
    return { x: nextX, y: nextY, z: row.z }
  })

  return changed ? transformed : null
}

function rowsToSliceLoops(rows: XYRow[]): SliceLoop[] {
  const groups = new Map<string, XYRow[]>()
  for (const row of rows) {
    const key = row.z.toFixed(4)
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }

  const loops = [...groups.entries()]
    .map(([_, points]) => {
      const deduped = [...points]
      if (deduped.length > 2) {
        const first = deduped[0]!
        const last = deduped[deduped.length - 1]!
        if (
          Math.abs(first.x - last.x) <= 1e-6 &&
          Math.abs(first.y - last.y) <= 1e-6 &&
          Math.abs(first.z - last.z) <= 1e-6
        ) {
          deduped.pop()
        }
      }
      const z = deduped.reduce((sum, point) => sum + point.z, 0) / Math.max(deduped.length, 1)
      return { z, points: deduped }
    })
    .filter((loop) => loop.points.length >= 3)
    .sort((a, b) => a.z - b.z)

  const normalizedLoops: SliceLoop[] = []
  let prevPoints: XYRow[] | undefined
  for (const loop of loops) {
    const points = normalizeLoopPoints(loop.points, prevPoints)
    normalizedLoops.push({ z: loop.z, points })
    prevPoints = points
  }

  return normalizedLoops
}

async function readSliceLoopsCsv(srcPath: string): Promise<SliceLoop[] | null> {
  const raw = await fs.readFile(srcPath, 'utf8')
  const normalized = raw.replaceAll('\r\n', '\n')
  const lines = normalized.split('\n')
  let delimiter: ';' | ',' = ';'
  const rows: XYRow[] = []

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.includes(',')) delimiter = ','
    const parts = line.split(delimiter)
    if (parts.length < 3) continue
    const x = Number.parseFloat(parts[0] ?? '')
    const y = Number.parseFloat(parts[1] ?? '')
    const z = Number.parseFloat(parts[2] ?? '')
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    rows.push({ x, y, z })
  }

  if (rows.length < 12) return null
  return rowsToSliceLoops(rows)
}

function flattenSliceLoops(loops: SliceLoop[]): XYRow[] {
  const rows: XYRow[] = []
  for (const loop of loops) {
    rows.push(...loop.points)
  }
  return rows
}

function formatCsvNumber(value: number): string {
  return value.toFixed(6)
}

function writeSliceLoopsCsvText(loops: SliceLoop[]): string {
  const lines: string[] = []
  for (const loop of loops) {
    for (const point of loop.points) {
      lines.push(`${formatCsvNumber(point.x)};${formatCsvNumber(point.y)};${formatCsvNumber(loop.z)}`)
    }
    const first = loop.points[0]
    if (first) lines.push(`${formatCsvNumber(first.x)};${formatCsvNumber(first.y)};${formatCsvNumber(loop.z)}`)
  }
  return `${lines.join('\n')}\n`
}

async function writeSliceLoopsCsvFile(dstPath: string, loops: SliceLoop[]): Promise<boolean> {
  if (loops.length < 2) return false
  await fs.writeFile(dstPath, writeSliceLoopsCsvText(loops), 'utf8')
  return true
}

function writeProfilesCsvText(loops: SliceLoop[]): string {
  const lines = loops.map((loop, index) => {
    const maxX = loop.points.reduce((best, point) => Math.max(best, point.x), Number.NEGATIVE_INFINITY)
    const profileX = index === 0 ? 0 : maxX
    return `${formatCsvNumber(profileX)};0.000000;${formatCsvNumber(loop.z)}`
  })
  return `${lines.join('\n')}\n`
}

async function writeProfilesCsvFile(dstPath: string, loops: SliceLoop[]): Promise<boolean> {
  if (loops.length < 2) return false
  await fs.writeFile(dstPath, writeProfilesCsvText(loops), 'utf8')
  return true
}

function writeTriangleToBuffer(buf: Buffer, triIndex: number, a: XYRow, b: XYRow, c: XYRow) {
  const offset = 84 + triIndex * 50
  const abx = b.x - a.x
  const aby = b.y - a.y
  const abz = b.z - a.z
  const acx = c.x - a.x
  const acy = c.y - a.y
  const acz = c.z - a.z
  let nx = aby * acz - abz * acy
  let ny = abz * acx - abx * acz
  let nz = abx * acy - aby * acx
  const nLen = Math.hypot(nx, ny, nz)
  if (nLen > 1e-9) {
    nx /= nLen
    ny /= nLen
    nz /= nLen
  } else {
    nx = 0
    ny = 0
    nz = 0
  }

  buf.writeFloatLE(nx, offset + 0)
  buf.writeFloatLE(ny, offset + 4)
  buf.writeFloatLE(nz, offset + 8)

  const vertices = [a, b, c]
  for (let i = 0; i < vertices.length; i++) {
    const vertex = vertices[i]!
    const vOffset = offset + 12 + i * 12
    buf.writeFloatLE(vertex.x, vOffset + 0)
    buf.writeFloatLE(vertex.y, vOffset + 4)
    buf.writeFloatLE(vertex.z, vOffset + 8)
  }

  buf.writeUInt16LE(0, offset + 48)
}

function interpolateMeshResolutionAtZ(mesh: RectGuideMeshSpec, zMin: number, zMax: number, z: number): number {
  if (Math.abs(zMax - zMin) <= 1e-9) return Math.max(mesh.mouthResolution, 1e-6)
  const t = clamp01((z - zMin) / (zMax - zMin))
  return Math.max(mesh.throatResolution + (mesh.mouthResolution - mesh.throatResolution) * t, 1e-6)
}

function measureLoopPerimeter(points: readonly XYRow[]): number {
  if (points.length < 2) return 0
  let perimeter = 0
  for (let index = 0; index < points.length; index++) {
    const a = points[index]!
    const b = points[(index + 1) % points.length]!
    perimeter += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return perimeter
}

function resolvePerimeterSampleCount(loops: SliceLoop[], mesh: RectGuideMeshSpec): number {
  if (loops.length === 0) return mesh.angularSegments

  const zMin = loops[0]!.z
  const zMax = loops[loops.length - 1]!.z
  let required = mesh.angularSegments

  for (const loop of loops) {
    required = Math.max(required, loop.points.length)
    const perimeter = measureLoopPerimeter(loop.points)
    if (!Number.isFinite(perimeter) || perimeter <= 1e-6) continue
    const resolution = interpolateMeshResolutionAtZ(mesh, zMin, zMax, loop.z)
    required = Math.max(required, perimeter / resolution)
  }

  const rounded = Math.max(16, Math.ceil(required / 4) * 4)
  return Math.min(2048, rounded)
}

function estimateAxialIntervalComplexity(
  prev: SliceLoop,
  next: SliceLoop,
  mesh: RectGuideMeshSpec,
  zMin: number,
  zMax: number,
): number {
  const pointCount = Math.min(prev.points.length, next.points.length)
  if (pointCount <= 0) return 1

  const distances: number[] = []
  for (let index = 0; index < pointCount; index++) {
    const a = prev.points[index]!
    const b = next.points[index]!
    distances.push(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z))
  }

  distances.sort((a, b) => a - b)
  const p95Index = Math.min(distances.length - 1, Math.floor((distances.length - 1) * 0.95))
  const p95Distance = distances[p95Index] ?? 0
  const meanDistance = distances.reduce((sum, value) => sum + value, 0) / Math.max(distances.length, 1)
  const representativeDistance = Math.max(p95Distance, meanDistance)
  const midZ = (prev.z + next.z) * 0.5
  const resolution = interpolateMeshResolutionAtZ(mesh, zMin, zMax, midZ)
  return Math.max(1, representativeDistance / Math.max(resolution, 1e-6))
}

function resolveAxialSampleCount(loops: SliceLoop[], mesh: RectGuideMeshSpec): number {
  if (loops.length < 2) return Math.max(2, mesh.lengthSegments + 1)

  const zMin = loops[0]!.z
  const zMax = loops[loops.length - 1]!.z
  let required = mesh.lengthSegments + 1

  for (let index = 0; index < loops.length - 1; index++) {
    const prev = loops[index]!
    const next = loops[index + 1]!
    required += Math.max(0, estimateAxialIntervalComplexity(prev, next, mesh, zMin, zMax) - 1)
  }

  return Math.min(2048, Math.max(mesh.lengthSegments + 1, Math.ceil(required)))
}

function buildAxialSamplePositions(loops: SliceLoop[], mesh: RectGuideMeshSpec): number[] {
  if (loops.length === 0) return []
  if (loops.length === 1) return [loops[0]!.z]

  const zMin = loops[0]!.z
  const zMax = loops[loops.length - 1]!.z
  const targetCount = resolveAxialSampleCount(loops, mesh)
  if (targetCount <= 1) return [zMin]

  const cumulative = new Float64Array(loops.length)
  for (let index = 1; index < loops.length; index++) {
    const prev = loops[index - 1]!
    const next = loops[index]!
    cumulative[index] =
      cumulative[index - 1]! + estimateAxialIntervalComplexity(prev, next, mesh, zMin, zMax)
  }

  const total = cumulative[cumulative.length - 1]!
  if (!Number.isFinite(total) || total <= 1e-9) {
    return Array.from(
      { length: targetCount },
      (_, index) => zMin + ((zMax - zMin) * index) / Math.max(targetCount - 1, 1),
    )
  }

  const positions: number[] = []
  let upperIndex = 1
  for (let index = 0; index < targetCount; index++) {
    const targetMass = (index / Math.max(targetCount - 1, 1)) * total
    while (upperIndex < cumulative.length && cumulative[upperIndex]! < targetMass) upperIndex++
    const nextIndex = Math.min(upperIndex, loops.length - 1)
    const prevIndex = Math.max(0, nextIndex - 1)
    const prevMass = cumulative[prevIndex]!
    const nextMass = cumulative[nextIndex]!
    const span = Math.max(nextMass - prevMass, 1e-9)
    const t = clamp01((targetMass - prevMass) / span)
    const prevZ = loops[prevIndex]!.z
    const nextZ = loops[nextIndex]!.z
    positions.push(prevZ + (nextZ - prevZ) * t)
  }

  return positions
}

function buildPerimeterSampleAngles(targetCount: number, mesh: RectGuideMeshSpec, rotationRad = 0): number[] {
  if (targetCount <= 0) return []

  const cornerShare = mesh.cornerSegments > 0 ? mesh.cornerSegments / Math.max(mesh.angularSegments, 1) : 0
  if (cornerShare <= 1e-6) {
    return Array.from({ length: targetCount }, (_, index) => normalizeAngleRad(rotationRad + (index / targetCount) * Math.PI * 2))
  }

  const cornerBoost = Math.min(4, cornerShare * 3)
  const cornerWidth = Math.PI / 16
  const cornerCenters = [0, 1, 2, 3].map((index) => normalizeAngleRad(rotationRad + Math.PI / 4 + index * (Math.PI / 2)))
  const sampleCount = Math.max(2048, targetCount * 8)
  const cumulative = new Float64Array(sampleCount + 1)

  function cornerDensity(theta: number): number {
    let density = 1
    for (const center of cornerCenters) {
      let delta = normalizeAngleRad(theta - center)
      if (delta > Math.PI) delta -= Math.PI * 2
      density += cornerBoost * Math.exp(-0.5 * (delta / cornerWidth) ** 2)
    }
    return density
  }

  let prevDensity = cornerDensity(rotationRad)
  for (let i = 1; i <= sampleCount; i++) {
    const theta = rotationRad + (i / sampleCount) * Math.PI * 2
    const density = cornerDensity(theta)
    cumulative[i] = cumulative[i - 1]! + ((prevDensity + density) * 0.5) / sampleCount
    prevDensity = density
  }

  const total = cumulative[sampleCount]!
  if (!Number.isFinite(total) || total <= 1e-9) {
    return Array.from({ length: targetCount }, (_, index) => normalizeAngleRad(rotationRad + (index / targetCount) * Math.PI * 2))
  }

  const angles: number[] = []
  let sampleIndex = 1
  for (let i = 0; i < targetCount; i++) {
    const targetMass = (i / targetCount) * total
    while (sampleIndex < cumulative.length && cumulative[sampleIndex]! < targetMass) sampleIndex++
    const upperIndex = Math.min(sampleIndex, sampleCount)
    const lowerIndex = Math.max(0, upperIndex - 1)
    const lowerMass = cumulative[lowerIndex]!
    const upperMass = cumulative[upperIndex]!
    const span = Math.max(upperMass - lowerMass, 1e-9)
    const localT = clamp01((targetMass - lowerMass) / span)
    const theta = rotationRad + ((lowerIndex + localT) / sampleCount) * Math.PI * 2
    angles.push(normalizeAngleRad(theta))
  }

  return angles
}

function buildLoopPolarLookup(points: XYRow[], binCount: number): {
  centerX: number
  centerY: number
  z: number
  radii: Float64Array
} {
  const centerX = points.reduce((sum, point) => sum + point.x, 0) / Math.max(points.length, 1)
  const centerY = points.reduce((sum, point) => sum + point.y, 0) / Math.max(points.length, 1)
  const z = points.reduce((sum, point) => sum + point.z, 0) / Math.max(points.length, 1)
  const radii = new Float64Array(binCount)

  for (const point of points) {
    const theta = Math.atan2(point.y - centerY, point.x - centerX)
    const radius = Math.hypot(point.x - centerX, point.y - centerY)
    const bin = Math.floor(angleBinPosition(theta, binCount)) % binCount
    if (radius > radii[bin]!) radii[bin] = radius
  }

  fillPolarLookup(radii)
  return { centerX, centerY, z, radii }
}

function resampleLoopPoints(points: XYRow[], targetAngles: readonly number[]): XYRow[] {
  if (points.length === 0 || targetAngles.length === 0) return []

  const lookup = buildLoopPolarLookup(points, Math.max(RECT_GUIDE_ANGLE_BINS, targetAngles.length * 8))
  return targetAngles.map((theta) => {
    const radius = polarLookupRadius(lookup.radii, theta)
    return {
      x: lookup.centerX + Math.cos(theta) * radius,
      y: lookup.centerY + Math.sin(theta) * radius,
      z: lookup.z,
    }
  })
}

function resampleSliceLoops(loops: SliceLoop[], mesh: RectGuideMeshSpec, rotationRad = 0): SliceLoop[] {
  if (loops.length < 2) return loops

  const targetPointCount = resolvePerimeterSampleCount(loops, mesh)
  const targetAngles = buildPerimeterSampleAngles(targetPointCount, mesh, rotationRad)
  const resampledPerimeter: SliceLoop[] = []
  for (const loop of loops) {
    const points = resampleLoopPoints(loop.points, targetAngles)
    resampledPerimeter.push({ z: loop.z, points })
  }

  const pointCount = resampledPerimeter[0]!.points.length
  const targetZs = buildAxialSamplePositions(resampledPerimeter, mesh)
  const loopsOut: SliceLoop[] = []

  for (const z of targetZs) {
    let upperIndex = 1
    while (upperIndex < resampledPerimeter.length && resampledPerimeter[upperIndex]!.z < z) upperIndex++
    const nextIndex = Math.min(upperIndex, resampledPerimeter.length - 1)
    const prevIndex = Math.max(0, nextIndex - 1)
    const prev = resampledPerimeter[prevIndex]!
    const next = resampledPerimeter[nextIndex]!
    const span = Math.max(next.z - prev.z, 1e-9)
    const t = prevIndex === nextIndex ? 0 : clamp01((z - prev.z) / span)
    const points: XYRow[] = []

    for (let p = 0; p < pointCount; p++) {
      const a = prev.points[p]!
      const b = next.points[p]!
      points.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z,
      })
    }

    loopsOut.push({ z, points })
  }

  return loopsOut
}

async function writeStlFromSliceLoops(dstPath: string, loops: SliceLoop[]): Promise<boolean> {
  if (loops.length < 2) return false
  const pointCount = loops[0]?.points.length ?? 0
  if (pointCount < 3) return false
  if (!loops.every((loop) => loop.points.length === pointCount)) return false

  const triCount = (loops.length - 1) * pointCount * 2
  const buf = Buffer.alloc(84 + triCount * 50)
  buf.write('athui rect guide', 0, 'ascii')
  buf.writeUInt32LE(triCount, 80)

  let triIndex = 0
  for (let loopIndex = 0; loopIndex < loops.length - 1; loopIndex++) {
    const curr = loops[loopIndex]!.points
    const next = loops[loopIndex + 1]!.points
    for (let i = 0; i < pointCount; i++) {
      const iNext = (i + 1) % pointCount
      const a = curr[i]!
      const b = next[i]!
      const c = curr[iNext]!
      const d = next[iNext]!
      writeTriangleToBuffer(buf, triIndex++, a, b, c)
      writeTriangleToBuffer(buf, triIndex++, c, b, d)
    }
  }

  await fs.writeFile(dstPath, buf)
  return true
}

function transformRectGuideLoops(loops: SliceLoop[], spec: RectGuideMorphSpec, mesh: RectGuideMeshSpec): SliceLoop[] | null {
  if (loops.length < 2) return null

  const sourceRows = flattenSliceLoops(loops)
  const dimSlices = buildDimensionSlices(sourceRows)
  const boundarySlices = buildBoundarySlices(sourceRows)
  if (dimSlices.length < 2 || boundarySlices.length < 2) return null

  const zMin = dimSlices[0]!.z
  const zMax = dimSlices[dimSlices.length - 1]!.z
  const guideZ = resolveGuidePlaneZ(zMin, zMax, spec)
  const guideBase = lookupDimensionSlice(dimSlices, guideZ)
  const mouthBase = lookupDimensionSlice(dimSlices, zMax)
  const guideTargetWidth = Math.max(guideBase.width, Math.min(spec.guideWidth, spec.targetWidth))
  const guideTargetHeight = Math.max(guideBase.height, Math.min(spec.guideHeight, spec.targetHeight))
  const guideScaleX = guideTargetWidth / Math.max(guideBase.width, 1e-6)
  const guideScaleY = guideTargetHeight / Math.max(guideBase.height, 1e-6)
  const mouthScaleX = spec.targetWidth / Math.max(mouthBase.width, 1e-6)
  const mouthScaleY = spec.targetHeight / Math.max(mouthBase.height, 1e-6)

  const scaledRows = sourceRows.map((row) => {
    const scaleX =
      guideZ <= zMin + 1e-6
        ? 1 + (mouthScaleX - 1) * smoothstep01((row.z - zMin) / Math.max(zMax - zMin, 1e-6))
        : row.z <= guideZ
          ? 1 + (guideScaleX - 1) * smoothstep01((row.z - zMin) / Math.max(guideZ - zMin, 1e-6))
          : guideScaleX + (mouthScaleX - guideScaleX) * smoothstep01((row.z - guideZ) / Math.max(zMax - guideZ, 1e-6))
    const scaleY =
      guideZ <= zMin + 1e-6
        ? 1 + (mouthScaleY - 1) * smoothstep01((row.z - zMin) / Math.max(zMax - zMin, 1e-6))
        : row.z <= guideZ
          ? 1 + (guideScaleY - 1) * smoothstep01((row.z - zMin) / Math.max(guideZ - zMin, 1e-6))
          : guideScaleY + (mouthScaleY - guideScaleY) * smoothstep01((row.z - guideZ) / Math.max(zMax - guideZ, 1e-6))
    return { x: row.x * scaleX, y: row.y * scaleY, z: row.z }
  })

  const scaledLoops: SliceLoop[] = []
  let rowIndex = 0
  for (const loop of loops) {
    const points = loop.points.map(() => scaledRows[rowIndex++]!)
    scaledLoops.push({ z: loop.z, points })
  }

  const scaledDims = buildDimensionSlices(scaledRows)
  const scaledBoundary = buildBoundarySlices(scaledRows)

  const transformed = scaledLoops.map((loop) => {
    const dims = lookupDimensionSlice(scaledDims, loop.z)
    const alpha =
      loop.z <= guideZ
        ? smoothstep01((loop.z - zMin) / Math.max(guideZ - zMin, 1e-6))
        : 1
    const points = loop.points.map((point) => {
      const theta = Math.atan2(point.y, point.x)
      const currentRadius = Math.hypot(point.x, point.y)
      const currentBoundary = lookupBoundaryRadius(scaledBoundary, loop.z, theta)
      if (!Number.isFinite(currentRadius) || currentRadius <= 1e-6 || !Number.isFinite(currentBoundary) || currentBoundary <= 1e-6) {
        return point
      }

      const guideBoundary = lookupGuideRadius(spec, dims.width, dims.height, theta)
      const targetBoundary = currentBoundary + (guideBoundary - currentBoundary) * alpha
      const targetRadius = targetBoundary * (currentRadius / currentBoundary)
      return { x: Math.cos(theta) * targetRadius, y: Math.sin(theta) * targetRadius, z: loop.z }
    })
    return { z: loop.z, points }
  })

  return resampleSliceLoops(transformed, mesh, spec.guideRotRad)
}

async function applyRectGuideMorphToStlFile(srcPath: string, spec: RectGuideMorphSpec): Promise<boolean> {
  const buf = await fs.readFile(srcPath)
  if (!isBinaryStl(buf)) return false

  const triCount = buf.readUInt32LE(80)
  if (triCount <= 0) return false

  const rows: XYRow[] = []
  for (let i = 0; i < triCount; i++) {
    const triOffset = 84 + i * 50
    for (let v = 0; v < 3; v++) {
      const vertexOffset = triOffset + 12 + v * 12
      rows.push({
        x: buf.readFloatLE(vertexOffset),
        y: buf.readFloatLE(vertexOffset + 4),
        z: buf.readFloatLE(vertexOffset + 8),
      })
    }
  }

  const transformed = transformRectGuideRows(rows, spec)
  if (!transformed) return false

  const out = Buffer.from(buf)
  let rowIndex = 0
  for (let i = 0; i < triCount; i++) {
    const triOffset = 84 + i * 50
    const vertices: [number, number, number][] = []

    for (let v = 0; v < 3; v++) {
      const vertexOffset = triOffset + 12 + v * 12
      const next = transformed[rowIndex++]!
      const nextX = next.x
      const nextY = next.y
      const z = next.z
      out.writeFloatLE(nextX, vertexOffset)
      out.writeFloatLE(nextY, vertexOffset + 4)
      vertices.push([nextX, nextY, z])
    }

    const [v1, v2, v3] = vertices
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

  await fs.writeFile(srcPath, out)
  return true
}

async function applyRectGuideMorphToCsvFile(srcPath: string, spec: RectGuideMorphSpec): Promise<boolean> {
  const raw = await fs.readFile(srcPath, 'utf8')
  const normalized = raw.replaceAll('\r\n', '\n')
  const lines = normalized.split('\n')

  let delimiter: ';' | ',' = ';'
  const rows: XYRow[] = []
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.includes(',')) delimiter = ','
    const parts = line.split(delimiter)
    if (parts.length < 3) continue
    const x = Number.parseFloat(parts[0] ?? '')
    const y = Number.parseFloat(parts[1] ?? '')
    const z = Number.parseFloat(parts[2] ?? '')
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    rows.push({ x, y, z })
  }

  if (rows.length < 10) return false
  const transformed = transformRectGuideRows(rows, spec)
  if (!transformed) return false

  let rowIndex = 0
  const outLines = lines.map((rawLine) => {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) return rawLine
    const parts = line.split(delimiter)
    if (parts.length < 3) return rawLine
    const x = Number.parseFloat(parts[0] ?? '')
    const y = Number.parseFloat(parts[1] ?? '')
    const z = Number.parseFloat(parts[2] ?? '')
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return rawLine

    const next = transformed[rowIndex++]!
    return `${next.x.toFixed(6)}${delimiter}${next.y.toFixed(6)}${delimiter}${next.z.toFixed(6)}`
  })

  await fs.writeFile(srcPath, outLines.join('\n').replace(/\n+$/, '\n'), 'utf8')
  return true
}

async function applyRectGuideMorphPostProcess(project: Project, outputsDir: string) {
  const spec = resolveRectGuideMorphSpec(project)
  if (!spec) return
  const mesh = resolveRectGuideMeshSpec(project)

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
    appendLogs(project, [`[athui] rect-guide scan failed: ${message}`])
    return
  }

  const stlFiles = files.filter((filePath) => {
    const lower = filePath.toLowerCase()
    return lower.endsWith('.stl') && !lower.includes('bem_mesh') && !isRollbackDerivedFilePath(lower)
  })
  const csvFiles = files.filter((filePath) => {
    const lower = filePath.toLowerCase()
    if (!lower.endsWith('.csv')) return false
    if (!lower.includes('profiles') && !lower.includes('slices')) return false
    if (isRollbackDerivedFilePath(lower)) return false
    return true
  })
  const sliceFiles = csvFiles.filter((filePath) => filePath.toLowerCase().includes('slices'))
  const profileFiles = csvFiles.filter((filePath) => filePath.toLowerCase().includes('profiles'))

  let applied = 0
  try {
    const primarySliceFile = sliceFiles[0]
    if (!primarySliceFile) return
    const loops = await readSliceLoopsCsv(primarySliceFile)
    if (!loops || loops.length < 2) return
    const transformed = transformRectGuideLoops(loops, spec, mesh)
    if (!transformed) return

    for (const filePath of sliceFiles) {
      if (await writeSliceLoopsCsvFile(filePath, transformed)) applied++
    }
    for (const filePath of profileFiles) {
      if (await writeProfilesCsvFile(filePath, transformed)) applied++
    }
    for (const filePath of stlFiles) {
      if (await writeStlFromSliceLoops(filePath, transformed)) applied++
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendLogs(project, [`[athui] rect-guide post-process failed: ${message}`])
    return
  }

  if (applied > 0) {
    appendLogs(project, [
      `[athui] rect-guide warp applied: guide ${spec.guideWidth.toFixed(1)} x ${spec.guideHeight.toFixed(1)} -> mouth ${spec.targetWidth.toFixed(1)} x ${spec.targetHeight.toFixed(1)} mm, updated ${applied} file${applied === 1 ? '' : 's'}`,
    ])
  }
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
  await fs.writeFile(definitionPath, ensureGridExportProfiles(sanitized), 'utf8')

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
        await applyRectGuideMorphPostProcess(project, outputsDir)
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
