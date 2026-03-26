import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { createProject, runProject, updateProjectConfig } from '../apps/server/src/projects.ts'
import { defaultSchema } from '../apps/app-b/src/schema/defaultSchema.ts'
import { buildProjectCfgText } from '../apps/app-b/src/schema/cfg.ts'

type Variant = {
  name: string
  overrides: Record<string, unknown>
}

type FileHash = {
  size: number
  sha256: string
}

type XYRow = {
  x: number
  y: number
  z: number
}

type SliceLoop = {
  z: number
  points: XYRow[]
}

type SliceLoopPhaseStats = {
  meanAngleDriftDeg: number
  maxAngleDriftDeg: number
}

type LateralStripStats = {
  p95: number
  max: number
}

function defaultValues(): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(defaultSchema.items)) {
    if (spec.default !== undefined) values[key] = spec.default
  }
  return values
}

function createRectGuideBaseline(): Record<string, unknown> {
  const values = defaultValues()
  return {
    ...values,
    HornGeometry: 2,
    'Horn.Adapter.Width': 28,
    'Horn.Adapter.Height': 121.5,
    'Horn.Adapter.k': 0,
    'Horn.Adapter.Length': 0,
    'Horn.Adapter.Segments': 0,
    'Throat.Profile': 1,
    'Throat.Diameter': 25.4,
    'Throat.Angle': '7',
    Length: '100',
    'GCurve.Type': 2,
    'GCurve.Dist': '0.5',
    'GCurve.Width': 68,
    'GCurve.AspectRatio': 1,
    'GCurve.SF': '1,1,4,0.8,8,2',
    'GCurve.Rot': 0,
    'Morph.TargetShape': 1,
    'Morph.TargetWidth': 228,
    'Morph.TargetHeight': 236.97005383792515,
    'Morph.CornerRadius': 0,
    'Morph.FixedPart': '0',
    'Morph.Rate': '3',
    'Morph.AllowShrinkage': true,
    'Mesh.Quadrants': 1,
    '_athui.MeshQuality': 'custom',
    'Mesh.AngularSegments': 192,
    'Mesh.LengthSegments': 120,
    'Mesh.CornerSegments': 32,
    'Mesh.ThroatResolution': 0.5,
    'Mesh.MouthResolution': 1.5,
    'ABEC.SimType': 1,
    'ABEC.f1': 1000,
    'ABEC.f2': 10000,
    'ABEC.NumFrequencies': 20,
    'ABEC.Abscissa': 1,
    'Source.Shape': 1,
    'Source.Velocity': 1,
    'Output.STL': true,
    'Output.ABECProject': true,
    '_athui.Designer.ThroatShape': 'rect',
    '_athui.Designer.Mode': 'rect',
    '_athui.Designer.GuideType': 2,
    '_athui.Designer.GuideWidthMm': 68,
    '_athui.Designer.GuideHeightMm': 68,
    '_athui.Designer.GuideDistPercent': 50,
    '_athui.Designer.GuideSEN': 3,
    '_athui.Designer.GuideSF': '1,1,4,0.8,8,2',
    '_athui.Designer.CoverageH': 90,
    '_athui.Designer.CoverageV': 60,
    '_athui.Designer.SizeMode': 'depth',
    '_athui.Designer.DepthMm': 100,
    '_athui.Designer.MouthWidthMm': 228,
    '_athui.Designer.MouthHeightMm': 236.97005383792515,
  }
}

async function hashFile(filePath: string): Promise<FileHash> {
  const buf = await fs.readFile(filePath)
  return {
    size: buf.byteLength,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  }
}

