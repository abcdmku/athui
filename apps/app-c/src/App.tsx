import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react'
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
import type { ItemSpec, UiWidget } from './schema/types'
import { useStudioStore } from './state/store'

const GeometryPreview = React.lazy(() =>
  import('./components/GeometryPreview').then((m) => ({ default: m.GeometryPreview })),
)
const StlProfile = React.lazy(() =>
  import('./components/StlProfile').then((m) => ({ default: m.StlProfile })),
)
const ProfilesCsvProfile = React.lazy(() =>
  import('./components/ProfilesCsvProfile').then((m) => ({ default: m.ProfilesCsvProfile })),
)
const HornPartsEditor = React.lazy(() =>
  import('./components/HornPartsEditor').then((m) => ({ default: m.HornPartsEditor })),
)

// ── Horn Designer Logic ──

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

// ── Tabs ──

type WorkflowTab = 'design' | 'mesh' | 'simulate' | 'output'

const TAB_DEFS: { id: WorkflowTab; num: number; label: string }[] = [
  { id: 'design', num: 1, label: 'Design' },
  { id: 'mesh', num: 2, label: 'Mesh' },
  { id: 'simulate', num: 3, label: 'Simulate' },
  { id: 'output', num: 4, label: 'Output' },
]

// ── File Pickers ──

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

// ── Validation ──

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

