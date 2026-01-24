import { create } from 'zustand'
import type { AthUiSchema } from '../schema/types'

type StudioState = {
  schema: AthUiSchema | null
  setSchema: (schema: AthUiSchema) => void

  showAdvanced: boolean
  setShowAdvanced: (show: boolean) => void

  projectId: string | null
  setProjectId: (id: string | null) => void

  values: Record<string, unknown>
  setValue: (key: string, value: unknown) => void
  setValues: (updates: Record<string, unknown>) => void
  dirty: boolean
  setDirty: (dirty: boolean) => void

  logs: string[]
  appendLogs: (lines: string[], opts?: { replace?: boolean }) => void

  files: { path: string; size: number }[]
  setFiles: (files: { path: string; size: number }[]) => void
  outputsRevision: number

  geometryFilePath: string | null
  setGeometryFilePath: (path: string | null) => void

  meshFilePath: string | null
  setMeshFilePath: (path: string | null) => void

  profilesFilePath: string | null
  setProfilesFilePath: (path: string | null) => void
}

export const useStudioStore = create<StudioState>((set) => ({
  schema: null,
  setSchema: (schema) =>
    set((s) => {
      const values = { ...s.values }
      for (const [key, spec] of Object.entries(schema.items)) {
        if (values[key] === undefined && spec.default !== undefined) values[key] = spec.default
      }
      return { schema, values }
    }),

  showAdvanced: false,
  setShowAdvanced: (showAdvanced) => set({ showAdvanced }),

  projectId: null,
  setProjectId: (projectId) => set({ projectId }),

  values: {},
  setValue: (key, value) =>
    set((s) => ({
      dirty: true,
      values: {
        ...s.values,
        [key]: value,
      },
    })),
  setValues: (updates) =>
    set((s) => ({
      dirty: true,
      values: {
        ...s.values,
        ...updates,
      },
    })),
  dirty: false,
  setDirty: (dirty) => set({ dirty }),

  logs: [],
  appendLogs: (lines, opts) =>
    set((s) => ({
      logs: opts?.replace ? [...lines] : [...s.logs, ...lines].slice(-10_000),
    })),

  files: [],
  setFiles: (files) => set((s) => ({ files, outputsRevision: s.outputsRevision + 1 })),
  outputsRevision: 0,

  geometryFilePath: null,
  setGeometryFilePath: (geometryFilePath) => set({ geometryFilePath }),

  meshFilePath: null,
  setMeshFilePath: (meshFilePath) => set({ meshFilePath }),

  profilesFilePath: null,
  setProfilesFilePath: (profilesFilePath) => set({ profilesFilePath }),
}))
