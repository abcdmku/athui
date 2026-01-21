import { useEffect, useMemo, useState } from 'react'

type Point3 = { x: number; y: number; z: number }
type ProfilePoint = { x: number; r: number }

function parseAthCsvCurves(text: string): Point3[][] {
  const curves: Point3[][] = []
  let current: Point3[] = []

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      if (current.length) curves.push(current)
      current = []
      continue
    }
    if (line.startsWith('#')) continue

    const parts = line.split(';')
    if (parts.length < 3) continue
    const x = Number.parseFloat(parts[0] ?? '')
    const y = Number.parseFloat(parts[1] ?? '')
    const z = Number.parseFloat(parts[2] ?? '')
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    current.push({ x, y, z })
  }

  if (current.length) curves.push(current)
  return curves
}

function toAxisymmetricProfile(points3: Point3[]): ProfilePoint[] {
  if (points3.length === 0) return []
  const sorted = [...points3].sort((a, b) => a.z - b.z)
  const minZ = sorted[0]?.z ?? 0
  const out: ProfilePoint[] = []
  for (const p of sorted) out.push({ x: p.z - minZ, r: Math.hypot(p.x, p.y) })
  return out
}

export function ProfilesCsvProfile({ csvUrl }: { csvUrl: string }) {
  const [curves, setCurves] = useState<Point3[][] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [curveIndex, setCurveIndex] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setError(null)
      setCurves(null)
      try {
        const res = await fetch(csvUrl, { cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const text = await res.text()
        const parsed = parseAthCsvCurves(text)
        if (parsed.length === 0) throw new Error('No curves found in profiles CSV')
        if (cancelled) return
        setCurves(parsed)
        setCurveIndex(0)
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
  }, [csvUrl])

  const { points2d, maxX, maxR } = useMemo(() => {
    const selected = curves?.[curveIndex] ?? null
    const points2d = selected ? toAxisymmetricProfile(selected) : null
    const maxX = points2d?.length ? points2d[points2d.length - 1]?.x ?? 1 : 1
    const maxR = points2d?.length ? Math.max(...points2d.map((p) => p.r), 1) : 1
    return { points2d, maxX, maxR }
  }, [curves, curveIndex])

  const svg = useMemo(() => {
    if (!points2d || points2d.length < 2) return null

    const padX = maxX * 0.05
    const padY = maxR * 0.2
    const vbX0 = -padX
    const vbX1 = maxX + padX
    const vbY0 = -(maxR + padY)
    const vbY1 = maxR + padY

    const top = points2d.map((p) => `${p.x},${-p.r}`).join(' ')
    const bottom = points2d.map((p) => `${p.x},${p.r}`).join(' ')

    return (
      <svg className="profileSvg" viewBox={`${vbX0} ${vbY0} ${vbX1 - vbX0} ${vbY1 - vbY0}`} role="img" aria-label="Profile from Ath GridExport">
        <line x1={0} y1={0} x2={maxX} y2={0} className="profileAxis" vectorEffect="non-scaling-stroke" />
        <line x1={0} y1={vbY0} x2={0} y2={vbY1} className="profileAxis" vectorEffect="non-scaling-stroke" />
        <polyline points={top} className="profileLine" vectorEffect="non-scaling-stroke" fill="none" />
        <polyline points={bottom} className="profileLine" vectorEffect="non-scaling-stroke" fill="none" />
      </svg>
    )
  }, [maxR, maxX, points2d])

  if (error) return <div className="logBox">Failed to load profiles CSV: {error}</div>
  if (!curves) return <div className="logBox muted">Loading exported profiles.</div>

  const count = curves.length
  const safeIndex = Math.min(Math.max(0, curveIndex), Math.max(0, count - 1))

  return (
    <div className="card">
      <div className="cardHeader" style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h2>2D Profile (From Ath Export)</h2>
          <span className="muted">{count} profile curve{count === 1 ? '' : 's'}.</span>
        </div>
        {count > 1 ? (
          <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            Profile
            <select value={safeIndex} onChange={(e) => setCurveIndex(Number.parseInt(e.currentTarget.value, 10) || 0)}>
              {curves.map((_, i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <div className="cardBody">{svg}</div>
    </div>
  )
}

