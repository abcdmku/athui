import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api/client'
import { applyMeshQualityPreset, getMeshQualityPresetValues, meshQualityKeys, type MeshQualityPreset } from './mesh/qualityPresets'
import { defaultSchema } from './schema/defaultSchema'
import { buildProjectCfgText, isItemRequired, isItemVisible } from './schema/cfg'
import type { ItemSpec } from './schema/types'
import { useStudioStore } from './state/store'

const GeometryPreview = React.lazy(() => import('./components/GeometryPreview').then((m) => ({ default: m.GeometryPreview })))
const StlProfile = React.lazy(() => import('./components/StlProfile').then((m) => ({ default: m.StlProfile })))
const ProfilesCsvProfile = React.lazy(() =>
  import('./components/ProfilesCsvProfile').then((m) => ({ default: m.ProfilesCsvProfile })),
)
const HornPartsEditor = React.lazy(() =>
  import('./components/HornPartsEditor').then((m) => ({ default: m.HornPartsEditor })),
)

// ---- Horn Designer Types & Helpers ----

type Mode = 'round' | 'rect'
type SizeMode = 'depth' | 'mouth'
type GuideType = 0 | 1 | 2

type DesignerState = {
  throatShape: Mode
  mode: Mode
  guideType: GuideType
  guideWidthMm: number
  guideHeightMm: number
  guideDistPercent: number
  guideSuperellipseN: number
  guideSuperformulaText: string
  coverageH: number
  coverageV: number
  sizeMode: SizeMode
  depthMm: number
  mouthWidthMm: number
  mouthHeightMm: number
  throatDiameterMm: number
  rectThroatWidthMm: number
  rectThroatHeightMm: number
  throatAngleDeg: number
  mouthTermination: 'none' | 'r-osse'
  rollbackAngleDeg: number
  cornerRadiusMm: number
}

const KEY_MODE = '_athui.Designer.Mode'
const KEY_COV_H = '_athui.Designer.CoverageH'
const KEY_COV_V = '_athui.Designer.CoverageV'
const KEY_SIZE_MODE = '_athui.Designer.SizeMode'
const KEY_DEPTH = '_athui.Designer.DepthMm'
const KEY_MOUTH_W = '_athui.Designer.MouthWidthMm'
const KEY_MOUTH_H = '_athui.Designer.MouthHeightMm'
const KEY_GUIDE_TYPE = '_athui.Designer.GuideType'
const KEY_GUIDE_W = '_athui.Designer.GuideWidthMm'
const KEY_GUIDE_H = '_athui.Designer.GuideHeightMm'
const KEY_GUIDE_DIST = '_athui.Designer.GuideDistPercent'
const KEY_GUIDE_SE_N = '_athui.Designer.GuideSEN'
const KEY_GUIDE_SF = '_athui.Designer.GuideSF'
const KEY_THROAT_SHAPE = '_athui.Designer.ThroatShape'
const DEFAULT_RECT_THROAT_WIDTH_MM = 28
const DEFAULT_RECT_THROAT_HEIGHT_MM = 121.5
const DEFAULT_GUIDE_SUPERFORMULA_TEXT = '1,1,4,0.8,8,2'

function normalizeGuideType(value: unknown): GuideType {
  const n = asNumber(value)
  if (n === 1 || n === 2) return n
  return 0
}

