type LogsMessage =
  | { type: 'logs:init'; lines: string[] }
  | { type: 'logs:append'; lines: string[] }

type FilesUpdateMessage = { type: 'files:update'; files: { path: string; size: number }[] }
type RunDoneMessage = { type: 'run:done'; ok?: boolean; code?: number | null; signal?: string | null }

export type StudioSocketMessage = LogsMessage | FilesUpdateMessage | RunDoneMessage

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function isFileList(value: unknown): value is { path: string; size: number }[] {
  return (
    Array.isArray(value) &&
    value.every(
      (v) =>
        v &&
        typeof v === 'object' &&
        typeof (v as { path?: unknown }).path === 'string' &&
        typeof (v as { size?: unknown }).size === 'number',
    )
  )
}

function isStudioSocketMessage(value: unknown): value is StudioSocketMessage {
  if (!value || typeof value !== 'object') return false
  const v = value as { type?: unknown; lines?: unknown; files?: unknown }
  if (v.type === 'logs:init' || v.type === 'logs:append') return isStringArray(v.lines)
  if (v.type === 'files:update') return isFileList(v.files)
  if (v.type === 'run:done') return true
  return false
}

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

export const api = {
  createProject: () => requestJson<{ id: string }>('/api/projects', { method: 'POST' }),
  updateConfig: (id: string, config: Record<string, unknown>) =>
    fetch(`/api/projects/${id}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
    }),
  run: (id: string) => requestJson<{ status: string }>(`/api/projects/${id}/run`, { method: 'POST' }),
  listFiles: (id: string) => requestJson<{ files: { path: string; size: number }[] }>(`/api/projects/${id}/files`),
  getFileText: (id: string, filePath: string) =>
    requestJson<{ text: string }>(`/api/projects/${id}/files/text?path=${encodeURIComponent(filePath)}`),
  rawFileUrl: (id: string, filePath: string) => `/api/projects/${id}/files/raw?path=${encodeURIComponent(filePath)}`,
  openLogsSocket: (projectId: string, onMessage: (msg: StudioSocketMessage) => void) => {
    const url = new URL('/ws', window.location.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('projectId', projectId)

    const ws = new WebSocket(url)
    ws.addEventListener('message', (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as unknown
        if (isStudioSocketMessage(parsed)) onMessage(parsed)
      } catch {
        // ignore
      }
    })
    return ws
  },
}
