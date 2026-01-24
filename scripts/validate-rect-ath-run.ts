import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { serializeAthDefinition } from '../apps/server/src/serialize.ts'

function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function main() {
  const repoRoot = process.cwd()
  const athExe = path.join(repoRoot, 'ath-2025-06', 'ath.exe')

  const runRoot = path.join(repoRoot, '.athui-data', 'ath-regress-rect', ts())
  const outputsDir = path.join(runRoot, 'outputs')
  await fs.mkdir(outputsDir, { recursive: true })

  const athCfg = `OutputRootDir = ${JSON.stringify(outputsDir)}\n`
  await fs.writeFile(path.join(runRoot, 'ath.cfg'), athCfg, 'utf8')

  const projectCfg = serializeAthDefinition({
    HornGeometry: 2,
    'Horn.Adapter.Width': 28,
    'Horn.Adapter.Height': 121.5,
    'Horn.Adapter.Segments': 0,
  })
  const projectCfgPath = path.join(runRoot, 'project.cfg')
  await fs.writeFile(projectCfgPath, projectCfg, 'utf8')

  const result = spawnSync(athExe, [projectCfgPath], { cwd: runRoot, encoding: 'utf8', windowsHide: true })
  const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()

  assert.ok(!/Syntax error 2: 'Horn\.Adapter'/.test(out), out)
  assert.ok(!/mandatory item 'Width' not set/.test(out), out)
  assert.equal(result.status, 0, out)

  // eslint-disable-next-line no-console
  console.log('[athui] rectangular ath run validation: ok')
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})

