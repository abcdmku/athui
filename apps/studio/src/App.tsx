import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { api } from './api/client'
import { defaultSchema } from './schema/defaultSchema'
import { buildProjectCfgText, isItemRequired, isItemVisible } from './schema/cfg'
import type { ItemSpec } from './schema/types'
import { useStudioStore } from './state/store'

const GeometryPreview = React.lazy(() => import('./components/GeometryPreview').then((m) => ({ default: m.GeometryPreview })))
const StlProfile = React.lazy(() => import('./components/StlProfile').then((m) => ({ default: m.StlProfile })))
const ProfilesCsvProfile = React.lazy(() =>
  import('./components/ProfilesCsvProfile').then((m) => ({ default: m.ProfilesCsvProfile })),
)

type RightTab = 'logs' | 'preview' | 'profile' | 'files'

export function App() {
  const projectId = useStudioStore((s) => s.projectId)
  const setProjectId = useStudioStore((s) => s.setProjectId)
  const schema = useStudioStore((s) => s.schema)
  const setSchema = useStudioStore((s) => s.setSchema)
  const values = useStudioStore((s) => s.values)
  const showAdvanced = useStudioStore((s) => s.showAdvanced)
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

  const [tab, setTab] = useState<RightTab>('logs')
  const [busy, setBusy] = useState(false)

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
        setDirty(false)
      }
    })
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

  const title = useMemo(() => (projectId ? `Project ${projectId}` : 'Loading project.'), [projectId])

  async function handleRun() {
    if (!projectId || !schema) return
    setBusy(true)
    try {
      const { text, errors } = buildProjectCfgText(schema, values, { includeAdvanced: showAdvanced })
      if (errors.length) {
        appendLogs(['[ui] Fix configuration errors before running:', ...errors.map((e) => `- ${e}`)])
        setBusy(false)
        setTab('logs')
        return
      }

      await api.updateConfig(projectId, { ...values, '_athui.cfgText': text })
      setDirty(false)
      await api.run(projectId)
      setTab('logs')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      appendLogs([`[ui] run failed: ${message}`])
    } finally {
      // keep busy until server reports completion (or run fails above)
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

  return (
    <div className="appShell">
      <a className="skipLink" href="#main">
        Skip to content
      </a>
      <header className="topBar">
        <div className="topBarTitle">
          Ath Studio <span className="muted">{title}</span>
        </div>
        <div className="topBarActions">
          <button className={clsx('btn', 'btnPrimary')} onClick={handleRun} disabled={!projectId || busy} type="button">
            {busy ? 'Running.' : 'Run'}
          </button>
          <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
            {dirty ? 'Not run yet.' : 'Up to date.'}
          </span>
          <button className="btn" onClick={handleRefreshFiles} disabled={!projectId} type="button">
            Refresh Files
          </button>
        </div>
      </header>

      <main className="main" id="main">
        <aside className="panel">
          <div className="panelInner">
            <ConfigPanel />
          </div>
        </aside>

        <section className="rightPanel">
          <div className="tabs" role="tablist" aria-label="Output tabs">
            <button
              id="tab-logs"
              className="tabBtn"
              role="tab"
              aria-selected={tab === 'logs'}
              aria-controls="panel-logs"
              type="button"
              onClick={() => setTab('logs')}
            >
              Logs
            </button>
            <button
              id="tab-preview"
              className="tabBtn"
              role="tab"
              aria-selected={tab === 'preview'}
              aria-controls="panel-preview"
              type="button"
              onClick={() => setTab('preview')}
            >
              Preview
            </button>
            <button
              id="tab-profile"
              className="tabBtn"
              role="tab"
              aria-selected={tab === 'profile'}
              aria-controls="panel-profile"
              type="button"
              onClick={() => setTab('profile')}
            >
              Profile
            </button>
            <button
              id="tab-files"
              className="tabBtn"
              role="tab"
              aria-selected={tab === 'files'}
              aria-controls="panel-files"
              type="button"
              onClick={() => setTab('files')}
            >
              Files
            </button>
          </div>

          {tab === 'logs' && (
            <div id="panel-logs" role="tabpanel" aria-labelledby="tab-logs" tabIndex={0}>
              <LogsView lines={logs} />
            </div>
          )}

          {tab === 'preview' && (
            <div id="panel-preview" role="tabpanel" aria-labelledby="tab-preview" tabIndex={0} className="panelInner">
              <PreviewPanel projectId={projectId} stlPath={meshFilePath ?? geometryFilePath} />
            </div>
          )}

          {tab === 'profile' && (
            <div id="panel-profile" role="tabpanel" aria-labelledby="tab-profile" tabIndex={0} className="panelInner">
              <ProfilePanel projectId={projectId} profilesPath={profilesFilePath} stlPath={meshFilePath ?? geometryFilePath} />
            </div>
          )}

          {tab === 'files' && (
            <div id="panel-files" role="tabpanel" aria-labelledby="tab-files" tabIndex={0}>
              <FilesView
                files={files}
                projectId={projectId}
                onRefresh={handleRefreshFiles}
                emptyHint="Run the project to generate outputs."
              />
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

function PreviewPanel({ projectId, stlPath }: { projectId: string | null; stlPath: string | null }) {
  const outputsRevision = useStudioStore((s) => s.outputsRevision)
  const dirty = useStudioStore((s) => s.dirty)
  if (!projectId) return <div className="logBox muted">No project.</div>

  if (!stlPath || !stlPath.toLowerCase().endsWith('.stl')) {
    return <div className="logBox muted">No STL mesh found yet. Run the project to generate outputs.</div>
  }

  return (
    <Suspense fallback={<div className="logBox muted">Loading preview.</div>}>
      {dirty ? <div className="logBox muted">Preview is from the last run. Click Run to update.</div> : null}
      <GeometryPreview
        key={`${stlPath}:${outputsRevision}`}
        modelUrl={`${api.rawFileUrl(projectId, stlPath)}&v=${outputsRevision}`}
      />
    </Suspense>
  )
}

function pickGeometryFile(files: { path: string; size: number }[]): string | null {
  const preferred = ['.stl', '.glb', '.gltf', '.obj', '.ply']
  for (const ext of preferred) {
    const f = files.find((x) => x.path.toLowerCase().endsWith(ext))
    if (f) return f.path
  }
  const geo = files.find((x) => x.path.toLowerCase().endsWith('.geo'))
  return geo?.path ?? null
}

function pickMeshFile(files: { path: string; size: number }[]): string | null {
  // Prefer mesh.stl (from Gmsh) or project.stl (from Ath) over other STLs like bem_mesh.stl
  const stlFiles = files.filter((x) => x.path.toLowerCase().endsWith('.stl'))
  const preferredNames = ['mesh.stl', 'project.stl']
  for (const name of preferredNames) {
    const preferred = stlFiles.find((x) => x.path.toLowerCase().endsWith(name))
    if (preferred) return preferred.path
  }
  // Fallback to any STL that is NOT bem_mesh.stl (which is a simulation boundary mesh)
  const nonBemStl = stlFiles.find((x) => !x.path.toLowerCase().includes('bem_mesh'))
  if (nonBemStl) return nonBemStl.path
  // Last resort: any STL
  if (stlFiles.length > 0) return stlFiles[0].path
  const geo = files.find((x) => x.path.toLowerCase().endsWith('.geo'))
  if (geo) return geo.path
  return null
}

function pickProfilesFile(files: { path: string; size: number }[]): string | null {
  const csvFiles = files.filter((x) => x.path.toLowerCase().endsWith('.csv'))
  const preferredNames = ['project_profiles_athui.csv', 'mesh_profiles_athui.csv', 'project_profiles.csv', 'mesh_profiles.csv']
  for (const name of preferredNames) {
    const preferred = csvFiles.find((x) => x.path.toLowerCase().endsWith(name))
    if (preferred) return preferred.path
  }
  const anyProfiles = csvFiles.find((x) => x.path.toLowerCase().endsWith('_profiles.csv'))
  if (anyProfiles) return anyProfiles.path
  const fuzzy = csvFiles.find((x) => x.path.toLowerCase().includes('profiles'))
  return fuzzy?.path ?? null
}

function ProfilePanel({
  projectId,
  profilesPath,
  stlPath,
}: {
  projectId: string | null
  profilesPath: string | null
  stlPath: string | null
}) {
  const outputsRevision = useStudioStore((s) => s.outputsRevision)
  const dirty = useStudioStore((s) => s.dirty)
  if (!projectId) return <div className="logBox muted">No project.</div>
  return (
    <Suspense fallback={<div className="logBox muted">Loading profile.</div>}>
      {dirty ? <div className="logBox muted">Profile is from the last run. Click Run to update.</div> : null}
      {profilesPath && profilesPath.toLowerCase().endsWith('.csv') ? (
        <ProfilesCsvProfile
          key={`${profilesPath}:${outputsRevision}`}
          csvUrl={`${api.rawFileUrl(projectId, profilesPath)}&v=${outputsRevision}`}
        />
      ) : stlPath && stlPath.toLowerCase().endsWith('.stl') ? (
        <StlProfile key={`${stlPath}:${outputsRevision}`} modelUrl={`${api.rawFileUrl(projectId, stlPath)}&v=${outputsRevision}`} />
      ) : (
        <div className="logBox muted">No exported profiles or STL mesh found yet. Run the project to generate outputs.</div>
      )}
    </Suspense>
  )
}

function ConfigPanel() {
  const schema = useStudioStore((s) => s.schema)
  const showAdvanced = useStudioStore((s) => s.showAdvanced)
  const setShowAdvanced = useStudioStore((s) => s.setShowAdvanced)
  if (!schema) return <div className="muted">Loading schema.</div>

  return (
    <div className="card">
      <div className="cardHeader">
        <h2>Configuration</h2>
        <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <input type="checkbox" checked={showAdvanced} onChange={(e) => setShowAdvanced(e.currentTarget.checked)} />
          Advanced
        </label>
      </div>
      <div className="cardBody">
        {schema.sections.map((section) => (
          <SectionCard key={section.id} sectionId={section.id} />
        ))}
      </div>
    </div>
  )
}

function SectionCard({ sectionId }: { sectionId: string }) {
  const schema = useStudioStore((s) => s.schema)
  const values = useStudioStore((s) => s.values)
  const showAdvanced = useStudioStore((s) => s.showAdvanced)
  const section = schema?.sections.find((sec) => sec.id === sectionId)
  if (!schema || !section) return null

  const visibleGroups = section.groups
    .map((group) => {
      const items = group.items.filter((key) => {
        const spec = schema.items[key]
        if (!spec) return false
        if (!showAdvanced && spec.ui.advanced) return false
        return isItemVisible(spec, values)
      })
      return { ...group, items }
    })
    .filter((g) => g.items.length > 0)

  if (visibleGroups.length === 0) return null

  return (
    <details className="card" style={{ marginBottom: 12 }} open>
      <summary className="cardHeader">
        <h2>{section.title}</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          {visibleGroups.length} group{visibleGroups.length === 1 ? '' : 's'}
        </span>
      </summary>
      <div className="cardBody">
        {visibleGroups.map((group) => (
          <details key={group.id} open style={{ marginBottom: 10 }}>
            <summary className="groupSummary">{group.title}</summary>
            <div>
              {group.items.map((key) => (
                <ItemField key={key} itemKey={key} />
              ))}
            </div>
          </details>
        ))}
      </div>
    </details>
  )
}

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
      <div className="field">
        <label className="fieldLabel" htmlFor={id}>
          <strong>{spec.label}</strong>
          {spec.description ? <span>{spec.description}</span> : null}
        </label>
        <input
          id={id}
          name={itemKey}
          type="checkbox"
          checked={checked}
          onChange={(e) => setValue(itemKey, e.target.checked)}
        />
      </div>
    )
  }

  if (spec.ui.widget === 'select' && spec.ui.options) {
    const stringValue = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
    return (
      <div className="field">
        <label className="fieldLabel" htmlFor={id}>
          <div className="labelRow">
            <strong>{spec.label}</strong>
            <InfoTip label={spec.label} text={spec.ui.help ?? spec.description} />
          </div>
          {spec.description ? <span>{spec.description}</span> : null}
        </label>
        <div>
          <select
            className="select"
            id={id}
            name={itemKey}
            value={stringValue}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? errorId : undefined}
          >
            <option value="">—</option>
            {spec.ui.options.map((opt) => (
              <option key={String(opt.value)} value={String(opt.value)}>
                {opt.label}
              </option>
            ))}
          </select>
          {error ? (
            <div className="errorText" id={errorId}>
              {error}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  if (spec.ui.widget === 'folder') {
    const stringValue = typeof value === 'string' ? value : ''
    return (
      <div className="field">
        <label className="fieldLabel" htmlFor={id}>
          <div className="labelRow">
            <strong>{spec.label}</strong>
            <InfoTip label={spec.label} text={spec.ui.help ?? spec.description} />
          </div>
          {spec.description ? <span>{spec.description}</span> : null}
        </label>
        <FolderInput
          id={id}
          name={itemKey}
          value={stringValue}
          placeholder={spec.ui.placeholder}
          onChange={(next) => setValue(itemKey, next)}
        />
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
      <div className="field">
        <label className="fieldLabel" htmlFor={id}>
          <div className="labelRow">
            <strong>
              {spec.label} {spec.units ? <span className="muted">({spec.units})</span> : null}
            </strong>
            <InfoTip label={spec.label} text={spec.ui.help ?? spec.description} />
          </div>
          {spec.description ? <span>{spec.description}</span> : null}
        </label>
        <div>
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
          {error ? (
            <div className="errorText" id={errorId}>
              {error}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  const inputType = spec.valueType === 'i' || spec.valueType === 'f' ? 'number' : 'text'
  const stringValue = typeof parsed === 'number' || typeof parsed === 'string' ? String(parsed) : ''
  const inputMode = valueType === 'i' ? 'numeric' : valueType === 'f' ? 'decimal' : undefined
  const step = valueType === 'i' ? 1 : valueType === 'f' ? 'any' : undefined

  const inputEl =
    spec.ui.widget === 'textarea' ? (
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
    ) : (
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
    )

  return (
    <div className="field">
      <label className="fieldLabel" htmlFor={id}>
        <div className="labelRow">
          <strong>
            {spec.label} {spec.units ? <span className="muted">({spec.units})</span> : null}
          </strong>
          <InfoTip label={spec.label} text={spec.ui.help ?? spec.description} />
        </div>
        {spec.description ? <span>{spec.description}</span> : null}
      </label>
      <div>
        {inputEl}
        {error ? (
          <div className="errorText" id={errorId}>
            {error}
          </div>
        ) : null}
      </div>
    </div>
  )
}

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

function FileTextViewer({ projectId, path }: { projectId: string; path: string }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setError(null)
      setText(null)
      try {
        const { text } = await api.getFileText(projectId, path)
        if (cancelled) return
        setText(text)
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
  }, [path, projectId])

  if (error) return <div className="logBox">Failed to load `{path}`: {error}</div>
  if (text === null) return <div className="logBox muted">Loading `{path}`.</div>
  return <div className="logBox">{text}</div>
}

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

function LogsView({ lines }: { lines: string[] }) {
  const text = useMemo(() => (lines.length ? lines.join('\n') : 'No logs yet.'), [lines])
  return <div className="logBox">{text}</div>
}

function FilesView({
  files,
  projectId,
  onRefresh,
  emptyHint,
}: {
  files: { path: string; size: number }[]
  projectId: string | null
  onRefresh: () => void
  emptyHint: string
}) {
  return (
    <div className="panelInner">
      <div className="card">
        <div className="cardHeader">
          <h2>Generated Files</h2>
          <button className="btn" onClick={onRefresh} disabled={!projectId} type="button">
            Refresh
          </button>
        </div>
        <div className="cardBody">
          {files.length === 0 ? (
            <div className="muted">{emptyHint}</div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {files.map((f) => (
                <div key={f.path} className="card" style={{ padding: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 13 }}>{f.path}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {f.size.toLocaleString()} bytes
                      </div>
                    </div>
                    {projectId ? (
                      <a className="btn" href={`/api/projects/${projectId}/files/download?path=${encodeURIComponent(f.path)}`}>
                        Download
                      </a>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
