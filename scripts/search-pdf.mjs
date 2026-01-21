import fs from 'node:fs/promises'
import process from 'node:process'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

function usage() {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/search-pdf.mjs <pdfPath> <pattern>')
  process.exit(2)
}

const pdfPath = process.argv[2]
const pattern = process.argv[3]
if (!pdfPath || !pattern) usage()

const re = new RegExp(pattern, 'i')
const data = await fs.readFile(pdfPath)
const loadingTask = getDocument({ data: new Uint8Array(data), disableWorker: true })
const pdf = await loadingTask.promise

let matches = 0
for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
  const page = await pdf.getPage(pageNumber)
  const content = await page.getTextContent()
  const text = content.items.map((it) => ('str' in it ? it.str : '')).filter(Boolean).join(' ')
  if (!re.test(text)) continue

  matches++
  // eslint-disable-next-line no-console
  console.log(`\n--- page ${pageNumber} ---\n${text.slice(0, 2000)}\n`)
  if (matches >= 8) break
}

// eslint-disable-next-line no-console
console.log(`matches: ${matches}`)
