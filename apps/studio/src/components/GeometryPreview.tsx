import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

export function GeometryPreview({
  modelUrl,
  lengthMm,
  throatDiameterMm,
  mouthDiameterMm,
}: {
  modelUrl?: string
  lengthMm?: number
  throatDiameterMm?: number
  mouthDiameterMm?: number
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    console.log('[GeometryPreview] Loading model:', modelUrl)
    setLoadError(null)
    const hostEl = hostRef.current
    if (!hostEl) return
    const host: HTMLDivElement = hostEl

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000)

    const light = new THREE.DirectionalLight(0xffffff, 1.1)
    light.position.set(3, 4, 2)
    scene.add(light)
    scene.add(new THREE.AmbientLight(0xffffff, 0.25))

    const grid = new THREE.GridHelper(6, 24, 0x334155, 0x1f2937)
    grid.position.y = -0.6
    scene.add(grid)

    const material = new THREE.MeshStandardMaterial({ color: 0x22d3ee, metalness: 0.2, roughness: 0.35 })
    const group = new THREE.Group()
    scene.add(group)
    const geometries: THREE.BufferGeometry[] = []

    function frameObject(obj: THREE.Object3D) {
      const box = new THREE.Box3().setFromObject(obj)
      const center = box.getCenter(new THREE.Vector3())
      obj.position.sub(center)
      box.setFromObject(obj)

      const sphere = box.getBoundingSphere(new THREE.Sphere())
      const radius = Number.isFinite(sphere.radius) && sphere.radius > 0 ? sphere.radius : 1

      camera.near = Math.max(0.01, radius / 100)
      camera.far = radius * 100
      camera.position.set(radius * 2.2, radius * 1.4, radius * 2.2)
      camera.lookAt(0, 0, 0)
      camera.updateProjectionMatrix()
    }

    let mesh: THREE.Object3D | null = null

    async function load() {
      try {
        if (modelUrl && modelUrl.toLowerCase().includes('.stl')) {
          console.log('[GeometryPreview] Fetching STL:', modelUrl)
          const res = await fetch(modelUrl, { cache: 'no-store' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          console.log('[GeometryPreview] STL fetched, size:', res.headers.get('content-length'))
          const buf = await res.arrayBuffer()
          const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js')
          const loader = new STLLoader()
          const geo = loader.parse(buf)
          geometries.push(geo)
          const m = new THREE.Mesh(geo, material)
          mesh = m
          group.add(m)
          frameObject(m)
          return
        }

        if (
          Number.isFinite(lengthMm) &&
          Number.isFinite(throatDiameterMm) &&
          Number.isFinite(mouthDiameterMm) &&
          (lengthMm ?? 0) > 0 &&
          (throatDiameterMm ?? 0) > 0 &&
          (mouthDiameterMm ?? 0) > 0
        ) {
          const throatR = (throatDiameterMm as number) / 2
          const mouthR = (mouthDiameterMm as number) / 2
          const len = lengthMm as number
          const points = [new THREE.Vector2(throatR, 0), new THREE.Vector2(mouthR, len)]
          const geo = new THREE.LatheGeometry(points, 96)
          geometries.push(geo)
          const m = new THREE.Mesh(geo, material)
          mesh = m
          group.add(m)
          frameObject(m)
          return
        }

        // No valid model to display
        setLoadError('No mesh available. Run the project to generate geometry.')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setLoadError(`Failed to load mesh: ${message}`)
      }
    }

    void load()

    let dragging = false
    let lastX = 0
    let lastY = 0

    function onPointerDown(e: PointerEvent) {
      dragging = true
      lastX = e.clientX
      lastY = e.clientY
      host.setPointerCapture(e.pointerId)
    }
    function onPointerMove(e: PointerEvent) {
      if (!dragging) return
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY

      group.rotation.y += dx * 0.01
      group.rotation.x += dy * 0.01
    }
    function onPointerUp(e: PointerEvent) {
      dragging = false
      try {
        host.releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }
    }

    host.addEventListener('pointerdown', onPointerDown)
    host.addEventListener('pointermove', onPointerMove)
    host.addEventListener('pointerup', onPointerUp)
    host.addEventListener('pointercancel', onPointerUp)

    function resize() {
      const rect = host.getBoundingClientRect()
      renderer.setSize(rect.width, rect.height, false)
      camera.aspect = rect.width / Math.max(1, rect.height)
      camera.updateProjectionMatrix()
    }

    const ro = new ResizeObserver(() => resize())
    ro.observe(host)
    resize()

    let raf = 0
    function tick() {
      camera.lookAt(0, 0, 0)
      renderer.render(scene, camera)
      raf = requestAnimationFrame(tick)
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      host.removeEventListener('pointerdown', onPointerDown)
      host.removeEventListener('pointermove', onPointerMove)
      host.removeEventListener('pointerup', onPointerUp)
      host.removeEventListener('pointercancel', onPointerUp)
      for (const g of geometries) g.dispose()
      material.dispose()
      renderer.dispose()
      host.removeChild(renderer.domElement)
    }
  }, [lengthMm, modelUrl, mouthDiameterMm, throatDiameterMm])

  return (
    <div style={{ height: '100%', minHeight: 320, position: 'relative' }}>
      <div ref={hostRef} style={{ height: '100%', width: '100%' }} />
      {loadError && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'rgba(0,0,0,0.7)',
            color: '#9ca3af',
            padding: '16px 24px',
            borderRadius: 8,
            textAlign: 'center',
            maxWidth: '80%',
          }}
        >
          {loadError}
        </div>
      )}
    </div>
  )
}