async function waitForRectGuideOutputs(project: Awaited<ReturnType<typeof createProject>>) {
  const started = Date.now()
  while (true) {
    const processDone = project.process === null
    const warpLogged = project.logs.some((line) => line.includes('rect-guide warp applied'))
    if (processDone && warpLogged) return
    if (Date.now() - started > 180000) {
      throw new Error(`Timed out waiting for rect-guide post-process in ${project.dir}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

async function readSliceLoops(filePath: string): Promise<SliceLoop[]> {
  const raw = await fs.readFile(filePath, 'utf8')
  const rows: XYRow[] = []

  for (const rawLine of raw.replaceAll('\r\n', '\n').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(line.includes(',') ? ',' : ';')
    if (parts.length < 3) continue
    const x = Number.parseFloat(parts[0] ?? '')
    const y = Number.parseFloat(parts[1] ?? '')
    const z = Number.parseFloat(parts[2] ?? '')
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    rows.push({ x, y, z })
  }

  const groups = new Map<string, XYRow[]>()
  for (const row of rows) {
    const key = row.z.toFixed(4)
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }

  return [...groups.values()]
    .map((points) => {
      const deduped = [...points]
      if (deduped.length > 1) {
        const first = deduped[0]
        const last = deduped[deduped.length - 1]
        if (
          first &&
          last &&
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
}

function normalizeAngleRad(theta: number): number {
  const tau = Math.PI * 2
  let out = theta % tau
  if (out < 0) out += tau
  return out
}

function shortestAngleDeltaRad(a: number, b: number): number {
  let delta = normalizeAngleRad(a - b)
  if (delta > Math.PI) delta -= Math.PI * 2
  return delta
}

async function measureSliceLoopPhaseStats(filePath: string): Promise<SliceLoopPhaseStats> {
  const loops = await readSliceLoops(filePath)
  const pointCount = loops[0]?.points.length ?? 0
  if (loops.length < 2 || pointCount < 3) {
    return { meanAngleDriftDeg: 0, maxAngleDriftDeg: 0 }
  }

  const baseLoop = loops[0]!
  const baseCenterX = baseLoop.points.reduce((sum, point) => sum + point.x, 0) / baseLoop.points.length
  const baseCenterY = baseLoop.points.reduce((sum, point) => sum + point.y, 0) / baseLoop.points.length
  const driftsDeg: number[] = []

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    const basePoint = baseLoop.points[pointIndex]
    if (!basePoint) continue
    const baseTheta = Math.atan2(basePoint.y - baseCenterY, basePoint.x - baseCenterX)
    let sumSq = 0
    let samples = 0

    for (const loop of loops) {
      const point = loop.points[pointIndex]
      if (!point) continue
      const centerX = loop.points.reduce((sum, row) => sum + row.x, 0) / loop.points.length
      const centerY = loop.points.reduce((sum, row) => sum + row.y, 0) / loop.points.length
      const theta = Math.atan2(point.y - centerY, point.x - centerX)
      const delta = shortestAngleDeltaRad(theta, baseTheta)
      sumSq += delta * delta
      samples++
    }

    if (samples > 0) driftsDeg.push((Math.sqrt(sumSq / samples) * 180) / Math.PI)
  }

  return {
    meanAngleDriftDeg: driftsDeg.reduce((sum, value) => sum + value, 0) / Math.max(driftsDeg.length, 1),
    maxAngleDriftDeg: Math.max(...driftsDeg, 0),
  }
}

async function measureMouthLoopPointCount(filePath: string): Promise<number> {
  const loops = await readSliceLoops(filePath)
  return loops[loops.length - 1]?.points.length ?? 0
}

async function measureLateralStripStats(filePath: string): Promise<LateralStripStats> {
  const loops = await readSliceLoops(filePath)
  const distances: number[] = []

  for (let loopIndex = 0; loopIndex < loops.length - 1; loopIndex++) {
    const prev = loops[loopIndex]!
    const next = loops[loopIndex + 1]!
    const pointCount = Math.min(prev.points.length, next.points.length)
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
      const a = prev.points[pointIndex]!
      const b = next.points[pointIndex]!
      distances.push(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z))
    }
  }

  if (distances.length === 0) return { p95: 0, max: 0 }
  distances.sort((a, b) => a - b)
  const p95Index = Math.min(distances.length - 1, Math.floor((distances.length - 1) * 0.95))
  return {
    p95: distances[p95Index] ?? 0,
    max: distances[distances.length - 1] ?? 0,
  }
}

async function runVariant(variant: Variant) {
  const project = await createProject()
  const values = { ...createRectGuideBaseline(), ...variant.overrides }
  const { text, errors } = buildProjectCfgText(defaultSchema, values, { includeAdvanced: false })
  assert.equal(errors.length, 0, `${variant.name}: ${errors.join('; ')}`)

  await updateProjectConfig(project, { ...values, '_athui.cfgText': text })
  await runProject(project)
  await waitForRectGuideOutputs(project)

  const outputsRoot = path.join(project.dir, 'outputs', 'project')
  return {
    name: variant.name,
    dir: project.dir,
    slicesPath: path.join(outputsRoot, 'project_slices_athui.csv'),
    projectStl: await hashFile(path.join(outputsRoot, 'project.stl')),
    profilesCsv: await hashFile(path.join(outputsRoot, 'project_profiles_athui.csv')),
    slicesCsv: await hashFile(path.join(outputsRoot, 'project_slices_athui.csv')),
  }
}

function sameHash(a: FileHash, b: FileHash): boolean {
  return a.size === b.size && a.sha256 === b.sha256
}

function extractSimpleRectPartSegments(cfgText: string): number | null {
  const match = cfgText.match(/Horn\.Part:1\s*=\s*\{[\s\S]*?\n\s*Segments\s*=\s*(\d+)/)
  if (!match) return null
  const parsed = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(parsed) ? parsed : null
}

async function main() {
  const variants: Variant[] = [
    { name: 'baseline', overrides: {} },
    { name: 'angular-segments', overrides: { 'Mesh.AngularSegments': 320 } },
    { name: 'length-segments', overrides: { 'Mesh.LengthSegments': 240 } },
    { name: 'corner-segments', overrides: { 'Mesh.CornerSegments': 48 } },
    { name: 'throat-resolution', overrides: { 'Mesh.ThroatResolution': 0.2 } },
    { name: 'mouth-resolution', overrides: { 'Mesh.MouthResolution': 0.4 } },
    {
      name: 'high-density-smoothness',
      overrides: {
        'Mesh.AngularSegments': 600,
        'Mesh.LengthSegments': 440,
        'Mesh.CornerSegments': 400,
        'Mesh.ThroatResolution': 0.3,
        'Mesh.MouthResolution': 0.4,
      },
    },
  ]

  const baselineValues = createRectGuideBaseline()
  const { text: baselineCfgText, errors: baselineCfgErrors } = buildProjectCfgText(defaultSchema, baselineValues, {
    includeAdvanced: false,
  })
  assert.equal(baselineCfgErrors.length, 0, baselineCfgErrors.join('; '))
  assert.equal(extractSimpleRectPartSegments(baselineCfgText), 120, 'simple rect builder should follow Mesh.LengthSegments')

  const lengthOverrideValues = { ...baselineValues, 'Mesh.LengthSegments': 240 }
  const { text: lengthCfgText, errors: lengthCfgErrors } = buildProjectCfgText(defaultSchema, lengthOverrideValues, {
    includeAdvanced: false,
  })
  assert.equal(lengthCfgErrors.length, 0, lengthCfgErrors.join('; '))
  assert.equal(extractSimpleRectPartSegments(lengthCfgText), 240, 'simple rect builder should track updated Mesh.LengthSegments')

  const baseline = await runVariant(variants[0]!)
  const baselinePhaseStats = await measureSliceLoopPhaseStats(baseline.slicesPath)
  const baselineMouthPointCount = await measureMouthLoopPointCount(baseline.slicesPath)
  const baselineLateralStats = await measureLateralStripStats(baseline.slicesPath)
  assert.ok(
    baselinePhaseStats.meanAngleDriftDeg < 0.01,
    `baseline rect-guide slice drift too high: mean ${baselinePhaseStats.meanAngleDriftDeg.toFixed(4)} deg`,
  )
  assert.ok(
    baselineMouthPointCount > 192,
    `baseline mouth refinement too low: expected more than 192 perimeter points, received ${baselineMouthPointCount}`,
  )
  assert.ok(
    baselineLateralStats.max < 4,
    `baseline rect-guide lateral strip too large: max ${baselineLateralStats.max.toFixed(4)} mm`,
  )
  const failures: string[] = []

  for (const variant of variants.slice(1)) {
    const result = await runVariant(variant)
    const changed =
      !sameHash(result.projectStl, baseline.projectStl) ||
      !sameHash(result.profilesCsv, baseline.profilesCsv) ||
      !sameHash(result.slicesCsv, baseline.slicesCsv)

    if (!changed) failures.push(`${variant.name} did not change any rect-guide horn outputs`)
    if (variant.name === 'high-density-smoothness') {
      const phaseStats = await measureSliceLoopPhaseStats(result.slicesPath)
      const mouthPointCount = await measureMouthLoopPointCount(result.slicesPath)
      const lateralStats = await measureLateralStripStats(result.slicesPath)
      if (phaseStats.meanAngleDriftDeg >= 0.01) {
        failures.push(
          `${variant.name} slice drift too high: mean ${phaseStats.meanAngleDriftDeg.toFixed(4)} deg (max ${phaseStats.maxAngleDriftDeg.toFixed(4)} deg)`,
        )
      }
      if (mouthPointCount <= 600) {
        failures.push(`${variant.name} mouth refinement too low: expected more than 600 perimeter points, received ${mouthPointCount}`)
      }
      if (lateralStats.max >= 2) {
        failures.push(`${variant.name} lateral strip too large: max ${lateralStats.max.toFixed(4)} mm`)
      }
    }
  }

  assert.equal(failures.length, 0, failures.join('\n'))
  // eslint-disable-next-line no-console
  console.log('[athui] rect-guide quality validation: ok')
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
