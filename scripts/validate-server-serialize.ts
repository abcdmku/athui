import assert from 'node:assert/strict'

import { serializeAthDefinition } from '../apps/server/src/serialize.ts'

function assertIncludes(text: string, needle: string) {
  assert.ok(text.includes(needle), `Expected cfg text to include: ${needle}\n---\n${text}\n---`)
}

function assertNotIncludes(text: string, needle: string) {
  assert.ok(!text.includes(needle), `Expected cfg text NOT to include: ${needle}\n---\n${text}\n---`)
}

function main() {
  {
    const text = serializeAthDefinition({
      HornGeometry: 2,
      'Horn.Adapter.Width': '',
      'Horn.Adapter.Height': null,
      'Horn.Adapter.k': undefined,
      'Horn.Adapter.Segments': '',
    })

    assertIncludes(text, 'HornGeometry = 2')
    assertIncludes(text, 'Horn.Adapter = {')
    assertIncludes(text, 'Length =')
    assertIncludes(text, 'Throat.Angle =')
    assertIncludes(text, 'Width = 28')
    assertIncludes(text, 'Height = 121.5')
    assertIncludes(text, 'k = 0')
    assertIncludes(text, 'NC = 0')
    assertIncludes(text, 'Horn.Part:1 = {')
    assertIncludes(text, 'H = [')
    assertIncludes(text, 'V = [')
    assertNotIncludes(text, 'Horn.Adapter.Width =')
    assertNotIncludes(text, 'Horn.Adapter.Height =')
  }

  {
    const text = serializeAthDefinition({
      HornGeometry: 2,
      'Horn.Adapter.Width': '40',
      'Horn.Adapter.Height': '90.25',
      'Horn.Adapter.Segments': '3.7',
    })

    assertIncludes(text, 'Width = 40')
    assertIncludes(text, 'Height = 90.25')
    assertIncludes(text, 'NC = 4')
  }

  {
    const text = serializeAthDefinition({
      HornGeometry: 2,
      'Horn.Adapter.Width': 0,
      'Horn.Adapter.Height': -1,
    })

    assertIncludes(text, 'Width = 28')
    assertIncludes(text, 'Height = 121.5')
  }

  // eslint-disable-next-line no-console
  console.log('[athui] server serialize validation: ok')
}

main()
