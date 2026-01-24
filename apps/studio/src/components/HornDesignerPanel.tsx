import { useMemo } from 'react'
import { useStudioStore } from '../state/store'

type Mode = 'round' | 'rect'
type SizeMode = 'depth' | 'mouth'

type DesignerState = {
  mode: Mode
  coverageH: number // full angle, deg
  coverageV: number // full angle, deg
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
  const fallbackCoverage = covFromCfgHalf !== null ? clamp(covFromCfgHalf * 2, 20, 160) : mode === 'rect' ? 90 : 90

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
  // Horizontal is p=0° (cos^2=1). Vertical is p=90° (cos^2=0).
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

export function HornDesignerPanel() {
  const values = useStudioStore((s) => s.values)
  const setValues = useStudioStore((s) => s.setValues)

  const state = useMemo(() => deriveDesignerState(values), [values])

  const derived = useMemo(() => computeDerived(state), [state])

  function applyPatch(partial: Partial<DesignerState>) {
    const next0: DesignerState = { ...state, ...partial }

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

      // Core horn geometry
      HornGeometry: 1,
      'Throat.Profile': 1,
      'Throat.Diameter': throatDiameterMm,
      'Throat.Angle': formatNumber(throatAngleDeg),
      'GCurve.Type': undefined,
      'Coverage.Angle': coverageAngleExpr,
      Length: formatNumber(depthMm),

      // Mouth shaping (rectangle mode)
      'Morph.TargetShape': mode === 'rect' ? 1 : 0,
      'Morph.TargetWidth': mode === 'rect' ? mouthWidthMm : 0,
      'Morph.TargetHeight': mode === 'rect' ? mouthHeightMm : 0,
      'Morph.CornerRadius': cornerRadiusMm,

      // Termination (UI-only)
      '_athui.MouthTermination': normalized.mouthTermination,
      '_athui.RollbackAngleDeg': normalized.rollbackAngleDeg,
    }

    setValues(updates)
  }

  const throatPreset = findNearestThroatPreset(state.throatDiameterMm)

  const coveragePresets =
    state.mode === 'rect'
      ? [
          { id: '90x60', label: '90×60', h: 90, v: 60 },
          { id: '90x40', label: '90×40', h: 90, v: 40 },
          { id: '80x50', label: '80×50', h: 80, v: 50 },
          { id: '60x40', label: '60×40', h: 60, v: 40 },
        ]
      : [
          { id: '60', label: '60°', h: 60, v: 60 },
          { id: '90', label: '90°', h: 90, v: 90 },
          { id: '120', label: '120°', h: 120, v: 120 },
        ]

  return (
    <div className="card">
      <div className="cardHeader">
        <h2>Horn Designer</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          Set the basics. Studio fills in the rest.
        </span>
      </div>
      <div className="cardBody">
        <div className="field">
          <label className="fieldLabel" htmlFor="designer-mode">
            <strong>Type</strong>
            <span>Choose round or rectangular coverage.</span>
          </label>
          <select
            id="designer-mode"
            className="select"
            value={state.mode}
            onChange={(e) => {
              const mode = (e.target.value === 'rect' ? 'rect' : 'round') as Mode
              applyPatch({ mode, coverageV: mode === 'rect' ? 60 : state.coverageH })
            }}
          >
            <option value="round">Round (axisymmetric)</option>
            <option value="rect">Rectangular (H×V)</option>
          </select>
        </div>

        <div className="field">
          <label className="fieldLabel" htmlFor="designer-throat">
            <strong>Throat</strong>
            <span>Compression driver exit size.</span>
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 8 }}>
            <select
              className="select"
              value={String(throatPreset)}
              onChange={(e) => {
                const v = e.target.value
                if (v === 'custom') return
                const preset = Number(v)
                if (!Number.isFinite(preset) || preset <= 0) return
                applyPatch({ throatDiameterMm: preset })
              }}
              aria-label="Throat preset"
            >
              <option value="25.4">1&quot; (25.4mm)</option>
              <option value="34">1.4&quot; (34mm)</option>
              <option value="50.8">2&quot; (50.8mm)</option>
              <option value="custom">Custom</option>
            </select>
            <input
              id="designer-throat"
              className="input"
              type="number"
              inputMode="decimal"
              step="0.1"
              value={formatNumber(state.throatDiameterMm, 1)}
              onChange={(e) => applyPatch({ throatDiameterMm: Number(e.target.value) || 0 })}
              aria-label="Throat diameter (mm)"
            />
          </div>
        </div>

        <div className="field">
          <label className="fieldLabel" htmlFor="designer-throat-angle">
            <strong>Throat Angle</strong>
            <span>Driver exit half-angle (deg). Typical: 7.</span>
          </label>
          <input
            id="designer-throat-angle"
            className="input"
            type="number"
            inputMode="decimal"
            step="0.1"
            value={formatNumber(state.throatAngleDeg, 2)}
            onChange={(e) => applyPatch({ throatAngleDeg: Number(e.target.value) || 0 })}
          />
        </div>

        <div className="field">
          <label className="fieldLabel" htmlFor="designer-coverage-h">
            <strong>Coverage</strong>
            <span>Full angles (deg). Use presets or enter custom values.</span>
          </label>
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {coveragePresets.map((p) => (
                <button
                  key={p.id}
                  className="btn"
                  type="button"
                  style={{ padding: '6px 8px', fontSize: 12 }}
                  onClick={() => applyPatch({ coverageH: p.h, coverageV: p.v })}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: state.mode === 'rect' ? '1fr 1fr' : '1fr', gap: 8 }}>
              <input
                id="designer-coverage-h"
                className="input"
                type="number"
                inputMode="decimal"
                step="1"
                value={formatNumber(state.coverageH, 0)}
                onChange={(e) => applyPatch({ coverageH: Number(e.target.value) || 0 })}
                aria-label={state.mode === 'rect' ? 'Horizontal coverage (deg)' : 'Coverage (deg)'}
              />
              {state.mode === 'rect' ? (
                <input
                  className="input"
                  type="number"
                  inputMode="decimal"
                  step="1"
                  value={formatNumber(state.coverageV, 0)}
                  onChange={(e) => applyPatch({ coverageV: Number(e.target.value) || 0 })}
                  aria-label="Vertical coverage (deg)"
                />
              ) : null}
            </div>
          </div>
        </div>

        <div className="field">
          <label className="fieldLabel" htmlFor="designer-size-mode">
            <strong>Size</strong>
            <span>Pick a depth or a mouth size; the other is estimated.</span>
          </label>
          <div style={{ display: 'grid', gap: 8 }}>
            <select
              id="designer-size-mode"
              className="select"
              value={state.sizeMode}
              onChange={(e) => applyPatch({ sizeMode: (e.target.value === 'mouth' ? 'mouth' : 'depth') as SizeMode })}
            >
              <option value="depth">Set depth (compute mouth)</option>
              <option value="mouth">Set mouth (compute depth)</option>
            </select>

            {state.sizeMode === 'depth' ? (
              <>
                <input
                  className="input"
                  type="number"
                  inputMode="decimal"
                  step="1"
                  value={formatNumber(state.depthMm, 0)}
                  onChange={(e) => applyPatch({ depthMm: Number(e.target.value) || 0 })}
                  aria-label="Depth (mm)"
                />
                <div className="muted" style={{ fontSize: 12 }}>
                  Estimated mouth: {formatNumber(derived.mouthWidthMm, 0)}
                  {state.mode === 'rect' ? ` × ${formatNumber(derived.mouthHeightMm, 0)}` : ''} mm
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: state.mode === 'rect' ? '1fr 1fr' : '1fr', gap: 8 }}>
                  <input
                    className="input"
                    type="number"
                    inputMode="decimal"
                    step="1"
                    value={formatNumber(state.mouthWidthMm, 0)}
                    onChange={(e) => applyPatch({ mouthWidthMm: Number(e.target.value) || 0 })}
                    aria-label={state.mode === 'rect' ? 'Mouth width (mm)' : 'Mouth diameter (mm)'}
                  />
                  {state.mode === 'rect' ? (
                    <input
                      className="input"
                      type="number"
                      inputMode="decimal"
                      step="1"
                      value={formatNumber(state.mouthHeightMm, 0)}
                      onChange={(e) => applyPatch({ mouthHeightMm: Number(e.target.value) || 0 })}
                      aria-label="Mouth height (mm)"
                    />
                  ) : null}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Estimated depth: {formatNumber(derived.depthMm, 0)} mm
                </div>
              </>
            )}
          </div>
        </div>

        {state.mode === 'rect' ? (
          <div className="field">
            <label className="fieldLabel" htmlFor="designer-corner-radius">
              <strong>Corner Radius</strong>
              <span>Rectangle corner rounding at the mouth (mm).</span>
            </label>
            <input
              id="designer-corner-radius"
              className="input"
              type="number"
              inputMode="decimal"
              step="1"
              value={formatNumber(state.cornerRadiusMm, 0)}
              onChange={(e) => applyPatch({ cornerRadiusMm: Number(e.target.value) || 0 })}
            />
          </div>
        ) : null}

        <div className="field">
          <label className="fieldLabel" htmlFor="designer-termination">
            <strong>Mouth Edge</strong>
            <span>Optional rolled-back lip (post-process).</span>
          </label>
          <div style={{ display: 'grid', gap: 8 }}>
            <select
              id="designer-termination"
              className="select"
              value={state.mouthTermination}
              onChange={(e) => applyPatch({ mouthTermination: e.target.value === 'r-osse' ? 'r-osse' : 'none' })}
            >
              <option value="none">None</option>
              <option value="r-osse">Rolled lip (R-OSSE)</option>
            </select>

            {state.mouthTermination === 'r-osse' ? (
              <input
                className="input"
                type="number"
                inputMode="decimal"
                step="1"
                value={formatNumber(state.rollbackAngleDeg, 0)}
                onChange={(e) => applyPatch({ rollbackAngleDeg: Number(e.target.value) || 0 })}
                aria-label="Rollback angle (deg)"
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
