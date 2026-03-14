import { useEffect, useMemo, useState } from 'react'

type ProfilePoint = { x: number; r: number }

function fillGapsLinear(values: Float32Array, hasValue: Uint8Array): Float32Array {
  const out = new Float32Array(values.length)
  out.set(values)

  let prev = -1
  for (let i = 0; i < out.length; i++) {
    if (!hasValue[i]) continue
    if (prev < 0) {
      for (let j = 0; j < i; j++) out[j] = out[i]
    } else if (i - prev > 1) {
      const a = out[prev]
      const b = out[i]
      const span = i - prev
      for (let j = prev + 1; j < i; j++) {
        const t = (j - prev) / span
        out[j] = a + (b - a) * t
      }
    }
    prev = i
  }

  if (prev >= 0 && prev < out.length - 1) {
    for (let j = prev + 1; j < out.length; j++) out[j] = out[prev]
  }

  return out
}

function smooth3(values: Float32Array): Float32Array {
  if (values.length < 3) return values
  const out = new Float32Array(values.length)
  out[0] = values[0]
  out[out.length - 1] = values[values.length - 1]
  for (let i = 1; i < values.length - 1; i++) out[i] = (values[i - 1] + values[i] + values[i + 1]) / 3
  return out
}

export function StlProfile({ modelUrl }: { modelUrl: string }) {
  const [points, setPoints] = useState<ProfilePoint[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setError(null)
      setPoints(null)
      try {
        const res = await fetch(modelUrl, { cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = await res.arrayBuffer()

        const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js')
        const loader = new STLLoader()
        const geo = loader.parse(buf)
        const pos = geo.getAttribute('position')
        if (!pos) throw new Error('Missing STL positions')

        let minX = Infinity
        let minY = Infinity
        let minZ = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        let maxZ = -Infinity

        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i)
          const y = pos.getY(i)
          const z = pos.getZ(i)
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (z < minZ) minZ = z
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
          if (z > maxZ) maxZ = z
        }

        // Detect the horn axis by checking which axis has the smallest span
        // (for axisymmetric geometry, the radial axes span more than the axial one)
        // OR by checking which axis the geometry is centered around (X and Y should be centered at 0)
        const spanX = maxX - minX
        const spanY = maxY - minY
        const spanZ = maxZ - minZ
        const centerX = (minX + maxX) / 2
        const centerY = (minY + maxY) / 2
        const centerZ = (minZ + maxZ) / 2

        // For a horn waveguide, the axis of revolution should have its center near 0
        // and the cross-section should be roughly circular
        // Ath outputs horns with Z as the axis, X/Y as the radial plane
        // But we'll auto-detect: the axis is the one where center is furthest from 0
        // OR has the most distinct span ratio

        type AxisConfig = { axis: 'x' | 'y' | 'z'; min: number; max: number; c1: number; c2: number; min1: number; max1: number; min2: number; max2: number }

        const axisConfigs: AxisConfig[] = [
          { axis: 'z', min: minZ, max: maxZ, c1: centerX, c2: centerY, min1: minX, max1: maxX, min2: minY, max2: maxY },
          { axis: 'y', min: minY, max: maxY, c1: centerX, c2: centerZ, min1: minX, max1: maxX, min2: minZ, max2: maxZ },
          { axis: 'x', min: minX, max: maxX, c1: centerY, c2: centerZ, min1: minY, max1: maxY, min2: minZ, max2: maxZ },
        ]

        // Score each axis: prefer axis where radial center is near 0 and radial spans are similar
        function scoreAxis(cfg: AxisConfig): number {
          const radialCenterOffset = Math.abs(cfg.c1) + Math.abs(cfg.c2)
          const radialSpan1 = cfg.max1 - cfg.min1
          const radialSpan2 = cfg.max2 - cfg.min2
          const radialSymmetry = Math.min(radialSpan1, radialSpan2) / Math.max(radialSpan1, radialSpan2, 1e-6)
          // Lower center offset is better, higher symmetry is better
          return radialSymmetry * 100 - radialCenterOffset
        }

        const bestAxis = axisConfigs.reduce((best, cfg) => scoreAxis(cfg) > scoreAxis(best) ? cfg : best)

        const bins = 240
        const radii = new Float32Array(bins).fill(0)
        const hasValue = new Uint8Array(bins)
        const axisMin = bestAxis.min
        const axisMax = bestAxis.max
        const axisSpan = Math.max(1e-6, axisMax - axisMin)
        const radialCenter1 = (bestAxis.min1 + bestAxis.max1) / 2
        const radialCenter2 = (bestAxis.min2 + bestAxis.max2) / 2

        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i)
          const y = pos.getY(i)
          const z = pos.getZ(i)

          let t: number, r1: number, r2: number
          if (bestAxis.axis === 'z') {
            t = z; r1 = x - radialCenter1; r2 = y - radialCenter2
          } else if (bestAxis.axis === 'y') {
            t = y; r1 = x - radialCenter1; r2 = z - radialCenter2
          } else {
            t = x; r1 = y - radialCenter1; r2 = z - radialCenter2
          }
          const r = Math.hypot(r1, r2)

          const normalized = (t - axisMin) / axisSpan
          const idx = Math.min(bins - 1, Math.max(0, Math.floor(normalized * (bins - 1))))
          if (r > radii[idx]) radii[idx] = r
          hasValue[idx] = 1
        }

        const filled = smooth3(fillGapsLinear(radii, hasValue))

        const out: ProfilePoint[] = []
        for (let i = 0; i < bins; i++) {
          const x = (i / (bins - 1)) * axisSpan
          out.push({ x, r: filled[i] })
        }

        geo.dispose()
        if (cancelled) return
        setPoints(out)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (cancelled) return
        setError(message)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [modelUrl])

  const svg = useMemo(() => {
    if (!points || points.length < 2) return null
    const maxR = Math.max(...points.map((p) => p.r), 1)
    const maxX = points[points.length - 1]?.x ?? 1

    const padX = maxX * 0.05
    const padY = maxR * 0.2
    const vbX0 = -padX
    const vbX1 = maxX + padX
    const vbY0 = -(maxR + padY)
    const vbY1 = maxR + padY

    const top = points.map((p) => `${p.x},${-p.r}`).join(' ')
    const bottom = points.map((p) => `${p.x},${p.r}`).join(' ')

    return (
      <svg className="profileSvg" viewBox={`${vbX0} ${vbY0} ${vbX1 - vbX0} ${vbY1 - vbY0}`} role="img" aria-label="Axial profile from mesh">
        <line x1={0} y1={0} x2={maxX} y2={0} className="profileAxis" vectorEffect="non-scaling-stroke" />
        <line x1={0} y1={vbY0} x2={0} y2={vbY1} className="profileAxis" vectorEffect="non-scaling-stroke" />
        <polyline points={top} className="profileLine" vectorEffect="non-scaling-stroke" fill="none" />
        <polyline points={bottom} className="profileLine" vectorEffect="non-scaling-stroke" fill="none" />
      </svg>
    )
  }, [points])

  if (error) return <div className="logBox">Failed to load profile: {error}</div>
  if (!points) return <div className="logBox muted">Loading STL profile.</div>

  return (
    <div className="card">
      <div className="cardHeader">
        <h2>2D Profile (From Mesh)</h2>
        <span className="muted">Computed from the last-run STL.</span>
      </div>
      <div className="cardBody">{svg}</div>
    </div>
  )
}
