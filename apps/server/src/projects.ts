import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nanoid } from 'nanoid'
import type { WebSocket } from 'ws'
import { serializeAthDefinition } from './serialize.js'

type Project = {
  id: string
  dir: string
  config: Record<string, unknown>
  logs: string[]
  process: ReturnType<typeof spawn> | null
  wsClients: Set<WebSocket>
}

const projects = new Map<string, Project>()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..', '..')
const dataDir = path.join(repoRoot, '.athui-data')
const projectsDir = path.join(dataDir, 'projects')

function toLines(textChunk: string): string[] {
  return textChunk.replaceAll('\r\n', '\n').split('\n').filter(Boolean)
}

function appendLogs(project: Project, lines: string[]) {
  if (lines.length === 0) return

  project.logs.push(...lines)
  if (project.logs.length > 10_000) project.logs.splice(0, project.logs.length - 10_000)

  const message = JSON.stringify({ type: 'logs:append', lines })
  for (const client of project.wsClients) client.send(message)
}

function broadcast(project: Project, payload: unknown) {
  const message = JSON.stringify(payload)
  for (const client of project.wsClients) client.send(message)
}

function normalizeCfgText(text: string): string {
  const normalized = text.replaceAll('\r\n', '\n').trimEnd()
  return normalized.length ? normalized + '\n' : ''
}

export function getProject(id: string): Project | undefined {
  return projects.get(id)
}

export async function createProject(): Promise<Project> {
  await fs.mkdir(projectsDir, { recursive: true })

  const id = nanoid(10)
  const dir = path.join(projectsDir, id)
  await fs.mkdir(dir, { recursive: true })

  const project: Project = { id, dir, config: {}, logs: [], process: null, wsClients: new Set() }
  projects.set(id, project)
  return project
}

export async function updateProjectConfig(project: Project, config: Record<string, unknown>) {
  project.config = config
  await fs.writeFile(path.join(project.dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8')
}

function stringFromConfig(project: Project, key: string): string | null {
  const value = project.config[key]
  return typeof value === 'string' && value.trim().length ? value.trim() : null
}

function resolveMeshCmd(project: Project): string | null {
  const explicit = stringFromConfig(project, '_athui.MeshCmd') ?? (process.env.ATHUI_MESHCMD?.trim() || null)
  if (explicit) return explicit

  // Preferred: local install via `npm run setup:gmsh`
  const localGmsh = path.join(repoRoot, '.athui-data', 'tools', 'gmsh', 'gmsh.exe')
  const probe = spawnSync(localGmsh, ['-version'], { windowsHide: true })
  if (probe.status === 0) return `${localGmsh} %f -`

  // Best-effort auto-detect (Windows): if gmsh is on PATH, enable meshing.
  if (process.platform === 'win32') {
    const where = spawnSync('where.exe', ['gmsh.exe'], { encoding: 'utf8' })
    const first = where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0]
    if (first) return `${first} %f -`
  }

  return null
}

function extractExeFromMeshCmd(meshCmd: string): string | null {
  const s = meshCmd.trim()
  if (!s) return null
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1)
    if (end > 1) return s.slice(1, end)
    return null
  }
  const first = s.split(/\s+/)[0]
  return first || null
}

async function findGeoFiles(rootDir: string): Promise<string[]> {
  const results: string[] = []
  async function walk(current: string) {
    const children = await fs.readdir(current, { withFileTypes: true })
    for (const child of children) {
      const full = path.join(current, child.name)
      if (child.isDirectory()) {
        await walk(full)
      } else if (child.isFile() && child.name.toLowerCase().endsWith('.geo')) {
        results.push(full)
        if (results.length > 50) return
      }
    }
  }
  await walk(rootDir)
  return results
}

async function runGmshToStl({
  gmshExe,
  geoPath,
  outPath,
  cwd,
  project,
}: {
  gmshExe: string
  geoPath: string
  outPath: string
  cwd: string
  project: Project
}): Promise<void> {
  appendLogs(project, [`[gmsh] ${gmshExe} ${geoPath} -3 -format stl -o ${outPath}`])

  await new Promise<void>((resolve) => {
    const child = spawn(gmshExe, [geoPath, '-3', '-format', 'stl', '-o', outPath, '-v', '0'], { cwd, windowsHide: true })
    child.stdout.on('data', (b: Buffer) => appendLogs(project, toLines(b.toString('utf8'))))
    child.stderr.on('data', (b: Buffer) => appendLogs(project, toLines(b.toString('utf8'))))
    child.on('error', (err) => {
      appendLogs(project, [`[gmsh] process error: ${err.message}`])
      resolve()
    })
    child.on('close', (code) => {
      appendLogs(project, [`[gmsh] exit code=${code ?? 'null'}`])
      resolve()
    })
  })
}