// ── App ──

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

  const [tab, setTab] = useState<WorkflowTab>('design')
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(false)

  // ── Collapsed sections ──
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const toggleSection = (id: string) => setCollapsed((s) => ({ ...s, [id]: !s[id] }))

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

  useEffect(() => {
    if (!projectId) return
    setConnected(true)
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
    ws.addEventListener('close', () => setConnected(false))
    ws.addEventListener('error', () => setConnected(false))
    return () => ws.close()
  }, [appendLogs, projectId, setDirty, setFiles, setGeometryFilePath, setMeshFilePath, setProfilesFilePath])

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
      setTab('simulate')
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

  // ── Designer state ──
  const designerState = useMemo(() => deriveDesignerState(values), [values])
  const derived = useMemo(() => computeDerived(designerState), [designerState])

  function applyDesignerPatch(partial: Partial<DesignerState>) {
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
  }

  // ── Render Field Helper ──

  function renderItemField(itemKey: string) {
    const spec = schema?.items[itemKey]
    if (!spec) return null
    if (!isItemVisible(spec, values)) return null
    if (!showAdvanced && spec.ui.advanced) return false
    return <ItemField key={itemKey} itemKey={itemKey} />
  }

  function renderFieldKeys(keys: string[]) {
    return keys.map((key) => {
      const el = renderItemField(key)
      if (el === false || el === null) return null
      return el
    })
  }

  // ── Section Helpers ──

  function Section({
    id,
    title,
    children,
  }: {
    id: string
    title: string
    children: React.ReactNode
  }) {
    const isCollapsed = collapsed[id] ?? false
    return (
      <div className="sectionBlock">
        <div className="sectionHeader" onClick={() => toggleSection(id)}>
          <h3>{title}</h3>
          <span className={clsx('sectionToggle', !isCollapsed && 'open')}>&#9654;</span>
        </div>
        {!isCollapsed && children}
      </div>
    )
  }

  // ── Mesh Quality ──
  const meshQuality = values['_athui.MeshQuality'] as MeshQualityPreset | undefined

  // ── Throat preset for designer ──
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

  // ── stlPath for preview ──
  const stlPath = meshFilePath ?? geometryFilePath

  return (
    <div className="appShell">
      {/* ── Header ── */}
      <header className="header">
        <div className="headerTitle">Horn Designer</div>
        <div className="headerCenter">
          {TAB_DEFS.map((t) => (
            <button
              key={t.id}
              className={clsx(
                'mainTab',
                !showAdvanced && (t.id === 'mesh' || t.id === 'simulate') && 'dimmed',
              )}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              type="button"
            >
              <span className="tabStepNum">{t.num}.</span> {t.label}
            </button>
          ))}
        </div>
        <div className="headerRight">
          <div className="pillToggle">
            <button
              type="button"
              aria-pressed={!showAdvanced}
              onClick={() => setShowAdvanced(false)}
            >
              Simple
            </button>
            <button
              type="button"
              aria-pressed={showAdvanced}
              onClick={() => setShowAdvanced(true)}
            >
              Advanced
            </button>
          </div>
        </div>
      </header>

      {/* ── Tab Content ── */}
      <div style={{ display: 'contents' }}>
        {/* Tab 1: Design */}
        <div className="tabContent" style={{ display: tab === 'design' ? 'grid' : 'none' }}>
          <div className="splitLeft">
            {/* Horn Type */}
            <Section id="design-type" title="Horn Type">
              <div className="toggleGroup">
                <button
                  type="button"
                  className={clsx('toggleBtn', designerState.mode === 'round' && 'active')}
                  onClick={() => applyDesignerPatch({ mode: 'round', coverageV: designerState.coverageH })}
                >
                  Round
                </button>
                <button
                  type="button"
                  className={clsx('toggleBtn', designerState.mode === 'rect' && 'active')}
                  onClick={() => applyDesignerPatch({ mode: 'rect', coverageV: 60 })}
                >
                  Rect
                </button>
              </div>
            </Section>

            {/* Throat */}
            <Section id="design-throat" title="Throat">
              <div className="chipRow">
                <button
                  type="button"
                  className={clsx('chip', throatPreset === 25.4 && 'active')}
                  onClick={() => applyDesignerPatch({ throatDiameterMm: 25.4 })}
                >
                  1&quot; (25.4)
                </button>
                <button
                  type="button"
                  className={clsx('chip', throatPreset === 34 && 'active')}
                  onClick={() => applyDesignerPatch({ throatDiameterMm: 34 })}
                >
                  1.4&quot; (34)
                </button>
                <button
                  type="button"
                  className={clsx('chip', throatPreset === 50.8 && 'active')}
                  onClick={() => applyDesignerPatch({ throatDiameterMm: 50.8 })}
                >
                  2&quot; (50.8)
                </button>
              </div>
              <div className="fieldRow">
                <span className="fieldLabel">
                  Diameter<span className="fieldLabelUnits">mm</span>
                </span>
                <div className="fieldInput">
                  <input
                    className="input"
                    type="number"
                    step="0.1"
                    value={formatNumber(designerState.throatDiameterMm, 1)}
                    onChange={(e) => applyDesignerPatch({ throatDiameterMm: Number(e.target.value) || 0 })}
                  />
                </div>
              </div>
              <div className="fieldRow">
                <span className="fieldLabel">
                  Angle<span className="fieldLabelUnits">deg</span>
                </span>
                <div className="fieldInput">
                  <input
                    className="input"
                    type="number"
                    step="0.1"
                    value={formatNumber(designerState.throatAngleDeg, 2)}
                    onChange={(e) => applyDesignerPatch({ throatAngleDeg: Number(e.target.value) || 0 })}
                  />
                </div>
              </div>
            </Section>

            {/* Coverage */}
            <Section id="design-coverage" title="Coverage">
              <div className="chipRow">
                {coveragePresets.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={clsx(
                      'chip',
                      designerState.coverageH === p.h && designerState.coverageV === p.v && 'active',
                    )}
                    onClick={() => applyDesignerPatch({ coverageH: p.h, coverageV: p.v })}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="fieldRow">
                <span className="fieldLabel">
                  {designerState.mode === 'rect' ? 'H' : 'Angle'}
                  <span className="fieldLabelUnits">deg</span>
                </span>
                <div className="fieldInput">
                  <input
                    className="input"
                    type="number"
                    step="1"
                    value={formatNumber(designerState.coverageH, 0)}
                    onChange={(e) => applyDesignerPatch({ coverageH: Number(e.target.value) || 0 })}
                  />
                </div>
              </div>
              {designerState.mode === 'rect' && (
                <div className="fieldRow">
                  <span className="fieldLabel">
                    V<span className="fieldLabelUnits">deg</span>
                  </span>
                  <div className="fieldInput">
                    <input
                      className="input"
                      type="number"
                      step="1"
                      value={formatNumber(designerState.coverageV, 0)}
                      onChange={(e) => applyDesignerPatch({ coverageV: Number(e.target.value) || 0 })}
                    />
                  </div>
                </div>
              )}
            </Section>

            {/* Dimensions */}
            <Section id="design-dims" title="Dimensions">
              <div className="toggleGroup" style={{ marginBottom: 6 }}>
                <button
                  type="button"
                  className={clsx('toggleBtn', designerState.sizeMode === 'depth' && 'active')}
                  onClick={() => applyDesignerPatch({ sizeMode: 'depth' })}
                >
                  Set Depth
                </button>
                <button
                  type="button"
                  className={clsx('toggleBtn', designerState.sizeMode === 'mouth' && 'active')}
                  onClick={() => applyDesignerPatch({ sizeMode: 'mouth' })}
                >
                  Set Mouth
                </button>
              </div>
              {designerState.sizeMode === 'depth' ? (
                <>
                  <div className="fieldRow">
                    <span className="fieldLabel">
                      Depth<span className="fieldLabelUnits">mm</span>
                    </span>
                    <div className="fieldInput">
                      <input
                        className="input"
                        type="number"
                        step="1"
                        value={formatNumber(designerState.depthMm, 0)}
                        onChange={(e) => applyDesignerPatch({ depthMm: Number(e.target.value) || 0 })}
                      />
                    </div>
                  </div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                    Est. mouth: {formatNumber(derived.mouthWidthMm, 0)}
                    {designerState.mode === 'rect' ? ` x ${formatNumber(derived.mouthHeightMm, 0)}` : ''} mm
                  </div>
                </>
              ) : (
                <>
                  <div className="fieldRow">
                    <span className="fieldLabel">
                      {designerState.mode === 'rect' ? 'Width' : 'Mouth'}
                      <span className="fieldLabelUnits">mm</span>
                    </span>
                    <div className="fieldInput">
                      <input
                        className="input"
                        type="number"
                        step="1"
                        value={formatNumber(designerState.mouthWidthMm, 0)}
                        onChange={(e) => applyDesignerPatch({ mouthWidthMm: Number(e.target.value) || 0 })}
                      />
                    </div>
                  </div>
                  {designerState.mode === 'rect' && (
                    <div className="fieldRow">
                      <span className="fieldLabel">
                        Height<span className="fieldLabelUnits">mm</span>
                      </span>
                      <div className="fieldInput">
                        <input
                          className="input"
                          type="number"
                          step="1"
                          value={formatNumber(designerState.mouthHeightMm, 0)}
                          onChange={(e) => applyDesignerPatch({ mouthHeightMm: Number(e.target.value) || 0 })}
                        />
                      </div>
                    </div>
                  )}
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                    Est. depth: {formatNumber(derived.depthMm, 0)} mm
                  </div>
                </>
              )}
            </Section>

            {/* Mouth */}
            <Section id="design-mouth" title="Mouth">
              {designerState.mode === 'rect' && (
                <div className="fieldRow">
                  <span className="fieldLabel">
                    Corner Radius<span className="fieldLabelUnits">mm</span>
                  </span>
                  <div className="fieldInput">
                    <input
                      className="input"
                      type="number"
                      step="1"
                      value={formatNumber(designerState.cornerRadiusMm, 0)}
                      onChange={(e) => applyDesignerPatch({ cornerRadiusMm: Number(e.target.value) || 0 })}
                    />
                  </div>
                </div>
              )}
              <div className="fieldRow">
                <span className="fieldLabel">Termination</span>
                <div className="fieldInput">
                  <select
                    className="select"
                    value={designerState.mouthTermination}
                    onChange={(e) =>
                      applyDesignerPatch({
                        mouthTermination: e.target.value === 'r-osse' ? 'r-osse' : 'none',
                      })
                    }
                  >
                    <option value="none">None</option>
                    <option value="r-osse">R-OSSE</option>
                  </select>
                </div>
              </div>
              {designerState.mouthTermination === 'r-osse' && (
                <div className="fieldRow">
                  <span className="fieldLabel">
                    Rollback Angle<span className="fieldLabelUnits">deg</span>
                  </span>
                  <div className="fieldInput">
                    <input
                      className="input"
                      type="number"
                      step="1"
                      value={formatNumber(designerState.rollbackAngleDeg, 0)}
                      onChange={(e) => applyDesignerPatch({ rollbackAngleDeg: Number(e.target.value) || 0 })}
                    />
                  </div>
                </div>
              )}
            </Section>

            {/* Advanced Design Sections */}
            {showAdvanced && (
              <>
                <Section id="design-profile" title="Profile Shape">
                  {renderFieldKeys([
                    'Throat.Profile',
                    'OS.k',
                    'Term.s',
                    'Term.q',
                    'Term.n',
                    'CircArc.Radius',
                    'CircArc.TermAngle',
                  ])}
                </Section>

                <Section id="design-extensions" title="Extensions">
                  {renderFieldKeys(['Throat.Ext.Length', 'Throat.Ext.Angle', 'Slot.Length', 'Rot'])}
                </Section>

                <Section id="design-guiding" title="Guiding Curve">
                  {renderFieldKeys([
                    'GCurve.Type',
                    'GCurve.Dist',
                    'GCurve.Width',
                    'GCurve.AspectRatio',
                    'GCurve.SE.n',
                    'GCurve.SF',
                    'GCurve.Rot',
                  ])}
                </Section>

                <Section id="design-rect-throat" title="Rectangular Throat">
                  {renderFieldKeys([
                    'HornGeometry',
                    'Horn.Adapter.Width',
                    'Horn.Adapter.Height',
                    'Horn.Adapter.Length',
                    'Horn.Adapter.k',
                    'Horn.Adapter.Segments',
                    '_athui.HornParts',
                  ])}
                </Section>

                <Section id="design-morph" title="Morphing">
                  {renderFieldKeys([
                    'Morph.TargetShape',
                    'Morph.TargetWidth',
                    'Morph.TargetHeight',
                    'Morph.CornerRadius',
                    'Morph.FixedPart',
                    'Morph.Rate',
                    'Morph.AllowShrinkage',
                  ])}
                </Section>
              </>
            )}
          </div>

          {/* Design Right: 3D Preview */}
          <div className="splitRight" style={{ padding: 0 }}>
            <Suspense fallback={<div className="logBox muted">Loading preview.</div>}>
              {stlPath && stlPath.toLowerCase().endsWith('.stl') && projectId ? (
                <GeometryPreview
                  key={`${stlPath}:${outputsRevision}`}
                  modelUrl={`${api.rawFileUrl(projectId, stlPath)}&v=${outputsRevision}`}
                />
              ) : (
                <GeometryPreview
                  lengthMm={derived.depthMm}
                  throatDiameterMm={designerState.throatDiameterMm}
                  mouthDiameterMm={derived.mouthWidthMm}
                />
              )}
            </Suspense>
          </div>
        </div>

        {/* Tab 2: Mesh */}
        <div className="tabContent" style={{ display: tab === 'mesh' ? 'grid' : 'none' }}>
          <div className="splitLeft">
            <Section id="mesh-quality" title="Quality Preset">
              <div className="fieldRow">
                <span className="fieldLabel">Quality</span>
                <div className="fieldInput">
                  <select
                    className="select"
                    value={String(meshQuality ?? 'high')}
                    onChange={(e) => {
                      const raw = e.target.value as MeshQualityPreset
                      setValue('_athui.MeshQuality', raw)
                      if (raw !== 'custom') {
                        const next = getMeshQualityPresetValues(raw)
                        for (const key of meshQualityKeys) {
                          const v = next[key]
                          if (v !== undefined) setValue(key, v)
                        }
                      }
                    }}
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="ultra">Ultra</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>
              </div>
            </Section>

            <Section id="mesh-res" title="Resolution">
              <div className="twoColGrid">
                {renderFieldKeys([
                  'Mesh.AngularSegments',
                  'Mesh.LengthSegments',
                  'Mesh.ThroatResolution',
                  'Mesh.MouthResolution',
                  'Mesh.ThroatSegments',
                  'Mesh.CornerSegments',
                ])}
              </div>
            </Section>

            <Section id="mesh-bem" title="BEM Quadrants">
              {renderFieldKeys(['Mesh.Quadrants'])}
            </Section>

            {showAdvanced && (
              <>
                <Section id="mesh-subdomains" title="Subdomains">
                  {renderFieldKeys(['Mesh.SubdomainSlices', 'Mesh.InterfaceOffset', 'Mesh.InterfaceDraw'])}
                </Section>

                <Section id="mesh-free" title="Free Standing">
                  {renderFieldKeys(['Mesh.RearShape', 'Mesh.WallThickness', 'Mesh.RearResolution'])}
                </Section>

                <Section id="mesh-enclosure" title="Enclosure">
                  {renderFieldKeys(['Mesh.Enclosure'])}
                </Section>
              </>
            )}
          </div>

          {/* Mesh Right: Profile View */}
          <div className="splitRight">
            <Suspense fallback={<div className="logBox muted">Loading profile.</div>}>
              {profilesFilePath && profilesFilePath.toLowerCase().endsWith('.csv') && projectId ? (
                <ProfilesCsvProfile
                  key={`${profilesFilePath}:${outputsRevision}`}
                  csvUrl={`${api.rawFileUrl(projectId, profilesFilePath)}&v=${outputsRevision}`}
                />
              ) : stlPath && stlPath.toLowerCase().endsWith('.stl') && projectId ? (
                <StlProfile
                  key={`${stlPath}:${outputsRevision}`}
                  modelUrl={`${api.rawFileUrl(projectId, stlPath)}&v=${outputsRevision}`}
                />
              ) : (
                <div className="logBox muted">No profile data. Run the project to generate outputs.</div>
              )}
            </Suspense>
          </div>
        </div>

        {/* Tab 3: Simulate */}
        <div className="tabContent" style={{ display: tab === 'simulate' ? 'grid' : 'none' }}>
          <div className="splitLeft">
            <Section id="sim-boundary" title="Boundary Conditions">
              {renderFieldKeys(['ABEC.SimType'])}
            </Section>

            <Section id="sim-freq" title="Frequency Range">
              {renderFieldKeys(['ABEC.f1', 'ABEC.f2', 'ABEC.NumFrequencies', 'ABEC.Abscissa'])}
              {showAdvanced && renderFieldKeys(['ABEC.MeshFrequency', 'ABEC.SimProfile'])}
            </Section>

            <Section id="sim-source" title="Source Configuration">
              {renderFieldKeys(['Source.Shape', 'Source.Velocity'])}
              {showAdvanced &&
                renderFieldKeys(['Source.Radius', 'Source.Curv', 'Source.Contours'])}
            </Section>

            {showAdvanced && (
              <>
                <Section id="sim-le" title="Driver Model (LE)">
                  {renderFieldKeys(['LE', 'LE.System', 'LE.Driver', 'LE.Voltage'])}
                </Section>

                <Section id="sim-obs" title="Observations">
                  {renderFieldKeys(['ABEC.Polars:SPL'])}
                </Section>
              </>
            )}
          </div>

          {/* Simulate Right: Logs */}
          <div className="splitRight" style={{ padding: 0 }}>
            <LogsView lines={logs} />
          </div>
        </div>

        {/* Tab 4: Output */}
        <div className="tabContent" style={{ display: tab === 'output' ? 'grid' : 'none' }}>
          <div className="splitLeft">
            <Section id="out-files" title="Output Files">
              {renderFieldKeys(['Output.STL', 'Output.MSH', 'Output.ABECProject'])}
            </Section>

            {showAdvanced && (
              <>
                <Section id="out-grid" title="Grid Export">
                  {renderFieldKeys(['GridExport:SlicesProfiles'])}
                </Section>

                <Section id="out-report" title="Report">
                  {renderFieldKeys(['Report'])}
                </Section>
              </>
            )}

            <Section id="out-paths" title="Project Paths">
              {renderFieldKeys(['Output.SubDir', 'Output.DestDir'])}
              {showAdvanced && renderFieldKeys(['_athui.MeshCmd', '_athui.GnuplotPath'])}
            </Section>
          </div>

          {/* Output Right: Files */}
          <div className="splitRight">
            <FilesView files={files} projectId={projectId} onRefresh={handleRefreshFiles} />
          </div>
        </div>
      </div>

      {/* ── Status Bar ── */}
      <div className="statusBar">
        <div className="statusLeft">
          <button
            className="runBtn"
            onClick={handleRun}
            disabled={!projectId || busy}
            type="button"
          >
            {busy ? 'Running...' : 'Run'}
          </button>
          <span className={clsx('dirtyBadge', !dirty && 'clean')} title={dirty ? 'Modified' : 'Up to date'} />
          <span className="muted" style={{ fontSize: 11 }}>
            {dirty ? 'Modified' : 'Up to date'}
          </span>
        </div>
        <div className="statusCenter">
          {projectId ? `Project ${projectId}` : 'No project'}
        </div>
        <div className="statusRight">
          <button className="btn" onClick={handleRefreshFiles} disabled={!projectId} type="button">
            Refresh Files
          </button>
          <span className={clsx('connDot', !connected && 'disconnected')} title={connected ? 'Connected' : 'Disconnected'} />
        </div>
      </div>
    </div>
  )
}

