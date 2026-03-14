export type MeshQualityPreset = 'low' | 'medium' | 'high' | 'ultra' | 'custom'

export const meshQualityPresetOptions: { value: MeshQualityPreset; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'ultra', label: 'Ultra' },
  { value: 'custom', label: 'Custom' },
]

export const meshQualityKeys = [
  'Mesh.AngularSegments',
  'Mesh.LengthSegments',
  'Mesh.ThroatResolution',
  'Mesh.MouthResolution',
] as const

const presets: Record<Exclude<MeshQualityPreset, 'custom'>, Record<(typeof meshQualityKeys)[number], number>> = {
  low: {
    // Former "medium"
    'Mesh.AngularSegments': 64,
    'Mesh.LengthSegments': 50,
    'Mesh.ThroatResolution': 4,
    'Mesh.MouthResolution': 8,
  },
  medium: {
    // Former "high"
    'Mesh.AngularSegments': 96,
    'Mesh.LengthSegments': 80,
    'Mesh.ThroatResolution': 2,
    'Mesh.MouthResolution': 5,
  },
  high: {
    // Former "ultra"
    'Mesh.AngularSegments': 128,
    'Mesh.LengthSegments': 120,
    'Mesh.ThroatResolution': 0.5,
    'Mesh.MouthResolution': 1.5,
  },
  ultra: {
    'Mesh.AngularSegments': 256,
    'Mesh.LengthSegments': 240,
    'Mesh.ThroatResolution': 0.3,
    'Mesh.MouthResolution': 0.9,
  },
}

export function getMeshQualityPresetValues(
  preset: MeshQualityPreset,
): Partial<Record<(typeof meshQualityKeys)[number], number>> {
  if (preset === 'custom') return {}
  return presets[preset]
}

export function applyMeshQualityPreset(values: Record<string, unknown>): Record<string, unknown> {
  const preset = values['_athui.MeshQuality'] as MeshQualityPreset | undefined
  if (!preset || preset === 'custom') return values
  const mapped = presets[preset]
  return { ...values, ...mapped }
}

export function isMeshQualityKey(key: string): boolean {
  return (meshQualityKeys as readonly string[]).includes(key)
}