function formatNumberListText(value: unknown, fallback = DEFAULT_GUIDE_SUPERFORMULA_TEXT): string {
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => asNumber(entry))
      .filter((entry): entry is number => entry !== null)
      .map((entry) => formatNumber(entry, 3))
    return parts.length ? parts.join(',') : fallback
  }
  if (typeof value === 'string') {
    const parts = value
      .split(',')
      .map((part) => asNumber(part.trim()))
      .filter((part): part is number => part !== null)
      .map((part) => formatNumber(part, 3))
    return parts.length ? parts.join(',') : fallback
  }
  return fallback
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function asNumber(value: unknown): number | null {
  if (isFiniteNumber(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function parseAngleExprToNumber(value: unknown): number | null {
  if (isFiniteNumber(value)) return value
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const direct = asNumber(trimmed)
  if (direct !== null) return direct
  const m = /^rad\(\s*([^)]+)\s*\)$/i.exec(trimmed)
  if (!m) return null
  const inner = m[1]?.trim() ?? ''
  return asNumber(inner)
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}

function formatNumber(n: number, decimals = 3): string {
  if (!Number.isFinite(n)) return '0'
  const s = n.toFixed(decimals)
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

function estimateMouthDim(throatMm: number, depthMm: number, fullCoverageDeg: number): number {
  const halfDeg = clamp(fullCoverageDeg / 2, 1, 85)
  const halfRad = degToRad(halfDeg)
  const dim = throatMm + 2 * depthMm * Math.tan(halfRad)
  return Number.isFinite(dim) ? dim : throatMm
}

function estimateDepthFromMouth(throatMm: number, mouthMm: number, fullCoverageDeg: number): number | null {
  const halfDeg = clamp(fullCoverageDeg / 2, 1, 85)
  const halfRad = degToRad(halfDeg)
  const denom = 2 * Math.tan(halfRad)
  if (!Number.isFinite(denom) || denom <= 1e-6) return null
  const depth = (mouthMm - throatMm) / denom
  if (!Number.isFinite(depth)) return null
  return depth
}

function findNearestThroatPreset(diameterMm: number): number | 'custom' {
  const presets = [25.4, 34, 50.8]
  for (const p of presets) {
    if (Math.abs(diameterMm - p) < 0.05) return p
  }
  return 'custom'
}

function deriveDesignerState(values: Record<string, unknown>): DesignerState {
  const throatDiameterMm = clamp(asNumber(values['Throat.Diameter']) ?? 25.4, 5, 200)
  const throatAngleDeg = clamp(parseAngleExprToNumber(values['Throat.Angle']) ?? 7, 0, 30)
  const rectThroatWidthMm = clamp(asNumber(values['Horn.Adapter.Width']) ?? DEFAULT_RECT_THROAT_WIDTH_MM, 1, 2000)
  const rectThroatHeightMm = clamp(asNumber(values['Horn.Adapter.Height']) ?? DEFAULT_RECT_THROAT_HEIGHT_MM, 1, 2000)

  const throatShapeRaw = values[KEY_THROAT_SHAPE]
  const inferredThroatShape: Mode = asNumber(values['HornGeometry']) === 2 ? 'rect' : 'round'
  const throatShape: Mode = throatShapeRaw === 'rect' || throatShapeRaw === 'round' ? throatShapeRaw : inferredThroatShape

  const modeRaw = values[KEY_MODE]
  const inferredMode: Mode = asNumber(values['Morph.TargetShape']) === 1 ? 'rect' : 'round'
  const rawMode: Mode = modeRaw === 'rect' || modeRaw === 'round' ? modeRaw : inferredMode
  const mode: Mode = throatShape === 'rect' ? 'rect' : rawMode
  const guideType = normalizeGuideType(values[KEY_GUIDE_TYPE] ?? values['GCurve.Type'])

  const covFromCfgHalf = parseAngleExprToNumber(values['Coverage.Angle'])
  const fallbackCoverage = covFromCfgHalf !== null ? clamp(covFromCfgHalf * 2, 20, 160) : 90

  const coverageH = clamp(asNumber(values[KEY_COV_H]) ?? fallbackCoverage, 20, 160)
  const usesDualCoverage = throatShape === 'rect' || mode === 'rect'
  const coverageVDefault = usesDualCoverage ? 60 : coverageH
  const coverageV = clamp(asNumber(values[KEY_COV_V]) ?? coverageVDefault, 20, 160)

  const sizeModeRaw = values[KEY_SIZE_MODE]
  const sizeMode: SizeMode = sizeModeRaw === 'mouth' ? 'mouth' : 'depth'

  const depthFromCfg = parseAngleExprToNumber(values['Length'])
  const depthMm = clamp(asNumber(values[KEY_DEPTH]) ?? depthFromCfg ?? 120, 10, 1000)

  const targetWFromCfg = asNumber(values['Morph.TargetWidth'])
  const targetHFromCfg = asNumber(values['Morph.TargetHeight'])
  const gCurveWidthMm = clamp(asNumber(values[KEY_GUIDE_W] ?? values['GCurve.Width']) ?? 68, 1, 2000)
  const gCurveAspectRatio = clamp(asNumber(values['GCurve.AspectRatio']) ?? 1, 0.05, 20)
  const gCurveHeightMm = clamp(
    asNumber(values[KEY_GUIDE_H]) ?? gCurveWidthMm * gCurveAspectRatio,
    1,
    2000,
  )
  const rawGuideDist = asNumber(values['GCurve.Dist'])
  const derivedGuideDistPercent =
    rawGuideDist === null
      ? 50
      : rawGuideDist <= 1
        ? rawGuideDist * 100
        : depthMm > 1e-6
          ? (rawGuideDist / depthMm) * 100
          : 50
  const guideDistPercent = clamp(asNumber(values[KEY_GUIDE_DIST]) ?? derivedGuideDistPercent, 1, 100)
  const guideSuperellipseN = clamp(asNumber(values[KEY_GUIDE_SE_N] ?? values['GCurve.SE.n']) ?? 3, 2, 20)
  const guideSuperformulaText = formatNumberListText(values[KEY_GUIDE_SF] ?? values['GCurve.SF'])

  const estimatedBaseW =
    throatShape === 'rect'
      ? estimateMouthDim(rectThroatWidthMm, depthMm, coverageH)
      : estimateMouthDim(throatDiameterMm, depthMm, coverageH)
  const estimatedBaseH =
    throatShape === 'rect'
      ? estimateMouthDim(rectThroatHeightMm, depthMm, coverageV)
      : usesDualCoverage
        ? estimateMouthDim(throatDiameterMm, depthMm, coverageV)
        : estimatedBaseW

  const estimatedW = mode === 'round' ? Math.max(estimatedBaseW, estimatedBaseH) : estimatedBaseW
  const estimatedH = mode === 'round' ? estimatedW : estimatedBaseH

  const minRoundMouthMm =
    throatShape === 'rect' ? Math.max(rectThroatWidthMm, rectThroatHeightMm) : throatDiameterMm
  const minMouthWidthMm = throatShape === 'rect' ? rectThroatWidthMm : throatDiameterMm
  const minMouthHeightMm = throatShape === 'rect' ? rectThroatHeightMm : throatDiameterMm

  const mouthWidthMm = clamp(
    asNumber(values[KEY_MOUTH_W]) ?? targetWFromCfg ?? estimatedW,
    mode === 'round' ? minRoundMouthMm : minMouthWidthMm,
    2000,
  )
  const mouthHeightMm = clamp(
    asNumber(values[KEY_MOUTH_H]) ?? targetHFromCfg ?? estimatedH,
    mode === 'round' ? minRoundMouthMm : minMouthHeightMm,
    2000,
  )

  const mouthTerminationRaw = values['_athui.MouthTermination']
  const mouthTermination: 'none' | 'r-osse' = mouthTerminationRaw === 'r-osse' ? 'r-osse' : 'none'
  const rollbackAngleDeg = clamp(asNumber(values['_athui.RollbackAngleDeg']) ?? 180, 0, 360)

  const cornerRadiusMm = clamp(asNumber(values['Morph.CornerRadius']) ?? 35, 0, 500)

  return {
    throatShape,
    mode,
    guideType,
    guideWidthMm: gCurveWidthMm,
    guideHeightMm: gCurveHeightMm,
    guideDistPercent,
    guideSuperellipseN,
    guideSuperformulaText,
    coverageH,
    coverageV: usesDualCoverage ? coverageV : coverageH,
    sizeMode,
    depthMm,
    mouthWidthMm,
    mouthHeightMm: mode === 'round' ? mouthWidthMm : mouthHeightMm,
    throatDiameterMm,
    rectThroatWidthMm,
    rectThroatHeightMm,
    throatAngleDeg,
    mouthTermination,
    rollbackAngleDeg,
    cornerRadiusMm,
  }
}

function buildCoverageExprDeg(fullH: number, fullV: number): string {
  const hHalf = clamp(fullH / 2, 1, 85)
  const vHalf = clamp(fullV / 2, 1, 85)
  if (Math.abs(hHalf - vHalf) < 1e-6) return formatNumber(hHalf)
  return `${formatNumber(vHalf)} + (${formatNumber(hHalf)} - ${formatNumber(vHalf)})*cos(p)^2`
}

function computeDerived(s: DesignerState): { depthMm: number; mouthWidthMm: number; mouthHeightMm: number } {
  const guideActive = s.guideType !== 0
  const throatMinWidthMm = s.throatShape === 'rect' ? s.rectThroatWidthMm : s.throatDiameterMm
  const throatMinHeightMm = s.throatShape === 'rect' ? s.rectThroatHeightMm : s.throatDiameterMm
  const clampedH = clamp(s.coverageH, 20, 160)
  const usesDualCoverage = s.throatShape === 'rect' || s.mode === 'rect'
  const clampedV = clamp(usesDualCoverage ? s.coverageV : clampedH, 20, 160)

  if (guideActive) {
    return {
      depthMm: clamp(s.depthMm, 10, 1000),
      mouthWidthMm: clamp(s.mouthWidthMm, throatMinWidthMm, 2000),
      mouthHeightMm: clamp(s.mouthHeightMm, throatMinHeightMm, 2000),
    }
  }

  if (s.sizeMode === 'depth') {
    const depth = clamp(s.depthMm, 10, 1000)
    if (s.throatShape === 'rect') {
      const mouthW = estimateMouthDim(s.rectThroatWidthMm, depth, clampedH)
      const mouthH = estimateMouthDim(s.rectThroatHeightMm, depth, clampedV)
      if (s.mode === 'round') {
        const mouthD = Math.max(mouthW, mouthH)
        return { depthMm: depth, mouthWidthMm: mouthD, mouthHeightMm: mouthD }
      }
      return { depthMm: depth, mouthWidthMm: mouthW, mouthHeightMm: mouthH }
    }
    const mouthW = estimateMouthDim(s.throatDiameterMm, depth, clampedH)
    const mouthH = s.mode === 'round' ? mouthW : estimateMouthDim(s.throatDiameterMm, depth, clampedV)
    return { depthMm: depth, mouthWidthMm: mouthW, mouthHeightMm: mouthH }
  }

  if (s.throatShape === 'rect') {
    if (s.mode === 'round') {
      const minRoundMouthMm = Math.max(s.rectThroatWidthMm, s.rectThroatHeightMm)
      const mouthD = clamp(s.mouthWidthMm, minRoundMouthMm, 2000)

      const depthH = estimateDepthFromMouth(s.rectThroatWidthMm, mouthD, clampedH)
      const depthV = estimateDepthFromMouth(s.rectThroatHeightMm, mouthD, clampedV)

      const candidates = [depthH, depthV].filter((d): d is number => typeof d === 'number' && Number.isFinite(d) && d >= 0)
      const depth = candidates.length ? Math.max(...candidates) : s.depthMm

      return { depthMm: clamp(depth, 10, 1000), mouthWidthMm: mouthD, mouthHeightMm: mouthD }
    }

    const mouthW = clamp(s.mouthWidthMm, s.rectThroatWidthMm, 2000)
    const mouthH = clamp(s.mouthHeightMm, s.rectThroatHeightMm, 2000)

    const depthH = estimateDepthFromMouth(s.rectThroatWidthMm, mouthW, clampedH)
    const depthV = estimateDepthFromMouth(s.rectThroatHeightMm, mouthH, clampedV)

    const candidates = [depthH, depthV].filter((d): d is number => typeof d === 'number' && Number.isFinite(d) && d >= 0)
    const depth = candidates.length ? Math.max(...candidates) : s.depthMm

    return { depthMm: clamp(depth, 10, 1000), mouthWidthMm: mouthW, mouthHeightMm: mouthH }
  }

  const mouthW = clamp(s.mouthWidthMm, s.throatDiameterMm, 2000)
  const mouthH = s.mode === 'round' ? mouthW : clamp(s.mouthHeightMm, s.throatDiameterMm, 2000)

  const depthH = estimateDepthFromMouth(s.throatDiameterMm, mouthW, clampedH)
  const depthV = estimateDepthFromMouth(s.throatDiameterMm, mouthH, clampedV)

  const candidates = [depthH, depthV].filter((d): d is number => typeof d === 'number' && Number.isFinite(d) && d >= 0)
  const depth = candidates.length ? Math.min(...candidates) : s.depthMm

  return { depthMm: clamp(depth, 10, 1000), mouthWidthMm: mouthW, mouthHeightMm: mouthH }
}

// ---- File pickers ----

function pickGeometryFile(files: { path: string; size: number }[]): string | null {
  const isInCurrentOutputs = (p: string) => p.toLowerCase().startsWith('outputs/project/')
  const preferred = ['.stl', '.glb', '.gltf', '.obj', '.ply']
  function pickFrom(list: { path: string; size: number }[]) {
    for (const ext of preferred) {
      const f = list.find((x) => x.path.toLowerCase().endsWith(ext))
      if (f) return f.path
    }
    const geo = list.find((x) => x.path.toLowerCase().endsWith('.geo'))
    return geo?.path ?? null
  }
  const current = files.filter((x) => isInCurrentOutputs(x.path))
  return pickFrom(current) ?? pickFrom(files)
}

function pickMeshFile(files: { path: string; size: number }[]): string | null {
  const isInCurrentOutputs = (p: string) => p.toLowerCase().startsWith('outputs/project/')
  const stlFiles = files.filter((x) => x.path.toLowerCase().endsWith('.stl') && !x.path.toLowerCase().includes('bem_mesh'))
  const currentStlFiles = stlFiles.filter((x) => isInCurrentOutputs(x.path))
  function pickFrom(list: { path: string; size: number }[]) {
    const preferredRollbackNames = ['mesh_rollback.stl', 'project_rollback.stl']
    for (const name of preferredRollbackNames) {
      const preferred = list.find((x) => x.path.toLowerCase().endsWith(name))
      if (preferred) return preferred.path
    }
    const anyRollback = list.find((x) => x.path.toLowerCase().endsWith('_rollback.stl'))
    if (anyRollback) return anyRollback.path
    const preferredNames = ['mesh.stl', 'project.stl']
    for (const name of preferredNames) {
      const preferred = list.find((x) => x.path.toLowerCase().endsWith(name))
      if (preferred) return preferred.path
    }
    if (list.length > 0) return list[0].path
    return null
  }
  const fromCurrent = pickFrom(currentStlFiles)
  if (fromCurrent) return fromCurrent
  const fromAny = pickFrom(stlFiles)
  if (fromAny) return fromAny
  const geo = files.find((x) => x.path.toLowerCase().endsWith('.geo'))
  if (geo) return geo.path
  return null
}

function pickProfilesFile(files: { path: string; size: number }[]): string | null {
  const isInCurrentOutputs = (p: string) => p.toLowerCase().startsWith('outputs/project/')
  const csvFiles = files.filter((x) => x.path.toLowerCase().endsWith('.csv'))
  const currentCsvFiles = csvFiles.filter((x) => isInCurrentOutputs(x.path))
  function pickFrom(list: { path: string; size: number }[]) {
    const rollbackProfiles = list.find((x) => x.path.toLowerCase().includes('rollback') && x.path.toLowerCase().includes('profiles'))
    if (rollbackProfiles) return rollbackProfiles.path
    const preferredNames = ['project_profiles_athui.csv', 'mesh_profiles_athui.csv', 'project_profiles.csv', 'mesh_profiles.csv']
    for (const name of preferredNames) {
      const preferred = list.find((x) => x.path.toLowerCase().endsWith(name))
      if (preferred) return preferred.path
    }
    const anyProfiles = list.find((x) => x.path.toLowerCase().endsWith('_profiles.csv'))
    if (anyProfiles) return anyProfiles.path
    const fuzzy = list.find((x) => x.path.toLowerCase().includes('profiles'))
    return fuzzy?.path ?? null
  }
  const fromCurrent = pickFrom(currentCsvFiles)
  if (fromCurrent) return fromCurrent
  const fromAny = pickFrom(csvFiles)
  if (fromAny) return fromAny
  return null
}

// ---- Validate/Parse ----

function validateAndParse(spec: ItemSpec, value: unknown, required: boolean): [string | null, string | number | boolean] {
  const valueType = spec.valueType
  if (valueType === 'b') return [null, Boolean(value)]
  if (valueType === 'i' || valueType === 'f') {
    if (value === null || value === undefined || value === '') return [required ? 'Required' : null, '']
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n)) return ['Invalid number', '']
    if (valueType === 'i' && !Number.isInteger(n)) return ['Must be an integer', n]
    return [null, n]
  }
  if (valueType === 'i[]' || valueType === 'f[]') {
    if (value === undefined) return [required ? 'Required' : null, '']
    if (value === null) return [null, '[]']
    if (Array.isArray(value)) return [null, value.length ? value.join(', ') : '[]']
    if (typeof value === 'string') return [null, value]
    return ['Invalid list', '']
  }
  if (typeof value === 'string') return [required && value.trim() === '' ? 'Required' : null, value]
  if (value === undefined) return [required ? 'Required' : null, '']
  return [null, '']
}

function parseFromInput(valueType: string, raw: string): unknown {
  if (raw === '') return undefined
  if (valueType === 'i') return Number.parseInt(raw, 10)
  if (valueType === 'f') return Number.parseFloat(raw)
  if (valueType === 'b') return raw === '1' || raw === 'true'
  return raw
}

// ---- Accordion Sections config ----

type AccordionSectionDef = {
  id: string
  label: string
  icon: string
  simple: boolean
}

const SECTIONS: AccordionSectionDef[] = [
  { id: 'design', label: 'Design', icon: '\u25C7', simple: true },
  { id: 'geometry', label: 'Geometry', icon: '\u2699', simple: false },
  { id: 'mesh', label: 'Mesh', icon: '\u25A6', simple: true },
  { id: 'simulation', label: 'Simulation', icon: '\u223F', simple: false },
  { id: 'output', label: 'Output', icon: '\u2399', simple: true },
]

// Bottom drawer tabs
type DrawerTab = 'logs' | 'profile' | 'files'

// ---- App ----

export function App() {
  const projectId = useStudioStore((s) => s.projectId)
  const setProjectId = useStudioStore((s) => s.setProjectId)
  const schema = useStudioStore((s) => s.schema)
  const setSchema = useStudioStore((s) => s.setSchema)
  const showAdvanced = useStudioStore((s) => s.showAdvanced)
  const setShowAdvanced = useStudioStore((s) => s.setShowAdvanced)
  const values = useStudioStore((s) => s.values)
  const setValue = useStudioStore((s) => s.setValue)
  const setValues = useStudioStore((s) => s.setValues)
  const dirty = useStudioStore((s) => s.dirty)
  const setDirty = useStudioStore((s) => s.setDirty)
  const logs = useStudioStore((s) => s.logs)
  const appendLogs = useStudioStore((s) => s.appendLogs)
  const setFiles = useStudioStore((s) => s.setFiles)
  const files = useStudioStore((s) => s.files)
  const geometryFilePath = useStudioStore((s) => s.geometryFilePath)
  const setGeometryFilePath = useStudioStore((s) => s.setGeometryFilePath)
  const meshFilePath = useStudioStore((s) => s.meshFilePath)
  const setMeshFilePath = useStudioStore((s) => s.setMeshFilePath)
  const profilesFilePath = useStudioStore((s) => s.profilesFilePath)
  const setProfilesFilePath = useStudioStore((s) => s.setProfilesFilePath)
  const outputsRevision = useStudioStore((s) => s.outputsRevision)

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [openSection, setOpenSection] = useState<string>('design')
  const [busy, setBusy] = useState(false)
  const [drawerTab, setDrawerTab] = useState<DrawerTab | null>(null)
  const [drawerHeight, setDrawerHeight] = useState(0)

  const visibleSections = useMemo(() => {
    if (showAdvanced) return SECTIONS
    return SECTIONS.filter((s) => s.simple)
  }, [showAdvanced])

  // Boot
  useEffect(() => {
    setSchema(defaultSchema)
  }, [setSchema])

  useEffect(() => {
    let cancelled = false
    async function boot() {
      try {
        const { id } = await api.createProject()
        if (cancelled) return
        setProjectId(id)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        appendLogs([`[ui] failed to create project: ${message}`], { replace: true })
      }
    }
    void boot()
    return () => { cancelled = true }
  }, [appendLogs, setProjectId])

  // WebSocket
  useEffect(() => {
    if (!projectId) return
    const ws = api.openLogsSocket(projectId, (msg) => {
      if (msg.type === 'logs:init') appendLogs(msg.lines, { replace: true })
      if (msg.type === 'logs:append') appendLogs(msg.lines)
      if (msg.type === 'files:update') {
        setFiles(msg.files)
        setGeometryFilePath(pickGeometryFile(msg.files))
        setMeshFilePath(pickMeshFile(msg.files))
        setProfilesFilePath(pickProfilesFile(msg.files))
      }
      if (msg.type === 'run:done') {
        setBusy(false)
        if (msg.ok !== false) setDirty(false)
      }
    })
    return () => ws.close()
  }, [appendLogs, projectId, setDirty, setFiles, setGeometryFilePath, setMeshFilePath, setProfilesFilePath])

  // Exit scan
  const lastExitScanIndex = useRef(0)
  useEffect(() => {
    if (!projectId) return
    if (logs.length <= lastExitScanIndex.current) return
    const newLines = logs.slice(lastExitScanIndex.current)
    lastExitScanIndex.current = logs.length
    const sawExit = newLines.some((l) => l.startsWith('[run] exit code=') || l.startsWith('[gmsh] exit code='))
    if (sawExit) void handleRefreshFiles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs, projectId])

  async function handleRun() {
    if (!projectId || !schema) return
    setBusy(true)
    try {
      const valuesForRun = applyMeshQualityPreset(values)
      const { text: cfgText, errors } = buildProjectCfgText(schema, valuesForRun, { includeAdvanced: showAdvanced })
      if (errors.length) {
        appendLogs(['[ui] config errors:', ...errors.map((e) => `- ${e}`)])
        setBusy(false)
        return
      }
      await api.updateConfig(projectId, { ...valuesForRun, '_athui.cfgText': cfgText })
      await api.run(projectId)
      toggleDrawerTab('logs')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      appendLogs([`[ui] run failed: ${message}`])
      setBusy(false)
    } finally {
      if (!projectId) setBusy(false)
    }
  }

  async function handleRefreshFiles() {
    if (!projectId) return
    try {
      const { files } = await api.listFiles(projectId)
      setFiles(files)
      setGeometryFilePath(pickGeometryFile(files))
      setMeshFilePath(pickMeshFile(files))
      setProfilesFilePath(pickProfilesFile(files))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      appendLogs([`[ui] failed to list files: ${message}`])
    }
  }

  function toggleDrawerTab(tab: DrawerTab) {
    if (drawerTab === tab) {
      setDrawerTab(null)
      setDrawerHeight(0)
    } else {
      setDrawerTab(tab)
      setDrawerHeight(300)
    }
  }

  function handleCollapsedIconClick(sectionId: string) {
    setSidebarCollapsed(false)
    setOpenSection(sectionId)
  }

  function toggleSection(sectionId: string) {
    setOpenSection(openSection === sectionId ? '' : sectionId)
  }

  // ---- Horn designer state & patch ----

  const designerState = useMemo(() => deriveDesignerState(values), [values])
  const derived = useMemo(() => computeDerived(designerState), [designerState])

  const applyPatch = useCallback((partial: Partial<DesignerState>) => {
    const currentValues = useStudioStore.getState().values
    const currentState = deriveDesignerState(currentValues)
    const next0: DesignerState = { ...currentState, ...partial }

    const throatShape = next0.throatShape === 'rect' ? 'rect' : 'round'
    const mode = throatShape === 'rect' ? 'rect' : next0.mode === 'rect' ? 'rect' : 'round'
    const guideType = normalizeGuideType(next0.guideType)
    const coverageH = clamp(next0.coverageH, 20, 160)
    const usesDualCoverage = throatShape === 'rect' || mode === 'rect'
    const coverageV = clamp(usesDualCoverage ? next0.coverageV : coverageH, 20, 160)
    const sizeMode: SizeMode = next0.sizeMode === 'mouth' ? 'mouth' : 'depth'

    const throatDiameterMm = clamp(next0.throatDiameterMm, 5, 200)
    const rectThroatWidthMm = clamp(next0.rectThroatWidthMm, 1, 2000)
    const rectThroatHeightMm = clamp(next0.rectThroatHeightMm, 1, 2000)
    const throatAngleDeg = clamp(next0.throatAngleDeg, 0, 30)
    const guideWidthMm = clamp(next0.guideWidthMm, 1, 2000)
    const guideHeightMm = clamp(next0.guideHeightMm, 1, 2000)
    const guideDistPercent = clamp(next0.guideDistPercent, 1, 100)
    const guideSuperellipseN = clamp(next0.guideSuperellipseN, 2, 20)
    const guideSuperformulaText = formatNumberListText(next0.guideSuperformulaText)
    const mouthTermination: 'none' | 'r-osse' = next0.mouthTermination === 'r-osse' ? 'r-osse' : 'none'
    const rollbackAngleDeg = clamp(next0.rollbackAngleDeg, 0, 360)

    const normalized: DesignerState = {
      ...next0,
      throatShape,
      mode,
      guideType,
      guideWidthMm,
      guideHeightMm,
      guideDistPercent,
      guideSuperellipseN,
      guideSuperformulaText,
      coverageH,
      coverageV,
      sizeMode,
      throatDiameterMm,
      rectThroatWidthMm,
      rectThroatHeightMm,
      throatAngleDeg,
      mouthTermination,
      rollbackAngleDeg,
      mouthHeightMm: mode === 'round' ? next0.mouthWidthMm : next0.mouthHeightMm,
    }

    const nextDerived = computeDerived(normalized)
    const depthMm = nextDerived.depthMm
    const mouthWidthMm = nextDerived.mouthWidthMm
    const mouthHeightMm = nextDerived.mouthHeightMm

    const cornerRadiusLimit = Math.max(0, Math.min(mouthWidthMm, mouthHeightMm) / 2 - 0.01)
    const cornerRadiusMm = clamp(normalized.cornerRadiusMm, 0, cornerRadiusLimit)

    const coverageAngleExpr = buildCoverageExprDeg(coverageH, coverageV)
    const guideActive = normalized.guideType !== 0
    const rectGuideMorphActive = throatShape === 'rect' && guideActive
    const guideAspectRatio = normalized.guideHeightMm / Math.max(normalized.guideWidthMm, 1e-6)
    const guideDistValue = normalized.guideDistPercent / 100

    const updates: Record<string, unknown> = {
      [KEY_THROAT_SHAPE]: throatShape,
      [KEY_MODE]: mode,
      [KEY_GUIDE_TYPE]: guideType,
      [KEY_GUIDE_W]: guideWidthMm,
      [KEY_GUIDE_H]: guideHeightMm,
      [KEY_GUIDE_DIST]: guideDistPercent,
      [KEY_GUIDE_SE_N]: guideSuperellipseN,
      [KEY_GUIDE_SF]: guideSuperformulaText,
      [KEY_COV_H]: coverageH,
      [KEY_COV_V]: coverageV,
      [KEY_SIZE_MODE]: sizeMode,
      [KEY_DEPTH]: depthMm,
      [KEY_MOUTH_W]: mouthWidthMm,
      [KEY_MOUTH_H]: mouthHeightMm,
      HornGeometry: throatShape === 'rect' ? 2 : 1,
      'Horn.Adapter.Width': rectThroatWidthMm,
      'Horn.Adapter.Height': rectThroatHeightMm,
      'Horn.Adapter.Length': 0,
      'Horn.Adapter.k': 0,
      'Horn.Adapter.Segments': 0,
      'Throat.Profile': 1,
      'Throat.Diameter': throatDiameterMm,
      'Throat.Angle': formatNumber(throatAngleDeg),
      'GCurve.Type': guideActive ? guideType : undefined,
      'GCurve.Dist': guideActive ? formatNumber(guideDistValue, 3) : undefined,
      'GCurve.Width': guideActive ? guideWidthMm : undefined,
      'GCurve.AspectRatio': guideActive ? guideAspectRatio : undefined,
      'GCurve.SE.n': guideActive && guideType === 1 ? guideSuperellipseN : undefined,
      'GCurve.SF': guideActive && guideType === 2 ? guideSuperformulaText : undefined,
      'GCurve.Rot': guideActive ? 0 : undefined,
      'Coverage.Angle': throatShape === 'rect' || guideActive ? undefined : coverageAngleExpr,
      Length: formatNumber(depthMm),
      'Morph.TargetShape': throatShape === 'rect' ? (rectGuideMorphActive ? 1 : 0) : mode === 'rect' ? 1 : 0,
      'Morph.TargetWidth': throatShape === 'rect' ? (rectGuideMorphActive ? mouthWidthMm : 0) : mode === 'rect' ? mouthWidthMm : 0,
      'Morph.TargetHeight': throatShape === 'rect' ? (rectGuideMorphActive ? mouthHeightMm : 0) : mode === 'rect' ? mouthHeightMm : 0,
      'Morph.CornerRadius': throatShape === 'rect' ? 0 : mode === 'rect' ? cornerRadiusMm : 0,
      'Morph.FixedPart': throatShape === 'rect' ? (rectGuideMorphActive ? '0' : undefined) : mode === 'rect' ? '0' : undefined,
      'Morph.Rate': throatShape === 'rect' ? (rectGuideMorphActive ? '3' : undefined) : mode === 'rect' ? '3' : undefined,
      'Morph.AllowShrinkage': throatShape === 'rect' ? rectGuideMorphActive : mode === 'rect',
      'OS.k': 1,
      'Term.s': '0.5',
      'Term.q': '0.996',
      'Term.n': '4',
      '_athui.MouthTermination': normalized.mouthTermination,
      '_athui.RollbackAngleDeg': normalized.rollbackAngleDeg,
    }

    setValues(updates)
  }, [setValues])

  // ---- Mesh quality handler ----
  const handleMeshQualityChange = useCallback((preset: string) => {
    setValue('_athui.MeshQuality', preset)
    const p = preset as MeshQualityPreset
    if (p && p !== 'custom') {
      const next = getMeshQualityPresetValues(p)
      for (const key of meshQualityKeys) {
        const v = next[key]
        if (v !== undefined) setValue(key, v)
      }
    }
  }, [setValue])

  // STL path
  const stlPath = meshFilePath ?? geometryFilePath

  return (
    <div className="app-shell">
      {/* ---- Sidebar ---- */}
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-top">
          <button
            className="hamburger-btn"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <div className="hamburger-icon">
              <span /><span /><span />
            </div>
          </button>
          {!sidebarCollapsed && (
            <>
              <span className="sidebar-title">Horn Designer</span>
              <div className="mode-toggle">
                <button
                  className={showAdvanced ? '' : 'active'}
                  onClick={() => setShowAdvanced(false)}
                >
                  Simple
                </button>
                <button
                  className={showAdvanced ? 'active' : ''}
                  onClick={() => setShowAdvanced(true)}
                >
                  Advanced
                </button>
              </div>
            </>
          )}
        </div>

        {/* Collapsed icon strip */}
        <div className="collapsed-icons">
          {visibleSections.map((sec) => (
            <button
              key={sec.id}
              className={`collapsed-icon-btn ${openSection === sec.id ? 'active' : ''}`}
              onClick={() => handleCollapsedIconClick(sec.id)}
              title={sec.label}
            >
              {sec.icon}
            </button>
          ))}
        </div>

        {/* Expanded sidebar content */}
        <div className="sidebar-content">
          {visibleSections.map((sec) => (
            <div key={sec.id} className="accordion-section">
              <button
                className="accordion-header"
                onClick={() => toggleSection(sec.id)}
              >
                <span className="accordion-icon">{sec.icon}</span>
                <span className="accordion-label">{sec.label}</span>
                <span className={`accordion-arrow ${openSection === sec.id ? 'open' : ''}`}>
                  {'\u25B6'}
                </span>
              </button>
              {openSection === sec.id && (
                <div className="accordion-body">
                  <AccordionContent
                    sectionId={sec.id}
                    values={values}
                    setValue={setValue}
                    setValues={setValues}
                    schema={schema}
                    showAdvanced={showAdvanced}
                    designerState={designerState}
                    derived={derived}
                    applyPatch={applyPatch}
                    handleMeshQualityChange={handleMeshQualityChange}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>

      {/* ---- Canvas + Drawer ---- */}
      <div className="canvas-area">
        <div className="canvas-main">
          {/* Floating toolbar */}
          <div className="floating-toolbar">
            <div className={`dirty-dot ${dirty ? '' : 'clean'}`} title={dirty ? 'Unsaved changes' : 'Up to date'} />
            <button
              className="run-btn"
              onClick={handleRun}
              disabled={!projectId || busy}
            >
              {busy ? 'Running...' : 'Run'}
            </button>
          </div>

          {/* 3D Preview */}
          {stlPath && stlPath.toLowerCase().endsWith('.stl') && projectId ? (
            <Suspense fallback={<CanvasPlaceholder text="Loading preview..." />}>
              <GeometryPreview
                key={`${stlPath}:${outputsRevision}`}
                modelUrl={`${api.rawFileUrl(projectId, stlPath)}&v=${outputsRevision}`}
              />
            </Suspense>
          ) : (
            <CanvasPlaceholder text="No preview available. Click Run to generate geometry." />
          )}
        </div>

        {/* Bottom Drawer */}
        <div
          className="bottom-drawer"
          style={{ height: drawerTab ? drawerHeight + 36 : 36 }}
        >
          <div className="drawer-tabs">
            <button
              className={`drawer-tab ${drawerTab === 'logs' ? 'active' : ''}`}
              onClick={() => toggleDrawerTab('logs')}
            >
              Logs
            </button>
            <button
              className={`drawer-tab ${drawerTab === 'profile' ? 'active' : ''}`}
              onClick={() => toggleDrawerTab('profile')}
            >
              Profile
            </button>
            <button
              className={`drawer-tab ${drawerTab === 'files' ? 'active' : ''}`}
              onClick={() => toggleDrawerTab('files')}
            >
              Files
            </button>
          </div>
          {drawerTab && (
            <div className="drawer-content">
              {drawerTab === 'logs' && (
                <div className="log-box">
                  {logs.length ? logs.join('\n') : 'No logs yet.'}
                </div>
              )}
              {drawerTab === 'profile' && (
                <div style={{ padding: 8 }}>
                  <ProfilePanel projectId={projectId} profilesPath={profilesFilePath} stlPath={stlPath} outputsRevision={outputsRevision} />
                </div>
              )}
              {drawerTab === 'files' && (
                <div>
                  {files.length === 0 ? (
                    <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>
                      Run the project to generate outputs.
                    </div>
                  ) : (
                    files.map((f) => (
                      <div key={f.path} className="file-item">
                        <span className="file-item-name">{f.path}</span>
                        <span className="file-item-size">{f.size.toLocaleString()} B</span>
                        {projectId && (
                          <a
                            className="file-item-dl"
                            href={`/api/projects/${projectId}/files/download?path=${encodeURIComponent(f.path)}`}
                          >
                            DL
                          </a>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---- Canvas Placeholder ----

function CanvasPlaceholder({ text }: { text: string }) {
  return (
    <div className="canvas-placeholder">
      <div className="canvas-placeholder-icon">{'\u25C7'}</div>
      <div>{text}</div>
    </div>
  )
}

// ---- Profile Panel ----

function ProfilePanel({
  projectId,
  profilesPath,
  stlPath,
  outputsRevision,
}: {
  projectId: string | null
  profilesPath: string | null
  stlPath: string | null
  outputsRevision: number
}) {
  if (!projectId) return <div className="muted" style={{ fontSize: 12 }}>No project.</div>
  return (
    <Suspense fallback={<div className="muted" style={{ fontSize: 12 }}>Loading profile...</div>}>
      {profilesPath && profilesPath.toLowerCase().endsWith('.csv') ? (
        <ProfilesCsvProfile
          key={`${profilesPath}:${outputsRevision}`}
          csvUrl={`${api.rawFileUrl(projectId, profilesPath)}&v=${outputsRevision}`}
        />
      ) : stlPath && stlPath.toLowerCase().endsWith('.stl') ? (
        <StlProfile
          key={`${stlPath}:${outputsRevision}`}
          modelUrl={`${api.rawFileUrl(projectId, stlPath)}&v=${outputsRevision}`}
        />
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>No profile data. Run to generate.</div>
      )}
    </Suspense>
  )
}

// ---- Accordion Content ----

function AccordionContent({
  sectionId,
  values,
  setValue,
  setValues,
  schema,
  showAdvanced,
  designerState,
  derived,
  applyPatch,
  handleMeshQualityChange,
}: {
  sectionId: string
  values: Record<string, unknown>
  setValue: (key: string, value: unknown) => void
  setValues: (updates: Record<string, unknown>) => void
  schema: ReturnType<typeof useStudioStore.getState>['schema']
  showAdvanced: boolean
  designerState: DesignerState
  derived: ReturnType<typeof computeDerived>
  applyPatch: (partial: Partial<DesignerState>) => void
  handleMeshQualityChange: (preset: string) => void
}) {
  if (!schema) return null

  if (sectionId === 'design') {
    return <DesignSection designerState={designerState} derived={derived} applyPatch={applyPatch} values={values} />
  }

  if (sectionId === 'geometry') {
    return <GeometrySection schema={schema} values={values} setValue={setValue} showAdvanced={showAdvanced} />
  }

  if (sectionId === 'mesh') {
    return (
      <MeshSection
        schema={schema}
        values={values}
        setValue={setValue}
        showAdvanced={showAdvanced}
        handleMeshQualityChange={handleMeshQualityChange}
      />
    )
  }

  if (sectionId === 'simulation') {
    return <SimulationSection schema={schema} values={values} setValue={setValue} showAdvanced={showAdvanced} />
  }

  if (sectionId === 'output') {
    return <OutputSection schema={schema} values={values} setValue={setValue} showAdvanced={showAdvanced} />
  }

  return null
}

// ---- Design Section ----

function DesignSection({
  designerState,
  derived,
  applyPatch,
  values,
}: {
  designerState: DesignerState
  derived: ReturnType<typeof computeDerived>
  applyPatch: (partial: Partial<DesignerState>) => void
  values: Record<string, unknown>
}) {
  const state = designerState
  const throatPreset = findNearestThroatPreset(state.throatDiameterMm)
  const usesDualCoverage = state.throatShape === 'rect' || state.mode === 'rect'
  const guideActive = state.guideType !== 0

  const coveragePresets =
    usesDualCoverage
      ? [
          { id: '90x60', label: '90x60', h: 90, v: 60 },
          { id: '90x40', label: '90x40', h: 90, v: 40 },
          { id: '80x50', label: '80x50', h: 80, v: 50 },
          { id: '60x40', label: '60x40', h: 60, v: 40 },
        ]
      : [
          { id: '60', label: '60', h: 60, v: 60 },
          { id: '90', label: '90', h: 90, v: 90 },
          { id: '120', label: '120', h: 120, v: 120 },
        ]

  return (
    <>
      {/* Throat Shape */}
      <div className="field-row">
        <div className="field-label">THROAT SHAPE</div>
        <div className="type-toggle">
          <button
            className={`type-toggle-btn ${state.throatShape === 'round' ? 'active' : ''}`}
            onClick={() => applyPatch({ throatShape: 'round' })}
          >
            Round
          </button>
          <button
            className={`type-toggle-btn ${state.throatShape === 'rect' ? 'active' : ''}`}
            onClick={() => applyPatch({ throatShape: 'rect', coverageV: usesDualCoverage ? state.coverageV : 60 })}
          >
            Rect
          </button>
        </div>
      </div>

      {/* Throat */}
      <div className="field-row">
        <div className="field-label">{state.throatShape === 'rect' ? 'RECT THROAT' : 'THROAT'} <span className="units">mm</span></div>
        {state.throatShape === 'rect' ? (
          <div className="field-inline">
            <input
              aria-label="Rectangular throat width (mm)"
              className="field-input"
              type="number"
              step="0.1"
              value={formatNumber(state.rectThroatWidthMm, 1)}
              onChange={(e) => applyPatch({ rectThroatWidthMm: Number(e.target.value) || 0 })}
              placeholder="Width mm"
            />
            <input
              aria-label="Rectangular throat height (mm)"
              className="field-input"
              type="number"
              step="0.1"
              value={formatNumber(state.rectThroatHeightMm, 1)}
              onChange={(e) => applyPatch({ rectThroatHeightMm: Number(e.target.value) || 0 })}
              placeholder="Height mm"
            />
          </div>
        ) : (
          <div className="field-inline">
            <select
              className="field-select"
              value={String(throatPreset)}
              onChange={(e) => {
                const v = e.target.value
                if (v === 'custom') return
                const preset = Number(v)
                if (!Number.isFinite(preset) || preset <= 0) return
                applyPatch({ throatDiameterMm: preset })
              }}
            >
              <option value="25.4">1" (25.4)</option>
              <option value="34">1.4" (34)</option>
              <option value="50.8">2" (50.8)</option>
              <option value="custom">Custom</option>
            </select>
            <input
              aria-label="Throat diameter (mm)"
              className="field-input"
              type="number"
              step="0.1"
              value={formatNumber(state.throatDiameterMm, 1)}
              onChange={(e) => applyPatch({ throatDiameterMm: Number(e.target.value) || 0 })}
            />
          </div>
        )}
      </div>

      {/* Throat Angle */}
      <div className="field-row">
        <div className="field-label">THROAT ANGLE <span className="units">deg half</span></div>
        <input
          className="field-input"
          type="number"
          step="0.1"
          value={formatNumber(state.throatAngleDeg, 2)}
          onChange={(e) => applyPatch({ throatAngleDeg: Number(e.target.value) || 0 })}
        />
      </div>

      {state.throatShape !== 'rect' && (
        <div className="field-row">
          <div className="field-label">MOUTH SHAPE</div>
          <div className="type-toggle">
            <button
              className={`type-toggle-btn ${state.mode === 'round' ? 'active' : ''}`}
              onClick={() => applyPatch({
                mode: 'round',
                coverageV: state.coverageH,
                mouthHeightMm: state.mouthWidthMm,
              })}
            >
              Round
            </button>
            <button
              className={`type-toggle-btn ${state.mode === 'rect' ? 'active' : ''}`}
              onClick={() => applyPatch({ mode: 'rect', coverageV: 60 })}
            >
              Rect
            </button>
          </div>
          {state.mode === 'rect' && state.throatShape === 'round' && (
            <div className="estimate-text">
              Rect mouth uses ATH morph from the round throat.
            </div>
          )}
        </div>
      )}

      {state.mode === 'rect' && (
        <div className="field-row">
          <div className="field-label">GUIDING CURVE</div>
          <div className="type-toggle">
            <button
              className={`type-toggle-btn ${state.guideType === 0 ? 'active' : ''}`}
              onClick={() => applyPatch({ guideType: 0 })}
            >
              Off
            </button>
            <button
              className={`type-toggle-btn ${state.guideType === 1 ? 'active' : ''}`}
              onClick={() => applyPatch({ guideType: 1 })}
            >
              Superellipse
            </button>
            <button
              className={`type-toggle-btn ${state.guideType === 2 ? 'active' : ''}`}
              onClick={() => applyPatch({ guideType: 2 })}
            >
              Superformula
            </button>
          </div>
          <div className="estimate-text">
            {guideActive ? 'Guide Size' : 'Use guide controls to drive rect profile directly.'}
          </div>
          {guideActive && (
            <>
              <div className="field-inline" style={{ marginTop: 4 }}>
                <div className="field-label" style={{ marginBottom: 4 }}>
                  Width / Height
                  <InfoBtn
                    label="Guide Size"
                    text="These values map to ATH guide controls. Width sets GCurve.Width, and Height contributes to GCurve.AspectRatio via Width / Height."
                  />
                </div>
                <input
                  className="field-input"
                  type="number"
                  step="1"
                  aria-label="Guide width for ATH GCurve.Width (mm)"
                  value={formatNumber(state.guideWidthMm, 0)}
                  onChange={(e) => applyPatch({ guideWidthMm: Number(e.target.value) || 0 })}
                  placeholder="GCurve.Width (mm)"
                />
                <input
                  className="field-input"
                  type="number"
                  step="1"
                  aria-label="Guide height for ATH GCurve.AspectRatio (derived)"
                  value={formatNumber(state.guideHeightMm, 0)}
                  onChange={(e) => applyPatch({ guideHeightMm: Number(e.target.value) || 0 })}
                  placeholder="GCurve.Height (derived from Aspect Ratio)"
                />
              </div>
              <div className="field-row" style={{ marginTop: 8 }}>
                <div className="field-label">GUIDE POSITION <span className="units">% depth</span></div>
                <input
                  className="field-input"
                  type="number"
                  step="1"
                  value={formatNumber(state.guideDistPercent, 0)}
                  onChange={(e) => applyPatch({ guideDistPercent: Number(e.target.value) || 0 })}
                />
              </div>
              {state.guideType === 1 ? (
                <div className="field-row" style={{ marginTop: 8 }}>
                  <div className="field-label">SUPERELLIPSE N</div>
                  <input
                    className="field-input"
                    type="number"
                    step="0.1"
                    value={formatNumber(state.guideSuperellipseN, 1)}
                    onChange={(e) => applyPatch({ guideSuperellipseN: Number(e.target.value) || 0 })}
                  />
                </div>
              ) : (
                <div className="field-row" style={{ marginTop: 8 }}>
                  <div className="field-label">SUPERFORMULA</div>
                  <input
                    className="field-input"
                    type="text"
                    value={state.guideSuperformulaText}
                    onChange={(e) => applyPatch({ guideSuperformulaText: e.target.value })}
                    placeholder="a,b,m,n1,n2,n3"
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Coverage */}
      {!guideActive ? (
        <div className="field-row">
          <div className="field-label">COVERAGE <span className="units">deg full</span></div>
          <div className="chip-row">
            {coveragePresets.map((p) => (
              <button
                key={p.id}
                className="chip"
                onClick={() => applyPatch({ coverageH: p.h, coverageV: p.v })}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="field-inline">
            <input
              className="field-input"
              type="number"
              step="1"
              value={formatNumber(state.coverageH, 0)}
              onChange={(e) => applyPatch({ coverageH: Number(e.target.value) || 0 })}
              placeholder="H"
            />
            {usesDualCoverage && (
              <input
                className="field-input"
                type="number"
                step="1"
                value={formatNumber(state.coverageV, 0)}
                onChange={(e) => applyPatch({ coverageV: Number(e.target.value) || 0 })}
                placeholder="V"
              />
            )}
          </div>
        </div>
      ) : (
        <div className="field-row">
          <div className="field-label">COVERAGE</div>
          <div className="estimate-text">
            Guiding curve mode defines the wall shape directly, so explicit coverage is not used here.
          </div>
        </div>
      )}

      {/* Size */}
      <div className="field-row">
        <div className="field-label">SIZE</div>
        {guideActive ? (
          <>
            <input
              className="field-input"
              type="number"
              step="1"
              value={formatNumber(state.depthMm, 0)}
              onChange={(e) => applyPatch({ depthMm: Number(e.target.value) || 0 })}
              placeholder="Depth mm"
            />
            <div className="field-inline" style={{ marginTop: 4 }}>
              <input
                className="field-input"
                type="number"
                step="1"
                value={formatNumber(state.mouthWidthMm, 0)}
                onChange={(e) => applyPatch({ mouthWidthMm: Number(e.target.value) || 0 })}
                placeholder="Width mm"
              />
              <input
                className="field-input"
                type="number"
                step="1"
                value={formatNumber(state.mouthHeightMm, 0)}
                onChange={(e) => applyPatch({ mouthHeightMm: Number(e.target.value) || 0 })}
                placeholder="Height mm"
              />
            </div>
            <div className="estimate-text">
              Depth and mouth size stay explicit in guiding-curve mode.
            </div>
          </>
        ) : (
          <>
            <select
              className="field-select"
              value={state.sizeMode}
              onChange={(e) => applyPatch({ sizeMode: (e.target.value === 'mouth' ? 'mouth' : 'depth') as SizeMode })}
            >
              <option value="depth">Set depth</option>
              <option value="mouth">Set mouth</option>
            </select>
            {state.sizeMode === 'depth' ? (
              <>
                <input
                  className="field-input"
                  type="number"
                  step="1"
                  value={formatNumber(state.depthMm, 0)}
                  onChange={(e) => applyPatch({ depthMm: Number(e.target.value) || 0 })}
                  placeholder="Depth mm"
                  style={{ marginTop: 4 }}
                />
                <div className="estimate-text">
                  Mouth: {formatNumber(derived.mouthWidthMm, 0)}
                  {state.mode === 'rect' ? ` x ${formatNumber(derived.mouthHeightMm, 0)}` : ''} mm
                </div>
              </>
            ) : (
              <>
                <div className="field-inline" style={{ marginTop: 4 }}>
                  <input
                    className="field-input"
                    type="number"
                    step="1"
                    value={formatNumber(state.mouthWidthMm, 0)}
                    onChange={(e) => applyPatch({ mouthWidthMm: Number(e.target.value) || 0 })}
                    placeholder={state.mode === 'rect' ? 'Width mm' : 'Dia mm'}
                  />
                  {state.mode === 'rect' && (
                    <input
                      className="field-input"
                      type="number"
                      step="1"
                      value={formatNumber(state.mouthHeightMm, 0)}
                      onChange={(e) => applyPatch({ mouthHeightMm: Number(e.target.value) || 0 })}
                      placeholder="Height mm"
                    />
                  )}
                </div>
                <div className="estimate-text">
                  Depth: {formatNumber(derived.depthMm, 0)} mm
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* Corner Radius (rect only) */}
      {state.mode === 'rect' && state.throatShape !== 'rect' && (
        <div className="field-row">
          <div className="field-label">CORNER RADIUS <span className="units">mm</span></div>
          <input
            className="field-input"
            type="number"
            step="1"
            value={formatNumber(state.cornerRadiusMm, 0)}
            onChange={(e) => applyPatch({ cornerRadiusMm: Number(e.target.value) || 0 })}
          />
        </div>
      )}

      {/* Mouth Edge */}
      <div className="field-row">
        <div className="field-label">MOUTH EDGE</div>
        <select
          className="field-select"
          value={state.mouthTermination}
          onChange={(e) => applyPatch({ mouthTermination: e.target.value === 'r-osse' ? 'r-osse' : 'none' })}
        >
          <option value="none">None</option>
          <option value="r-osse">Rolled lip (R-OSSE)</option>
        </select>
        {state.mouthTermination === 'r-osse' && (
          <input
            className="field-input"
            type="number"
            step="1"
            value={formatNumber(state.rollbackAngleDeg, 0)}
            onChange={(e) => applyPatch({ rollbackAngleDeg: Number(e.target.value) || 0 })}
            placeholder="Rollback deg"
            style={{ marginTop: 4 }}
          />
        )}
      </div>
    </>
  )
}

// ---- Geometry Section (Advanced) ----

function GeometrySection({
  schema,
  values,
  setValue,
  showAdvanced,
}: {
  schema: NonNullable<ReturnType<typeof useStudioStore.getState>['schema']>
  values: Record<string, unknown>
  setValue: (key: string, value: unknown) => void
  showAdvanced: boolean
}) {
  const geoSection = schema.sections.find((s) => s.id === 'geometry')
  const shapeSection = schema.sections.find((s) => s.id === 'shape')
  if (!geoSection && !shapeSection) return <div className="muted" style={{ fontSize: 11 }}>No geometry fields.</div>

  return (
    <>
      {geoSection && geoSection.groups.map((group) => (
        <SchemaSectionGroup key={group.id} group={group} schema={schema} values={values} setValue={setValue} showAdvanced={showAdvanced} />
      ))}
      {shapeSection && (
        <>
          <hr className="field-divider" />
          {shapeSection.groups.map((group) => (
            <SchemaSectionGroup key={group.id} group={group} schema={schema} values={values} setValue={setValue} showAdvanced={showAdvanced} />
          ))}
        </>
      )}
    </>
  )
}

// ---- Mesh Section ----

function MeshSection({
  schema,
  values,
  setValue,
  showAdvanced,
  handleMeshQualityChange,
}: {
  schema: NonNullable<ReturnType<typeof useStudioStore.getState>['schema']>
  values: Record<string, unknown>
  setValue: (key: string, value: unknown) => void
  showAdvanced: boolean
  handleMeshQualityChange: (preset: string) => void
}) {
  const meshSection = schema.sections.find((s) => s.id === 'mesh')
  if (!meshSection) return null

  const meshQuality = values['_athui.MeshQuality']
  const hideMeshQualityControls = meshQuality !== 'custom'

  return (
    <>
      {/* Quality preset */}
      <div className="field-row">
        <div className="field-label">QUALITY</div>
        <select
          className="field-select"
          value={typeof meshQuality === 'string' ? meshQuality : 'high'}
          onChange={(e) => handleMeshQualityChange(e.target.value)}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="ultra">Ultra</option>
          <option value="custom">Custom</option>
        </select>
      </div>

      {/* Custom mesh params */}
      {meshQuality === 'custom' && (
        <>
          <CompactItemField itemKey="Mesh.AngularSegments" schema={schema} values={values} setValue={setValue} />
          <CompactItemField itemKey="Mesh.LengthSegments" schema={schema} values={values} setValue={setValue} />
          <CompactItemField itemKey="Mesh.CornerSegments" schema={schema} values={values} setValue={setValue} />
          <CompactItemField itemKey="Mesh.ThroatResolution" schema={schema} values={values} setValue={setValue} />
          <CompactItemField itemKey="Mesh.MouthResolution" schema={schema} values={values} setValue={setValue} />
        </>
      )}

      {/* BEM Quadrants */}
      <CompactItemField itemKey="Mesh.Quadrants" schema={schema} values={values} setValue={setValue} />

      {/* Advanced subdomain/free-standing groups */}
      {showAdvanced && meshSection.groups
        .filter((g) => g.id === 'subdomains' || g.id === 'freeStanding')
        .map((group) => (
          <SchemaSectionGroup key={group.id} group={group} schema={schema} values={values} setValue={setValue} showAdvanced={showAdvanced} />
        ))}
    </>
  )
}

// ---- Simulation Section (Advanced) ----

function SimulationSection({
  schema,
  values,
  setValue,
  showAdvanced,
}: {
  schema: NonNullable<ReturnType<typeof useStudioStore.getState>['schema']>
  values: Record<string, unknown>
  setValue: (key: string, value: unknown) => void
  showAdvanced: boolean
}) {
  const abecSection = schema.sections.find((s) => s.id === 'abec')
  if (!abecSection) return null

  return (
    <>
      {abecSection.groups.map((group) => (
        <SchemaSectionGroup key={group.id} group={group} schema={schema} values={values} setValue={setValue} showAdvanced={showAdvanced} />
      ))}
    </>
  )
}

// ---- Output Section ----

function OutputSection({
  schema,
  values,
  setValue,
  showAdvanced,
}: {
  schema: NonNullable<ReturnType<typeof useStudioStore.getState>['schema']>
  values: Record<string, unknown>
  setValue: (key: string, value: unknown) => void
  showAdvanced: boolean
}) {
  const outputSection = schema.sections.find((s) => s.id === 'output')
  const projectSection = schema.sections.find((s) => s.id === 'project')
  if (!outputSection) return null

  return (
    <>
      {outputSection.groups.map((group) => (
        <SchemaSectionGroup key={group.id} group={group} schema={schema} values={values} setValue={setValue} showAdvanced={showAdvanced} />
      ))}
      {showAdvanced && projectSection && (
        <>
          <hr className="field-divider" />
          {projectSection.groups.map((group) => (
            <SchemaSectionGroup key={group.id} group={group} schema={schema} values={values} setValue={setValue} showAdvanced={showAdvanced} />
          ))}
        </>
      )}
    </>
  )
}

// ---- Schema-driven Section Group ----

function SchemaSectionGroup({
  group,
  schema,
  values,
  setValue,
  showAdvanced,
}: {
  group: { id: string; title: string; items: string[] }
  schema: NonNullable<ReturnType<typeof useStudioStore.getState>['schema']>
  values: Record<string, unknown>
  setValue: (key: string, value: unknown) => void
  showAdvanced: boolean
}) {
  const visibleItems = group.items.filter((key) => {
    const spec = schema.items[key]
    if (!spec) return false
    if (!showAdvanced && spec.ui.advanced) return false
    return isItemVisible(spec, values)
  })

  if (visibleItems.length === 0) return null

  return (
    <div style={{ marginBottom: 8 }}>
      <div className="field-label" style={{ marginBottom: 4, fontWeight: 600, fontSize: 10, opacity: 0.6 }}>
        {group.title}
      </div>
      {visibleItems.map((key) => (
        <CompactItemField key={key} itemKey={key} schema={schema} values={values} setValue={setValue} />
      ))}
    </div>
  )
}

// ---- Compact Item Field (renders any schema item) ----

function CompactItemField({
  itemKey,
  schema,
  values,
  setValue,
}: {
  itemKey: string
  schema: NonNullable<ReturnType<typeof useStudioStore.getState>['schema']>
  values: Record<string, unknown>
  setValue: (key: string, value: unknown) => void
}) {
  const spec = schema.items[itemKey]
  if (!spec) return null

  const value = values[itemKey]
  const required = isItemRequired(spec, values)
  const [error, parsed] = validateAndParse(spec, value, required)

  function onChange(raw: string) {
    const next = parseFromInput(spec.valueType, raw)
    setValue(itemKey, next)
  }

  function handleSelectChange(raw: string) {
    if (raw === '' && required && spec.default !== undefined) {
      setValue(itemKey, spec.default)
      return
    }
    if (itemKey === '_athui.MeshQuality') {
      setValue(itemKey, raw)
      const preset = raw as MeshQualityPreset
      if (preset && preset !== 'custom') {
        const next = getMeshQualityPresetValues(preset)
        for (const key of meshQualityKeys) {
          const v = next[key]
          if (v !== undefined) setValue(key, v)
        }
      }
      return
    }
    onChange(raw)
  }

  // Checkbox
  if (spec.ui.widget === 'checkbox') {
    return (
      <div className="field-row">
        <div className="field-checkbox-row">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => setValue(itemKey, e.target.checked)}
            id={`f-${itemKey}`}
          />
          <label htmlFor={`f-${itemKey}`}>{spec.label}</label>
          {spec.ui.help && <InfoBtn text={spec.ui.help} label={spec.label} />}
        </div>
      </div>
    )
  }

  // Select
  if (spec.ui.widget === 'select' && spec.ui.options) {
    const stringValue = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
    return (
      <div className="field-row">
        <div className="field-label">
          {spec.label}
          {spec.units ? <span className="units">({spec.units})</span> : null}
          {spec.ui.help && <InfoBtn text={spec.ui.help} label={spec.label} />}
        </div>
        <select
          className="field-select"
          value={stringValue}
          onChange={(e) => {
            handleSelectChange(e.target.value)
          }}
        >
          <option value="" disabled={required}>-</option>
          {spec.ui.options.map((opt) => (
            <option key={String(opt.value)} value={String(opt.value)}>{opt.label}</option>
          ))}
        </select>
        {error && <div className="field-error">{error}</div>}
      </div>
    )
  }

  // Folder
  if (spec.ui.widget === 'folder') {
    const stringValue = typeof value === 'string' ? value : ''
    return (
      <div className="field-row">
        <div className="field-label">
          {spec.label}
          {spec.ui.help && <InfoBtn text={spec.ui.help} label={spec.label} />}
        </div>
        <FolderInput
          value={stringValue}
          placeholder={spec.ui.placeholder}
          onChange={(next) => setValue(itemKey, next)}
        />
      </div>
    )
  }

  // Number list
  if (spec.ui.widget === 'numberList') {
    const toString = (v: unknown) => {
      if (v === undefined) return ''
      if (v === null) return '[]'
      if (Array.isArray(v)) return v.length === 0 ? '[]' : v.join(', ')
      return typeof v === 'string' ? v : ''
    }
    const parse = (rawInput: string) => {
      const trimmed = rawInput.trim()
      if (trimmed === '') return undefined
      if (trimmed === '[]') return []
      const parts = trimmed.split(',').map((p) => p.trim()).filter(Boolean)
      const numbers = parts.map((p) => Number(p)).filter((n) => Number.isFinite(n))
      if (spec.valueType === 'i[]') return numbers.map((n) => Math.trunc(n))
      return numbers
    }
    const raw = toString(value)
    return (
      <div className="field-row">
        <div className="field-label">
          {spec.label}
          {spec.units ? <span className="units">({spec.units})</span> : null}
          {spec.ui.help && <InfoBtn text={spec.ui.help} label={spec.label} />}
        </div>
        <input
          className="field-input"
          type="text"
          placeholder={spec.ui.placeholder}
          value={raw}
          onChange={(e) => setValue(itemKey, parse(e.target.value))}
        />
        {error && <div className="field-error">{error}</div>}
      </div>
    )
  }

  // Horn parts
  if (spec.ui.widget === 'hornParts') {
    return (
      <div className="field-row">
        <div className="field-label">
          {spec.label}
          {spec.ui.help && <InfoBtn text={spec.ui.help} label={spec.label} />}
        </div>
        <Suspense fallback={<div className="muted" style={{ fontSize: 11 }}>Loading...</div>}>
          <HornPartsEditor
            value={value as import('./components/HornPartsEditor').HornPartsValue | undefined}
            onChange={(v) => setValue(itemKey, v)}
          />
        </Suspense>
      </div>
    )
  }

  // Textarea
  if (spec.ui.widget === 'textarea') {
    const stringValue = typeof parsed === 'number' || typeof parsed === 'string' ? String(parsed) : ''
    return (
      <div className="field-row">
        <div className="field-label">
          {spec.label}
          {spec.units ? <span className="units">({spec.units})</span> : null}
          {spec.ui.help && <InfoBtn text={spec.ui.help} label={spec.label} />}
        </div>
        <textarea
          className="field-textarea"
          placeholder={spec.ui.placeholder}
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
        />
        {error && <div className="field-error">{error}</div>}
      </div>
    )
  }

  // Text / Number (default)
  const inputType = spec.valueType === 'i' || spec.valueType === 'f' ? 'number' : 'text'
  const stringValue = typeof parsed === 'number' || typeof parsed === 'string' ? String(parsed) : ''
  const inputMode = spec.valueType === 'i' ? 'numeric' as const : spec.valueType === 'f' ? 'decimal' as const : undefined
  const step = spec.valueType === 'i' ? 1 : spec.valueType === 'f' ? 'any' : undefined

  return (
    <div className="field-row">
      <div className="field-label">
        {spec.label}
        {spec.units ? <span className="units">({spec.units})</span> : null}
        {spec.ui.help && <InfoBtn text={spec.ui.help} label={spec.label} />}
      </div>
      <input
        className="field-input"
        type={inputType}
        inputMode={inputMode}
        step={step}
        placeholder={spec.ui.placeholder}
        value={stringValue}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <div className="field-error">{error}</div>}
    </div>
  )
}

// ---- InfoBtn ----

function InfoBtn({ label, text }: { label: string; text: string }) {
  return (
    <button className="info-btn" type="button" aria-label={`Help: ${label}`} title={text}>
      i
    </button>
  )
}

// ---- FolderInput ----

function FolderInput({
  value,
  placeholder,
  onChange,
}: {
  value: string
  placeholder?: string
  onChange: (value: string) => void
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  async function pickDirectory() {
    const win = window as Window & { showDirectoryPicker?: () => Promise<{ name: string }> }
    if (typeof win.showDirectoryPicker === 'function') {
      try {
        const handle = await win.showDirectoryPicker()
        onChange(handle.name)
        return
      } catch {
        // ignore
      }
    }
    fileInputRef.current?.click()
  }

  return (
    <div className="folder-row">
      <input
        className="field-input"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <button className="folder-btn" type="button" onClick={pickDirectory}>
        Browse
      </button>
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        multiple
        {...({ webkitdirectory: '', directory: '' } as unknown as React.InputHTMLAttributes<HTMLInputElement>)}
        onChange={(e) => {
          const first = e.currentTarget.files?.[0] as (File & { webkitRelativePath?: string }) | undefined
          const rel = first?.webkitRelativePath
          const dirName = rel ? rel.split('/')[0] : ''
          if (dirName) onChange(dirName)
          e.currentTarget.value = ''
        }}
      />
    </div>
  )
}