// ── ItemField Component ──

function ItemField({ itemKey }: { itemKey: string }) {
  const spec = useStudioStore((s) => s.schema?.items[itemKey])
  const values = useStudioStore((s) => s.values)
  const value = useStudioStore((s) => s.values[itemKey])
  const setValue = useStudioStore((s) => s.setValue)

  if (!spec) return null

  const id = `field-${itemKey}`
  const valueType = spec.valueType
  const errorId = `${id}-error`
  const required = isItemRequired(spec, values)
  const [error, parsed] = validateAndParse(spec, value, required)

  function onChange(raw: string) {
    const next = parseFromInput(valueType, raw)
    setValue(itemKey, next)
  }

  if (spec.ui.widget === 'checkbox') {
    const checked = Boolean(value)
    return (
      <div className="checkboxRow">
        <input
          id={id}
          name={itemKey}
          type="checkbox"
          checked={checked}
          onChange={(e) => setValue(itemKey, e.target.checked)}
        />
        <label htmlFor={id} style={{ fontSize: 13 }}>
          {spec.label}
        </label>
        <InfoTip label={spec.label} text={spec.ui.help ?? spec.description} />
      </div>
    )
  }

  if (spec.ui.widget === 'select' && spec.ui.options) {
    const stringValue = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
    return (
      <div className="fieldRow">
        <span className="fieldLabel">
          {spec.label}
          <InfoTip label={spec.label} text={spec.ui.help ?? spec.description} />
        </span>
        <div className="fieldInput">
          <select
            className="select"
            id={id}
            name={itemKey}
            value={stringValue}
            onChange={(e) => {
              const raw = e.target.value
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
            }}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? errorId : undefined}
          >
            <option value="" disabled={required}>
              -
            </option>
            {spec.ui.options.map((opt) => (
              <option key={String(opt.value)} value={String(opt.value)}>
                {opt.label}
              </option>
            ))}
          </select>
          {error && (
            <div className="errorText" id={errorId}>
              {error}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (spec.ui.widget === 'folder') {
    const stringValue = typeof value === 'string' ? value : ''
    return (
      <div className="fieldRow">
        <span className="fieldLabel">
          {spec.label}
          <InfoTip label={spec.label} text={spec.ui.help ?? spec.description} />
        </span>
        <div className="fieldInput">
          <FolderInput
            id={id}
            name={itemKey}
            value={stringValue}
            placeholder={spec.ui.placeholder}
            onChange={(next) => setValue(itemKey, next)}
          />
        </div>
      </div>
    )
  }

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
      const parts = trimmed
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
      const numbers = parts.map((p) => Number(p)).filter((n) => Number.isFinite(n))
      if (spec.valueType === 'i[]') return numbers.map((n) => Math.trunc(n))
      return numbers
    }
    const raw = toString(value)
    return (
      <div className="fieldRow">
        <span className="fieldLabel">
          {spec.label}
          {spec.units && <span className="fieldLabelUnits">({spec.units})</span>}
          <InfoTip label={spec.label} text={spec.ui.help ?? spec.description} />
        </span>
        <div className="fieldInput">
          <input
            className="input"
            id={id}
            name={itemKey}
            autoComplete="off"
            type="text"
            placeholder={spec.ui.placeholder}
            value={raw}
            onChange={(e) => setValue(itemKey, parse(e.target.value))}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? errorId : undefined}
          />
          {error && (
            <div className="errorText" id={errorId}>
              {error}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (spec.ui.widget === 'hornParts') {
    return (
      <div style={{ marginTop: 4 }}>
        <Suspense fallback={<div className="muted">Loading...</div>}>
          <HornPartsEditor
            value={value as import('./components/HornPartsEditor').HornPartsValue | undefined}
            onChange={(v) => setValue(itemKey, v)}
          />
        </Suspense>
      </div>
    )
  }

  if (spec.ui.widget === 'textarea') {
    const stringValue = typeof parsed === 'number' || typeof parsed === 'string' ? String(parsed) : ''
    return (
      <div style={{ marginBottom: 6 }}>
        <div className="fieldRow" style={{ height: 'auto', alignItems: 'flex-start' }}>
          <span className="fieldLabel" style={{ paddingTop: 6 }}>
            {spec.label}
            {spec.units && <span className="fieldLabelUnits">({spec.units})</span>}
            <InfoTip label={spec.label} text={spec.ui.help ?? spec.description} />
          </span>
        </div>
        <textarea
          className="textarea"
          id={id}
          name={itemKey}
          placeholder={spec.ui.placeholder}
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error ? errorId : undefined}
        />
        {error && (
          <div className="errorText" id={errorId}>
            {error}
          </div>
        )}
      </div>
    )
  }

  // Default: text / number input
  const inputType = spec.valueType === 'i' || spec.valueType === 'f' ? 'number' : 'text'
  const stringValue = typeof parsed === 'number' || typeof parsed === 'string' ? String(parsed) : ''
  const inputMode = valueType === 'i' ? 'numeric' : valueType === 'f' ? 'decimal' : undefined
  const step = valueType === 'i' ? 1 : valueType === 'f' ? 'any' : undefined

  return (
    <div className="fieldRow">
      <span className="fieldLabel">
        {spec.label}
        {spec.units && <span className="fieldLabelUnits">({spec.units})</span>}
        <InfoTip label={spec.label} text={spec.ui.help ?? spec.description} />
      </span>
      <div className="fieldInput">
        <input
          className="input"
          id={id}
          name={itemKey}
          autoComplete="off"
          inputMode={inputMode}
          step={step}
          type={inputType}
          placeholder={spec.ui.placeholder}
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error ? errorId : undefined}
        />
        {error && (
          <div className="errorText" id={errorId}>
            {error}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Helpers ──

function InfoTip({ label, text }: { label: string; text?: string }) {
  if (!text) return null
  return (
    <button className="infoBtn" type="button" aria-label={`Help: ${label}`} title={text}>
      i
    </button>
  )
}

function FolderInput({
  id,
  name,
  value,
  placeholder,
  onChange,
}: {
  id: string
  name: string
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
    <div className="folderRow">
      <input
        className="input"
        id={id}
        name={name}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <button className="btn" type="button" onClick={pickDirectory}>
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

function LogsView({ lines }: { lines: string[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const text = useMemo(() => (lines.length ? lines.join('\n') : 'No logs yet.'), [lines])

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [text])

  return (
    <div ref={containerRef} className="logBox">
      {text}
    </div>
  )
}

function FilesView({
  files,
  projectId,
  onRefresh,
}: {
  files: { path: string; size: number }[]
  projectId: string | null
  onRefresh: () => void
}) {
  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase' }}>
          Generated Files
        </h3>
        <button className="btn" onClick={onRefresh} disabled={!projectId} type="button">
          Refresh
        </button>
      </div>
      {files.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Run the project to generate outputs.
        </div>
      ) : (
        <div>
          {files.map((f) => (
            <div key={f.path} className="fileItem">
              <div>
                <div className="fileName">{f.path}</div>
                <div className="fileSize">{formatSize(f.size)}</div>
              </div>
              {projectId && (
                <a
                  className="btn"
                  href={`/api/projects/${projectId}/files/download?path=${encodeURIComponent(f.path)}`}
                  style={{ textDecoration: 'none', whiteSpace: 'nowrap' }}
                >
                  Download
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
