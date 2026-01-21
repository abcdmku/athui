import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

function usage() {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/dump-pdf-page.mjs <pdfPath> <pageNumber> [outPath]')
  process.exit(2)
}

const pdfPath = process.argv[2]
const pageNumberRaw = process.argv[3]
const outPath = process.argv[4] ?? null
if (!pdfPath || !pageNumberRaw) usage()

const pageNumber = Number.parseInt(pageNumberRaw, 10)
if (!Number.isFinite(pageNumber) || pageNumber <= 0) usage()

const data = await fs.readFile(pdfPath)
const loadingTask = getDocument({ data: new Uint8Array(data), disableWorker: true })
const pdf = await loadingTask.promise
if (pageNumber > pdf.numPages) {
  // eslint-disable-next-line no-console
  console.error(`PDF has ${pdf.numPages} pages; requested page ${pageNumber}`)
  process.exit(2)
}

const page = await pdf.getPage(pageNumber)
const content = await page.getTextContent()
const text = content.items.map((it) => ('str' in it ? it.str : '')).filter(Boolean).join(' ')
const normalized = text.replaceAll(/\s+/g, ' ').trim() + '\n'

if (outPath) {
  const dir = path.dirname(outPath)
  if (dir && dir !== '.' && dir !== outPath) await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(outPath, normalized, 'utf8')
} else {
  // eslint-disable-next-line no-console
  console.log(normalized)
}