async function postProcessOutputs(project: Project, outputsDir: string, meshCmd: string | null) {
  if (!meshCmd) return
  const gmshExe = extractExeFromMeshCmd(meshCmd)
  if (!gmshExe) return

  try {
    const geoFiles = await findGeoFiles(outputsDir)
    for (const geo of geoFiles) {
      const base = path.basename(geo, path.extname(geo))
      const outPath = path.join(path.dirname(geo), `${base}.stl`)

      // Check if STL needs regeneration: missing or older than .geo file
      let needsRegen = false
      try {
        const [geoStat, stlStat] = await Promise.all([fs.stat(geo), fs.stat(outPath)])
        needsRegen = geoStat.mtimeMs > stlStat.mtimeMs
      } catch {
        // STL doesn't exist, needs generation
        needsRegen = true
      }

      if (!needsRegen) continue
      await runGmshToStl({ gmshExe, geoPath: geo, outPath, cwd: path.dirname(geo), project })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendLogs(project, [`[gmsh] post-process failed: ${message}`])
  }
}

export async function runProject(project: Project) {
  if (project.process) throw new Error('Project is already running')

  const athExe = process.env.ATHUI_ATH_EXE
    ? path.resolve(process.env.ATHUI_ATH_EXE)
    : path.join(repoRoot, 'ath-2025-06', 'ath.exe')

  try {
    await fs.access(athExe)
  } catch {
    throw new Error(`ath.exe not found at: ${athExe}`)
  }

  const outputsDir = path.join(project.dir, 'outputs')
  await fs.mkdir(outputsDir, { recursive: true })

  // Ath reads `ath.cfg` from the working directory. The bundled `ath-2025-06/ath.cfg`
  // points to a machine-specific `D:\\Horns` output root; use a project-local output root instead.
  const athCfgLines = [`OutputRootDir = ${JSON.stringify(outputsDir)}`]

  const meshCmd = resolveMeshCmd(project)
  if (meshCmd) athCfgLines.push(`MeshCmd = ${JSON.stringify(meshCmd)}`)

  const gnuplotPath =
    stringFromConfig(project, '_athui.GnuplotPath') ?? (process.env.ATHUI_GNUPLOT_PATH?.trim() || null)
  if (gnuplotPath) athCfgLines.push(`GnuplotPath = ${JSON.stringify(gnuplotPath)}`)

  const runtimeAthCfg = athCfgLines.join('\n') + '\n'
  await fs.writeFile(path.join(project.dir, 'ath.cfg'), runtimeAthCfg, 'utf8')

  const definitionPath = path.join(project.dir, 'project.cfg')
  const cfgTextOverride = project.config['_athui.cfgText']
  const cfgText =
    typeof cfgTextOverride === 'string' && cfgTextOverride.trim().length
      ? normalizeCfgText(cfgTextOverride)
      : serializeAthDefinition(project.config)
  await fs.writeFile(definitionPath, cfgText, 'utf8')

  appendLogs(project, [`[run] ${athExe} ${definitionPath}`])
  appendLogs(project, [`[run] OutputRootDir = ${outputsDir}`])
  appendLogs(project, [`[run] MeshCmd = ${meshCmd ?? '(not set)'}`])

  const child = spawn(athExe, [definitionPath], {
    cwd: project.dir,
    windowsHide: true,
  })

  project.process = child

  const timeoutMs = Number.parseInt(process.env.ATHUI_TIMEOUT_MS ?? '120000', 10)
  const timeout = setTimeout(() => {
    appendLogs(project, [`[run] timeout after ${timeoutMs}ms; killing process`])
    child.kill()
  }, timeoutMs)

  child.stdout.on('data', (b: Buffer) => appendLogs(project, toLines(b.toString('utf8'))))
  child.stderr.on('data', (b: Buffer) => appendLogs(project, toLines(b.toString('utf8'))))
  child.on('error', (err) => appendLogs(project, [`[run] process error: ${err.message}`]))
  child.on('close', (code, signal) => {
    clearTimeout(timeout)
    appendLogs(project, [`[run] exit code=${code ?? 'null'} signal=${signal ?? 'null'}`])
    project.process = null

    if (code === 0) {
      void (async () => {
        await postProcessOutputs(project, outputsDir, meshCmd)
        const files = await listProjectFiles(project)
        broadcast(project, { type: 'files:update', files })
        broadcast(project, { type: 'run:done' })
      })()
    }
  })
}

export async function listProjectFiles(project: Project): Promise<{ path: string; size: number }[]> {
  const entries: { path: string; size: number }[] = []

  async function walk(current: string) {
    const children = await fs.readdir(current, { withFileTypes: true })
    for (const child of children) {
      const full = path.join(current, child.name)
      const rel = path.relative(project.dir, full).replaceAll(path.sep, '/')
      if (child.isDirectory()) {
        if (child.name === 'node_modules') continue
        await walk(full)
      } else if (child.isFile()) {
        const stat = await fs.stat(full)
        entries.push({ path: rel, size: stat.size })
        if (entries.length > 500) return
      }
    }
  }

  await walk(project.dir)
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

export async function resolveProjectFile(project: Project, relativePath: string): Promise<string | null> {
  const normalized = relativePath.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null

  const full = path.resolve(project.dir, normalized)
  const rel = path.relative(project.dir, full)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null

  try {
    const stat = await fs.stat(full)
    if (!stat.isFile()) return null
    return full
  } catch {
    return null
  }
}
