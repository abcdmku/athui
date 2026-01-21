import cors from 'cors'
import express from 'express'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { createProject, getProject, listProjectFiles, resolveProjectFile, runProject, updateProjectConfig } from './projects.js'

const app = express()

app.use(express.json({ limit: '2mb' }))
app.use(
  cors({
    origin: [/^http:\/\/localhost:\d+$/],
  }),
)

app.get('/api/health', (_req, res) => res.json({ ok: true }))

app.post('/api/projects', async (_req, res) => {
  const project = await createProject()
  res.status(201).json({ id: project.id })
})

app.put('/api/projects/:id/config', async (req, res) => {
  const id = req.params.id
  const project = getProject(id)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  await updateProjectConfig(project, (req.body ?? {}) as Record<string, unknown>)
  res.status(204).end()
})

app.post('/api/projects/:id/run', async (req, res) => {
  const id = req.params.id
  const project = getProject(id)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  try {
    await runProject(project)
    res.status(202).json({ status: 'started' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Run failed'
    res.status(400).json({ error: message })
  }
})

app.get('/api/projects/:id/logs', (req, res) => {
  const project = getProject(req.params.id)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  res.json({ lines: project.logs })
})

app.get('/api/projects/:id/files', async (req, res) => {
  const project = getProject(req.params.id)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  const files = await listProjectFiles(project)
  res.json({ files })
})

app.get('/api/projects/:id/files/download', async (req, res) => {
  const project = getProject(req.params.id)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const rel = typeof req.query.path === 'string' ? req.query.path : ''
  const full = await resolveProjectFile(project, rel)
  if (!full) return res.status(404).json({ error: 'File not found' })

  res.download(full, path.basename(full))
})

app.get('/api/projects/:id/files/raw', async (req, res) => {
  const project = getProject(req.params.id)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const rel = typeof req.query.path === 'string' ? req.query.path : ''
  const full = await resolveProjectFile(project, rel)
  if (!full) return res.status(404).json({ error: 'File not found' })

  res.setHeader('Content-Disposition', 'inline')
  res.setHeader('Cache-Control', 'no-store, max-age=0')
  res.sendFile(full)
})

app.get('/api/projects/:id/files/text', async (req, res) => {
  const project = getProject(req.params.id)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const rel = typeof req.query.path === 'string' ? req.query.path : ''
  const full = await resolveProjectFile(project, rel)
  if (!full) return res.status(404).json({ error: 'File not found' })

  const ext = path.extname(full).toLowerCase()
  const allowed = new Set(['.cfg', '.txt', '.geo', '.abec', '.json', '.log'])
  if (!allowed.has(ext)) return res.status(415).json({ error: 'Not a supported text file' })

  const stat = await fs.promises.stat(full)
  if (stat.size > 1024 * 1024) return res.status(413).json({ error: 'File too large' })

  const text = await fs.promises.readFile(full, 'utf8')
  res.json({ text })
})

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (socket, req) => {
  const url = new URL(req.url ?? '', 'http://localhost')
  const projectId = url.searchParams.get('projectId')
  if (!projectId) {
    socket.close(1008, 'Missing projectId')
    return
  }
  const project = getProject(projectId)
  if (!project) {
    socket.close(1008, 'Unknown projectId')
    return
  }

  project.wsClients.add(socket)
  socket.on('close', () => project.wsClients.delete(socket))

  socket.send(JSON.stringify({ type: 'logs:init', lines: project.logs }))
  void listProjectFiles(project).then((files) => socket.send(JSON.stringify({ type: 'files:update', files })))
})

const port = Number.parseInt(process.env.PORT ?? '5174', 10)
server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[athui] server listening on http://localhost:${port}`)
})
