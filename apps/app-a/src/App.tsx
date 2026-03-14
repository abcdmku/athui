import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { api } from './api/client'
import {
  applyMeshQualityPreset,
  getMeshQualityPresetValues,
  meshQualityKeys,
  type MeshQualityPreset,
} from './mesh/qualityPresets'
import { defaultSchema } from './schema/defaultSchema'
import { buildProjectCfgText, isItemRequired, isItemVisible } from './schema/cfg'
import type { ItemSpec } from './schema/types'
import { useStudioStore } from './state/store'

const GeometryPreview = React.lazy(() =>
  import('./components/GeometryPreview').then((m) => ({ default: m.GeometryPreview })),
)
const StlProfile = React.lazy(() => import('./components/StlProfile').then((m) => ({ default: m.StlProfile })))
const ProfilesCsvProfile = React.lazy(() =>
  import('./components/ProfilesCsvProfile').then((m) => ({ default: m.ProfilesCsvProfile })),
)
const HornPartsEditor = React.lazy(() =>
  import('./components/HornPartsEditor').then((m) => ({ default: m.HornPartsEditor })),
)

// ─── Horn Designer Logic ─────────────────────────────────────────────────────

type Mode = 'round' | 'rect'
type SizeMode = 'depth' | 'mouth'

type DesignerState = {
  mode: Mode
  coverageH: number
  coverageV: number
  sizeMode: SizeMode
  depthMm: number
  mouthWidthMm: number
  mouthHeightMm: number
  throatDiameterMm: number
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

  const modeRaw = values[KEY_MODE]
  const inferredMode: Mode = asNumber(values['Morph.TargetShape']) === 1 ? 'rect' : 'round'
  const mode: Mode = modeRaw === 'rect' || modeRaw === 'round' ? modeRaw : inferredMode

  const covFromCfgHalf = parseAngleExprToNumber(values['Coverage.Angle'])
  const fallbackCoverage = covFromCfgHalf !== null ? clamp(covFromCfgHalf * 2, 20, 160) : 90

  const coverageH = clamp(asNumber(values[KEY_COV_H]) ?? fallbackCoverage, 20, 160)
  const coverageVDefault = mode === 'rect' ? 60 : coverageH
  const coverageV = clamp(asNumber(values[KEY_COV_V]) ?? coverageVDefault, 20, 160)

  const sizeModeRaw = values[KEY_SIZE_MODE]
  const sizeMode: SizeMode = sizeModeRaw === 'mouth' ? 'mouth' : 'depth'

  const depthFromCfg = parseAngleExprToNumber(values['Length'])
  const depthMm = clamp(asNumber(values[KEY_DEPTH]) ?? depthFromCfg ?? 120, 10, 1000)

  const targetWFromCfg = asNumber(values['Morph.TargetWidth'])
  const targetHFromCfg = asNumber(values['Morph.TargetHeight'])

  const estimatedW = estimateMouthDim(throatDiameterMm, depthMm, coverageH)
  const estimatedH = mode === 'round' ? estimatedW : estimateMouthDim(throatDiameterMm, depthMm, coverageV)

  const mouthWidthMm = clamp(asNumber(values[KEY_MOUTH_W]) ?? targetWFromCfg ?? estimatedW, throatDiameterMm, 2000)
  const mouthHeightMm = clamp(asNumber(values[KEY_MOUTH_H]) ?? targetHFromCfg ?? estimatedH, throatDiameterMm, 2000)

  const mouthTerminationRaw = values['_athui.MouthTermination']
  const mouthTermination: 'none' | 'r-osse' = mouthTerminationRaw === 'r-osse' ? 'r-osse' : 'none'
  const rollbackAngleDeg = clamp(asNumber(values['_athui.RollbackAngleDeg']) ?? 180, 0, 360)

  const cornerRadiusMm = clamp(asNumber(values['Morph.CornerRadius']) ?? 35, 0, 500)

  return {
    mode,
    coverageH,
    coverageV: mode === 'round' ? coverageH : coverageV,
    sizeMode,
    depthMm,
    mouthWidthMm,
    mouthHeightMm: mode === 'round' ? mouthWidthMm : mouthHeightMm,
    throatDiameterMm,
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
  const clampedH = clamp(s.coverageH, 20, 160)
  const clampedV = clamp(s.mode === 'round' ? clampedH : s.coverageV, 20, 160)

  if (s.sizeMode === 'depth') {
    const depth = clamp(s.depthMm, 10, 1000)
    const mouthW = estimateMouthDim(s.throatDiameterMm, depth, clampedH)
    const mouthH = s.mode === 'round' ? mouthW : estimateMouthDim(s.throatDiameterMm, depth, clampedV)
    return { depthMm: depth, mouthWidthMm: mouthW, mouthHeightMm: mouthH }
  }

  const mouthW = clamp(s.mouthWidthMm, s.throatDiameterMm, 2000)
  const mouthH = s.mode === 'round' ? mouthW : clamp(s.mouthHeightMm, s.throatDiameterMm, 2000)

  const depthH = estimateDepthFromMouth(s.throatDiameterMm, mouthW, clampedH)
  const depthV = estimateDepthFromMouth(s.throatDiameterMm, mouthH, clampedV)

  const candidates = [depthH, depthV].filter((d): d is number => typeof d === 'number' && Number.isFinite(d) && d >= 0)
  const depth = candidates.length ? Math.min(...candidates) : s.depthMm

  return { depthMm: clamp(depth, 10, 1000), mouthWidthMm: mouthW, mouthHeightMm: mouthH }
}

// ─── File Picking Logic ──────────────────────────────────────────────────────

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
  const stlFiles = files.filter(
    (x) => x.path.toLowerCase().endsWith('.stl') && !x.path.toLowerCase().includes('bem_mesh'),
  )
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
    const rollbackProfiles = list.find(
      (x) => x.path.toLowerCase().includes('rollback') && x.path.toLowerCase().includes('profiles'),
    )
    if (rollbackProfiles) return rollbackProfiles.path
    const preferredNames = [
      'project_profiles_athui.csv',
      'mesh_profiles_athui.csv',
      'project_profiles.csv',
      'mesh_profiles.csv',
    ]
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

// ─── Validation / Parsing helpers ────────────────────────────────────────────

function validateAndParse(
  spec: ItemSpec,
  value: unknown,
  required: boolean,
): [string | null, string | number | boolean] {
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

// ─── Bottom-Left tab types ───────────────────────────────────────────────────

type SettingsTab = 'mesh' | 'simulation' | 'outputs'
type OutputTab = 'logs' | 'profile' | 'files'

// ─── Main App ────────────────────────────────────────────────────────────────

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

  const [busy, setBusy] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('mesh')
  const [outputTab, setOutputTab] = useState<OutputTab>('logs')

  // ─── Boot ───
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
    return () => {
      cancelled = true
    }
  }, [appendLogs, setProjectId])

  // ─── WebSocket ───
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

  // ─── Auto-refresh after exit lines ───
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

  // ─── Designer state ───
  const designerState = useMemo(() => deriveDesignerState(values), [values])
  const derived = useMemo(() => computeDerived(designerState), [designerState])

  const applyPatch = useCallback(
    (partial: Partial<DesignerState>) => {
      const next0: DesignerState = { ...designerState, ...partial }
      const mode = next0.mode === 'rect' ? 'rect' : 'round'
      const coverageH = clamp(next0.coverageH, 20, 160)
      const coverageV = clamp(mode === 'round' ? coverageH : next0.coverageV, 20, 160)
      const sizeMode: SizeMode = next0.sizeMode === 'mouth' ? 'mouth' : 'depth'
      const throatDiameterMm = clamp(next0.throatDiameterMm, 5, 200)
      const throatAngleDeg = clamp(next0.throatAngleDeg, 0, 30)
      const mouthTermination: 'none' | 'r-osse' = next0.mouthTermination === 'r-osse' ? 'r-osse' : 'none'
      const rollbackAngleDeg = clamp(next0.rollbackAngleDeg, 0, 360)

      const normalized: DesignerState = {
        ...next0,
        mode,
        coverageH,
        coverageV,
        sizeMode,
        throatDiameterMm,
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

      const updates: Record<string, unknown> = {
        [KEY_MODE]: mode,
        [KEY_COV_H]: coverageH,
        [KEY_COV_V]: coverageV,
        [KEY_SIZE_MODE]: sizeMode,
        [KEY_DEPTH]: depthMm,
        [KEY_MOUTH_W]: mouthWidthMm,
        [KEY_MOUTH_H]: mouthHeightMm,
        HornGeometry: 1,
        'Throat.Profile': 1,
        'Throat.Diameter': throatDiameterMm,
        'Throat.Angle': formatNumber(throatAngleDeg),
        'GCurve.Type': undefined,
        'Coverage.Angle': coverageAngleExpr,
        Length: formatNumber(depthMm),
        'Morph.TargetShape': mode === 'rect' ? 1 : 0,
        'Morph.TargetWidth': mode === 'rect' ? mouthWidthMm : 0,
        'Morph.TargetHeight': mode === 'rect' ? mouthHeightMm : 0,
        'Morph.CornerRadius': cornerRadiusMm,
        '_athui.MouthTermination': normalized.mouthTermination,
        '_athui.RollbackAngleDeg': normalized.rollbackAngleDeg,
      }
      setValues(updates)
    },
    [designerState, setValues],
  )

  // ─── Run ───
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
      setOutputTab('logs')
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

  // ─── Derived preview data ───
  const stlPath = meshFilePath ?? geometryFilePath
  const throatPreset = findNearestThroatPreset(designerState.throatDiameterMm)

  const coveragePresets =
    designerState.mode === 'rect'
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

  const meshQuality = values['_athui.MeshQuality'] as MeshQualityPreset | undefined

  // Simple mode items for the schema
  const simpleGeomKeys = [
    'Throat.Profile',
    'Throat.Diameter',
    'Throat.Angle',
    'Coverage.Angle',
    'Length',
    'OS.k',
    'Term.s',
    'Term.q',
    'Term.n',
    'CircArc.Radius',
    'CircArc.TermAngle',
  ]

  // Advanced geometry keys
  const advancedGeomKeys = [
    'Throat.Ext.Length',
    'Throat.Ext.Angle',
    'Slot.Length',
    'Rot',
    'GCurve.Type',
    'GCurve.Dist',
    'GCurve.Width',
    'GCurve.AspectRatio',
    'GCurve.SE.n',
    'GCurve.SF',
    'GCurve.Rot',
    'HornGeometry',
    'Horn.Adapter.Width',
    'Horn.Adapter.Height',
    'Horn.Adapter.Length',
    'Horn.Adapter.k',
    'Horn.Adapter.Segments',
    '_athui.HornParts',
    'Morph.TargetShape',
    'Morph.TargetWidth',
    'Morph.TargetHeight',
    'Morph.CornerRadius',
    'Morph.FixedPart',
    'Morph.Rate',
    'Morph.AllowShrinkage',
    '_athui.MouthTermination',
    '_athui.RollbackAngleDeg',
    '_athui.RollbackMm',
  ]

  return (
    <div className="app-shell">
      {/* ───── Header ───── */}
      <header className="header-bar">
        <div className="header-left">Horn Studio</div>
        <div className="header-center">
          <div className="segmented">
            <button
              type="button"
              className={clsx(!showAdvanced && 'active')}
              onClick={() => setShowAdvanced(false)}
            >
              Simple
            </button>
            <button
              type="button"
              className={clsx(showAdvanced && 'active')}
              onClick={() => setShowAdvanced(true)}
            >
              Advanced
            </button>
          </div>
        </div>
        <div className="header-right">
          <div className={clsx('dirty-dot', dirty ? 'dirty' : 'clean')} title={dirty ? 'Unsaved changes' : 'Up to date'} />
          <button
            className="btn btn-icon"
            onClick={handleRefreshFiles}
            disabled={!projectId}
            type="button"
            title="Refresh files"
          >
            &#8635;
          </button>
          <button
            className={clsx('btn', 'btn-primary')}
            onClick={handleRun}
            disabled={!projectId || busy}
            type="button"
          >
            {busy ? 'Running...' : 'Run'}
          </button>
        </div>
      </header>

      {/* ───── Dashboard Grid ───── */}
      <div className="dashboard">
        {/* ── Top-Left: Geometry ── */}
        <div className="quadrant">
          <div className="quad-header">
            <span className="quad-title">Geometry</span>
          </div>
          <div className="quad-body">
            {/* Simple mode: Horn Designer fields */}
            <div className="section-divider">Type</div>
            <div className="field-row">
              <span className="field-label">Horn Shape</span>
              <div className="toggle-group">
                <button
                  type="button"
                  className={clsx('toggle-btn', designerState.mode === 'round' && 'active')}
                  onClick={() => applyPatch({ mode: 'round', coverageV: designerState.coverageH })}
                >
                  Round
                </button>
                <button
                  type="button"
                  className={clsx('toggle-btn', designerState.mode === 'rect' && 'active')}
                  onClick={() => applyPatch({ mode: 'rect', coverageV: 60 })}
                >
                  Rect
                </button>
              </div>
            </div>

            <div className="section-divider">Throat</div>
            <div className="field-row">
              <span className="field-label">Diameter <span className="units">mm</span></span>
              <div className="preset-row">
                <button
                  type="button"
                  className={clsx('preset-btn', throatPreset === 25.4 && 'active')}
                  onClick={() => applyPatch({ throatDiameterMm: 25.4 })}
                >
                  1&quot;
                </button>
                <button
                  type="button"
                  className={clsx('preset-btn', throatPreset === 34 && 'active')}
                  onClick={() => applyPatch({ throatDiameterMm: 34 })}
                >
                  1.4&quot;
                </button>
                <button
                  type="button"
                  className={clsx('preset-btn', throatPreset === 50.8 && 'active')}
                  onClick={() => applyPatch({ throatDiameterMm: 50.8 })}
                >
                  2&quot;
                </button>
                <input
                  className="input"
                  type="number"
                  step="0.1"
                  style={{ width: 70 }}
                  value={formatNumber(designerState.throatDiameterMm, 1)}
                  onChange={(e) => applyPatch({ throatDiameterMm: Number(e.target.value) || 0 })}
                />
              </div>
            </div>
            <div className="field-row">
              <span className="field-label">
                Throat Angle <span className="units">deg</span>
                <InfoTip text="Driver exit half-angle. Typical: 7." />
              </span>
              <input
                className="input"
                type="number"
                step="0.1"
                value={formatNumber(designerState.throatAngleDeg, 2)}
                onChange={(e) => applyPatch({ throatAngleDeg: Number(e.target.value) || 0 })}
              />
            </div>

            <div className="section-divider">Coverage</div>
            <div className="chip-row">
              {coveragePresets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={clsx(
                    'chip',
                    designerState.coverageH === p.h && designerState.coverageV === p.v && 'active',
                  )}
                  onClick={() => applyPatch({ coverageH: p.h, coverageV: p.v })}
                >
                  {p.label}&deg;
                </button>
              ))}
            </div>
            <div className="field-row" style={{ marginTop: 4 }}>
              <span className="field-label">
                {designerState.mode === 'rect' ? 'H x V' : 'Full angle'} <span className="units">deg</span>
              </span>
              <div style={{ display: 'flex', gap: 4 }}>
                <input
                  className="input"
                  type="number"
                  step="1"
                  value={formatNumber(designerState.coverageH, 0)}
                  onChange={(e) => applyPatch({ coverageH: Number(e.target.value) || 0 })}
                  style={designerState.mode === 'rect' ? { width: '50%' } : undefined}
                />
                {designerState.mode === 'rect' && (
                  <input
                    className="input"
                    type="number"
                    step="1"
                    style={{ width: '50%' }}
                    value={formatNumber(designerState.coverageV, 0)}
                    onChange={(e) => applyPatch({ coverageV: Number(e.target.value) || 0 })}
                  />
                )}
              </div>
            </div>

            <div className="section-divider">Size</div>
            <div className="field-row">
              <span className="field-label">Define by</span>
              <div className="toggle-group">
                <button
                  type="button"
                  className={clsx('toggle-btn', designerState.sizeMode === 'depth' && 'active')}
                  onClick={() => applyPatch({ sizeMode: 'depth' })}
                >
                  Depth
                </button>
                <button
                  type="button"
                  className={clsx('toggle-btn', designerState.sizeMode === 'mouth' && 'active')}
                  onClick={() => applyPatch({ sizeMode: 'mouth' })}
                >
                  Mouth
                </button>
              </div>
            </div>
            {designerState.sizeMode === 'depth' ? (
              <>
                <div className="field-row">
                  <span className="field-label">Depth <span className="units">mm</span></span>
                  <input
                    className="input"
                    type="number"
                    step="1"
                    value={formatNumber(designerState.depthMm, 0)}
                    onChange={(e) => applyPatch({ depthMm: Number(e.target.value) || 0 })}
                  />
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', padding: '2px 0 4px' }}>
                  Est. mouth: {formatNumber(derived.mouthWidthMm, 0)}
                  {designerState.mode === 'rect' ? ` x ${formatNumber(derived.mouthHeightMm, 0)}` : ''} mm
                </div>
              </>
            ) : (
              <>
                <div className="field-row">
                  <span className="field-label">
                    {designerState.mode === 'rect' ? 'Width' : 'Diameter'} <span className="units">mm</span>
                  </span>
                  <input
                    className="input"
                    type="number"
                    step="1"
                    value={formatNumber(designerState.mouthWidthMm, 0)}
                    onChange={(e) => applyPatch({ mouthWidthMm: Number(e.target.value) || 0 })}
                  />
                </div>
                {designerState.mode === 'rect' && (
                  <div className="field-row">
                    <span className="field-label">Height <span className="units">mm</span></span>
                    <input
                      className="input"
                      type="number"
                      step="1"
                      value={formatNumber(designerState.mouthHeightMm, 0)}
                      onChange={(e) => applyPatch({ mouthHeightMm: Number(e.target.value) || 0 })}
                    />
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'var(--muted)', padding: '2px 0 4px' }}>
                  Est. depth: {formatNumber(derived.depthMm, 0)} mm
                </div>
              </>
            )}

            {designerState.mode === 'rect' && (
              <div className="field-row">
                <span className="field-label">
                  Corner Radius <span className="units">mm</span>
                  <InfoTip text="Rectangle corner rounding at the mouth." />
                </span>
                <input
                  className="input"
                  type="number"
                  step="1"
                  value={formatNumber(designerState.cornerRadiusMm, 0)}
                  onChange={(e) => applyPatch({ cornerRadiusMm: Number(e.target.value) || 0 })}
                />
              </div>
            )}

            <div className="section-divider">Mouth Edge</div>
            <div className="field-row">
              <span className="field-label">Termination</span>
              <select
                className="select"
                value={designerState.mouthTermination}
                onChange={(e) => applyPatch({ mouthTermination: e.target.value === 'r-osse' ? 'r-osse' : 'none' })}
              >
                <option value="none">None</option>
                <option value="r-osse">Rolled lip (R-OSSE)</option>
              </select>
            </div>
            {designerState.mouthTermination === 'r-osse' && (
              <div className="field-row">
                <span className="field-label">Rollback Angle <span className="units">deg</span></span>
                <input
                  className="input"
                  type="number"
                  step="1"
                  value={formatNumber(designerState.rollbackAngleDeg, 0)}
                  onChange={(e) => applyPatch({ rollbackAngleDeg: Number(e.target.value) || 0 })}
                />
              </div>
            )}

            {/* Advanced mode: remaining geometry fields */}
            {showAdvanced && (
              <>
                <div className="section-divider" style={{ marginTop: 12 }}>Advanced Geometry</div>
                <AdvancedFieldList
                  keys={[...simpleGeomKeys, ...advancedGeomKeys]}
                  schema={schema}
                  values={values}
                  setValue={setValue}
                />

                <div className="section-divider" style={{ marginTop: 12 }}>Project Paths</div>
                <AdvancedFieldList
                  keys={['Output.SubDir', 'Output.DestDir', '_athui.MeshCmd', '_athui.GnuplotPath']}
                  schema={schema}
                  values={values}
                  setValue={setValue}
                />
              </>
            )}
          </div>
        </div>

        {/* ── Top-Right: Preview ── */}
        <div className="quadrant">
          <div className="quad-header">
            <span className="quad-title">Preview</span>
          </div>
          <div className="quad-body-nopad">
            {stlPath && (
              <div className="preview-badge">
                {stlPath.split('/').pop()}
              </div>
            )}
            {projectId && stlPath && stlPath.toLowerCase().endsWith('.stl') ? (
              <Suspense fallback={<div className="placeholder">Loading preview...</div>}>
                <GeometryPreview
                  key={`${stlPath}:${outputsRevision}`}
                  modelUrl={`${api.rawFileUrl(projectId, stlPath)}&v=${outputsRevision}`}
                />
              </Suspense>
            ) : (
              <div className="placeholder">
                No mesh available. Run the project to generate geometry.
              </div>
            )}
          </div>
        </div>

        {/* ── Bottom-Left: Settings ── */}
        <div className="quadrant">
          <div className="tabs">
            <button
              type="button"
              className={clsx('tab-btn', settingsTab === 'mesh' && 'active')}
              onClick={() => setSettingsTab('mesh')}
            >
              Mesh
            </button>
            <button
              type="button"
              className={clsx('tab-btn', settingsTab === 'simulation' && 'active')}
              onClick={() => setSettingsTab('simulation')}
            >
              Simulation
            </button>
            <button
              type="button"
              className={clsx('tab-btn', settingsTab === 'outputs' && 'active')}
              onClick={() => setSettingsTab('outputs')}
            >
              Outputs
            </button>
          </div>
          <div className="tab-content">
            {settingsTab === 'mesh' && (
              <MeshTab schema={schema} values={values} setValue={setValue} meshQuality={meshQuality} />
            )}
            {settingsTab === 'simulation' && (
              <SimulationTab schema={schema} values={values} setValue={setValue} showAdvanced={showAdvanced} />
            )}
            {settingsTab === 'outputs' && (
              <OutputsTab schema={schema} values={values} setValue={setValue} showAdvanced={showAdvanced} />
            )}
          </div>
        </div>

        {/* ── Bottom-Right: Output ── */}
        <div className="quadrant">
          <div className="tabs">
            <button
              type="button"
              className={clsx('tab-btn', outputTab === 'logs' && 'active')}
              onClick={() => setOutputTab('logs')}
            >
              Logs
            </button>
            <button
              type="button"
              className={clsx('tab-btn', outputTab === 'profile' && 'active')}
              onClick={() => setOutputTab('profile')}
            >
              Profile
            </button>
            <button
              type="button"
              className={clsx('tab-btn', outputTab === 'files' && 'active')}
              onClick={() => setOutputTab('files')}
            >
              Files
            </button>
          </div>
          {outputTab === 'logs' && (
            <div className="tab-content" style={{ padding: 0 }}>
              <LogsView lines={logs} />
            </div>
          )}
          {outputTab === 'profile' && (
            <div className="tab-content" style={{ padding: 0 }}>
              <ProfilePanel
                projectId={projectId}
                profilesPath={profilesFilePath}
                stlPath={stlPath}
                outputsRevision={outputsRevision}
              />
            </div>
          )}
          {outputTab === 'files' && (
            <div className="tab-content">
              <FilesView files={files} projectId={projectId} onRefresh={handleRefreshFiles} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Mesh Tab ────────────────────────────────────────────────────────────────

function MeshTab({
  schema,
  values,
  setValue,
  meshQuality,
}: {
  schema: typeof defaultSchema | null
  values: Record<string, unknown>
  setValue: (key: string, value: unknown) => void
  meshQuality: MeshQualityPreset | undefined
}) {
  if (!schema) return null

  const handleQualityChange = (raw: string) => {
    setValue('_athui.MeshQuality', raw)
    const preset = raw as MeshQualityPreset
    if (preset && preset !== 'custom') {
      const next = getMeshQualityPresetValues(preset)
      for (const key of meshQualityKeys) {
        const v = next[key]
        if (v !== undefined) setValue(key, v)
      }
    }
  }

  const isCustom = meshQuality === 'custom'

  const meshKeys = [
    'Mesh.Quadrants',
    'Mesh.AngularSegments',
    'Mesh.LengthSegments',
    'Mesh.ThroatResolution',
    'Mesh.MouthResolution',
    'Mesh.CornerSegments',
    'Mesh.ThroatSegments',
  ]

  const subdomainKeys = ['Mesh.SubdomainSlices', 'Mesh.InterfaceOffset', 'Mesh.InterfaceDraw']
  const freeStandingKeys = ['Mesh.RearShape', 'Mesh.WallThickness', 'Mesh.RearResolution', 'Mesh.Enclosure']

  return (
    <div>
      <div className="field-row">
        <span className="field-label">Quality Preset</span>
        <select
          className="select"
          value={meshQuality ?? 'high'}
          onChange={(e) => handleQualityChange(e.target.value)}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="ultra">Ultra</option>
          <option value="custom">Custom</option>
        </select>
      </div>

      {isCustom && (
        <div className="mesh-grid" style={{ marginTop: 8 }}>
          {meshKeys.map((key) => {
            const spec = schema.items[key]
            if (!spec) return null
            if (!isItemVisible(spec, values)) return null
            return <CompactField key={key} itemKey={key} spec={spec} values={values} setValue={setValue} />
          })}
        </div>
      )}

      <div className="section-divider" style={{ marginTop: 10 }}>Subdomains</div>
      {subdomainKeys.map((key) => {
        const spec = schema.items[key]
        if (!spec) return null
        if (!isItemVisible(spec, values)) return null
        return <CompactField key={key} itemKey={key} spec={spec} values={values} setValue={setValue} />
      })}

      <div className="section-divider" style={{ marginTop: 10 }}>Free Standing</div>
      {freeStandingKeys.map((key) => {
        const spec = schema.items[key]
        if (!spec) return null
        if (!isItemVisible(spec, values)) return null
        return <CompactField key={key} itemKey={key} spec={spec} values={values} setValue={setValue} />
      })}
    </div>
  )
}

// ─── Simulation Tab ──────────────────────────────────────────────────────────

function SimulationTab({
  schema,
  values,
  setValue,
  showAdvanced,
}: {
  schema: typeof defaultSchema | null
  values: Record<string, unknown>
  setValue: (key: string, value: unknown) => void
  showAdvanced: boolean
}) {
  if (!schema) return null

  const simKeys = ['ABEC.SimType', 'ABEC.SimProfile', 'ABEC.f1', 'ABEC.f2', 'ABEC.NumFrequencies', 'ABEC.Abscissa', 'ABEC.MeshFrequency']
  const sourceKeys = ['Source.Shape', 'Source.Radius', 'Source.Curv', 'Source.Velocity', 'Source.Contours']
  const leKeys = ['LE', 'LE.System', 'LE.Driver', 'LE.Voltage']
  const observationKeys = ['ABEC.Polars:SPL']

  return (
    <div>
      <div className="section-divider">Simulation</div>
      <div className="sim-grid">
        {simKeys.map((key) => {
          const spec = schema.items[key]
          if (!spec) return null
          if (!isItemVisible(spec, values)) return null
          if (!showAdvanced && spec.ui.advanced) return null
          return <CompactField key={key} itemKey={key} spec={spec} values={values} setValue={setValue} />
        })}
      </div>

      <div className="section-divider" style={{ marginTop: 10 }}>Source</div>
      <div className="sim-grid">
        {sourceKeys.map((key) => {
          const spec = schema.items[key]
          if (!spec) return null
          if (!isItemVisible(spec, values)) return null
          if (!showAdvanced && spec.ui.advanced) return null
          return <CompactField key={key} itemKey={key} spec={spec} values={values} setValue={setValue} />
        })}
      </div>

      <div className="section-divider" style={{ marginTop: 10 }}>Driver Model (LE)</div>
      {leKeys.map((key) => {
        const spec = schema.items[key]
        if (!spec) return null
        if (!isItemVisible(spec, values)) return null
        if (!showAdvanced && spec.ui.advanced) return null
        return <CompactField key={key} itemKey={key} spec={spec} values={values} setValue={setValue} />
      })}

      {showAdvanced && (
        <>
          <div className="section-divider" style={{ marginTop: 10 }}>Observations</div>
          {observationKeys.map((key) => {
            const spec = schema.items[key]
            if (!spec) return null
            if (!isItemVisible(spec, values)) return null
            return <CompactField key={key} itemKey={key} spec={spec} values={values} setValue={setValue} />
          })}
        </>
      )}
    </div>
  )
}

// ─── Outputs Tab ─────────────────────────────────────────────────────────────

function OutputsTab({
  schema,
  values,
  setValue,
  showAdvanced,
}: {
  schema: typeof defaultSchema | null
  values: Record<string, unknown>
  setValue: (key: string, value: unknown) => void
  showAdvanced: boolean
}) {
  if (!schema) return null

  const fileKeys = ['Output.STL', 'Output.MSH', 'Output.ABECProject']
  const advancedKeys = ['GridExport:SlicesProfiles', 'Report']

  return (
    <div>
      <div className="section-divider">Generated Files</div>
      {fileKeys.map((key) => {
        const spec = schema.items[key]
        if (!spec) return null
        if (!isItemVisible(spec, values)) return null
        if (!showAdvanced && spec.ui.advanced) return null
        return <CompactField key={key} itemKey={key} spec={spec} values={values} setValue={setValue} />
      })}

      {showAdvanced && (
        <>
          <div className="section-divider" style={{ marginTop: 10 }}>Advanced</div>
          {advancedKeys.map((key) => {
            const spec = schema.items[key]
            if (!spec) return null
            return <CompactField key={key} itemKey={key} spec={spec} values={values} setValue={setValue} />
          })}
        </>
      )}
    </div>
  )
}

// ─── Advanced Field List (for top-left advanced mode) ────────────────────────

function AdvancedFieldList({
  keys,
  schema,
  values,
  setValue,
}: {
  keys: string[]
  schema: typeof defaultSchema | null
  values: Record<string, unknown>
  setValue: (key: string, value: unknown) => void
}) {
  if (!schema) return null
  return (
    <>
      {keys.map((key) => {
        const spec = schema.items[key]
        if (!spec) return null
        if (!isItemVisible(spec, values)) return null
        return <CompactField key={key} itemKey={key} spec={spec} values={values} setValue={setValue} />
      })}
    </>
  )
}

// ─── Compact Field Renderer ──────────────────────────────────────────────────

function CompactField({
  itemKey,
  spec,
  values,
  setValue,
}: {
  itemKey: string
  spec: ItemSpec
  values: Record<string, unknown>
  setValue: (key: string, value: unknown) => void
}) {
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
      <div className="checkbox-row">
        <input
          type="checkbox"
          id={`f-${itemKey}`}
          checked={Boolean(value)}
          onChange={(e) => setValue(itemKey, e.target.checked)}
        />
        <label htmlFor={`f-${itemKey}`}>
          {spec.label}
          <InfoTip text={spec.ui.help ?? spec.description} />
        </label>
        {error && <span className="errorText">{error}</span>}
      </div>
    )
  }

  // Select
  if (spec.ui.widget === 'select' && spec.ui.options) {
    const stringValue = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
    return (
      <div className="field-row">
        <span className="field-label">
          {spec.label}
          {spec.units && <span className="units">({spec.units})</span>}
          <InfoTip text={spec.ui.help ?? spec.description} />
        </span>
        <div>
          <select
            className="select"
            value={stringValue}
            onChange={(e) => handleSelectChange(e.target.value)}
          >
            <option value="" disabled={required}>-</option>
            {spec.ui.options.map((opt) => (
              <option key={String(opt.value)} value={String(opt.value)}>
                {opt.label}
              </option>
            ))}
          </select>
          {error && <div className="errorText">{error}</div>}
        </div>
      </div>
    )
  }

  // Folder
  if (spec.ui.widget === 'folder') {
    const stringValue = typeof value === 'string' ? value : ''
    return (
      <div className="field-row">
        <span className="field-label">
          {spec.label}
          <InfoTip text={spec.ui.help ?? spec.description} />
        </span>
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
    return (
      <div className="field-row">
        <span className="field-label">
          {spec.label}
          {spec.units && <span className="units">({spec.units})</span>}
          <InfoTip text={spec.ui.help ?? spec.description} />
        </span>
        <div>
          <input
            className="input"
            type="text"
            placeholder={spec.ui.placeholder}
            value={toString(value)}
            onChange={(e) => setValue(itemKey, parse(e.target.value))}
          />
          {error && <div className="errorText">{error}</div>}
        </div>
      </div>
    )
  }

  // Horn Parts
  if (spec.ui.widget === 'hornParts') {
    return (
      <div className="field-row-wide horn-parts-compact">
        <span className="field-label">
          {spec.label}
          <InfoTip text={spec.ui.help ?? spec.description} />
        </span>
        <Suspense fallback={<div className="muted" style={{ fontSize: 12 }}>Loading...</div>}>
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
      <div className="field-row-wide">
        <span className="field-label">
          {spec.label}
          {spec.units && <span className="units">({spec.units})</span>}
          <InfoTip text={spec.ui.help ?? spec.description} />
        </span>
        <div>
          <textarea
            className="textarea"
            placeholder={spec.ui.placeholder}
            value={stringValue}
            onChange={(e) => onChange(e.target.value)}
          />
          {error && <div className="errorText">{error}</div>}
        </div>
      </div>
    )
  }

  // Default: number/text input
  const inputType = spec.valueType === 'i' || spec.valueType === 'f' ? 'number' : 'text'
  const stringValue = typeof parsed === 'number' || typeof parsed === 'string' ? String(parsed) : ''
  const inputMode = spec.valueType === 'i' ? 'numeric' as const : spec.valueType === 'f' ? 'decimal' as const : undefined
  const step = spec.valueType === 'i' ? 1 : spec.valueType === 'f' ? 'any' : undefined

  return (
    <div className="field-row">
      <span className="field-label">
        {spec.label}
        {spec.units && <span className="units">({spec.units})</span>}
        <InfoTip text={spec.ui.help ?? spec.description} />
      </span>
      <div>
        <input
          className="input"
          type={inputType}
          inputMode={inputMode}
          step={step}
          placeholder={spec.ui.placeholder}
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
        />
        {error && <div className="errorText">{error}</div>}
      </div>
    </div>
  )
}

// ─── InfoTip ─────────────────────────────────────────────────────────────────

function InfoTip({ text }: { text?: string }) {
  if (!text) return null
  return (
    <button className="info-btn" type="button" title={text}>
      ?
    </button>
  )
}

// ─── Folder Input ────────────────────────────────────────────────────────────

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
        className="input"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <button className="btn" type="button" onClick={pickDirectory}>
        ...
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

// ─── Logs View ───────────────────────────────────────────────────────────────

function LogsView({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines])
  const text = useMemo(() => (lines.length ? lines.join('\n') : 'No logs yet.'), [lines])
  return (
    <div ref={ref} className="log-box" style={{ height: '100%', overflow: 'auto' }}>
      {text}
    </div>
  )
}

// ─── Profile Panel ───────────────────────────────────────────────────────────

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
  if (!projectId) return <div className="placeholder">No project.</div>

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 8 }}>
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
          <div className="placeholder">No profiles or STL mesh found. Run the project to generate outputs.</div>
        )}
      </Suspense>
    </div>
  )
}

// ─── Files View ──────────────────────────────────────────────────────────────

function FilesView({
  files,
  projectId,
  onRefresh,
}: {
  files: { path: string; size: number }[]
  projectId: string | null
  onRefresh: () => void
}) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.6px', fontWeight: 600 }}>
          Generated Files
        </span>
        <button className="btn" type="button" onClick={onRefresh} disabled={!projectId}>
          Refresh
        </button>
      </div>
      {files.length === 0 ? (
        <div className="muted" style={{ fontSize: 12, padding: '8px 0' }}>
          Run the project to generate outputs.
        </div>
      ) : (
        files.map((f) => (
          <div key={f.path} className="file-item">
            <span className="file-name">{f.path}</span>
            <span className="file-size">{formatFileSize(f.size)}</span>
            {projectId && (
              <a
                className="file-dl"
                href={`/api/projects/${projectId}/files/download?path=${encodeURIComponent(f.path)}`}
              >
                DL
              </a>
            )}
          </div>
        ))
      )}
    </div>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
