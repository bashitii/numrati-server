/**
 * Adds DVLD plates (numbers DVLD still sells) from a spreadsheet:
 *
 *   npm run import-dvld -- <file.xlsx | file.csv> [--sheet "Data Entry"] [--limit 200] [--dry-run]
 *
 * --dry-run shows what would be added without changing anything.
 *
 * The file needs a column with the plate number (e.g. "Plate": 31-1234, or "Code" + "Number")
 * and a "Price" column with the official DVLD price. An optional "Governorate" column is used too.
 * Numbers that are already listed are skipped, so running it twice never creates duplicates.
 */
import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import ExcelJS from 'exceljs'
import { pool } from '../db/pool.js'
import { addDvldPlates, type DvldPlateInput } from '../services/dvld.js'

const args = process.argv.slice(2)
const option = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const takesValue = ['--sheet', '--limit']
const file = args.find((a, i) => !a.startsWith('--') && !takesValue.includes(args[i - 1]))
if (!file) {
  console.log('Usage: npm run import-dvld -- <file.xlsx | file.csv> [--sheet "Data Entry"] [--limit 200] [--dry-run]')
  process.exit(1)
}
const limit = option('limit') ? Number(option('limit')) : Infinity
const dryRun = args.includes('--dry-run')

/** The text of an Excel cell: plain values, formula results, rich text and links (empty formulas become "") */
function cellText(value: unknown): string {
  if (value == null) return ''
  if (typeof value !== 'object') return String(value).trim()
  const v = value as { result?: unknown; richText?: { text: string }[]; text?: unknown }
  if ('result' in v) return v.result == null ? '' : String(v.result).trim()
  if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('').trim()
  if ('text' in v) return String(v.text ?? '').trim()
  return ''
}

/** Reads all rows as arrays of cell text */
async function readRows(path: string): Promise<{ sheet: string; rows: string[][] }[]> {
  if (extname(path).toLowerCase() === '.csv') {
    const text = readFileSync(path, 'utf8').replace(/^﻿/, '')
    const separator = text.includes('\t') ? '\t' : text.split('\n')[0].includes(';') ? ';' : ','
    const rows = text.split(/\r?\n/).filter(Boolean).map((line) => line.split(separator).map((c) => c.replace(/^"|"$/g, '').trim()))
    return [{ sheet: 'csv', rows }]
  }
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(path)
  return workbook.worksheets.map((ws) => {
    const rows: string[][] = []
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : []
      // Array.from fills the gaps Excel leaves for empty cells
      rows.push(Array.from(values, cellText))
    })
    return { sheet: ws.name, rows }
  })
}

/** Finds the header row and turns the sheet into plates */
function toPlates(rows: string[][]): DvldPlateInput[] | null {
  for (let h = 0; h < Math.min(rows.length, 10); h++) {
    const header = rows[h].map((c) => c.toLowerCase())
    const col = (...names: string[]) => header.findIndex((c) => names.some((n) => c.startsWith(n)))
    const plate = col('plate', 'اللوحة', 'رقم اللوحة')
    const code = col('code', 'الرمز')
    const number = col('number', 'الرقم')
    const price = col('price', 'السعر')
    const governorate = col('governorate', 'المحافظة')
    if (price < 0 || (plate < 0 && (code < 0 || number < 0))) continue

    return rows
      .slice(h + 1)
      .map((r) => ({
        code: plate >= 0 ? r[plate] : `${r[code]}-${r[number]}`,
        price: Number(String(r[price]).replace(/[^\d.]/g, '')),
        governorate: governorate >= 0 ? r[governorate] : undefined,
      }))
      .filter((p) => p.code && p.code !== '-' && p.code !== 'undefined-undefined')
  }
  return null
}

const path = resolve(file)
const sheets = await readRows(path)
const wanted = option('sheet')
const candidates = wanted ? sheets.filter((s) => s.sheet === wanted) : sheets
const found = candidates.map((s) => ({ sheet: s.sheet, plates: toPlates(s.rows) })).find((s) => s.plates)
if (!found?.plates) {
  console.log(`No sheet with a plate number column and a "Price" column was found${wanted ? ` (looked in "${wanted}")` : ''}.`)
  process.exit(1)
}

const plates = found.plates.slice(0, limit)
console.log(`Reading ${plates.length} plates from "${found.sheet}"...`)
const { added, skipped } = await addDvldPlates(plates, { dryRun })
await pool.end()

console.log(dryRun ? `Dry run: would add ${added.length} DVLD plates (nothing was changed).` : `Added ${added.length} DVLD plates.`)
if (skipped.length) {
  console.log(`Skipped ${skipped.length}:`)
  const reasons = new Map<string, string[]>()
  for (const s of skipped) reasons.set(s.reason, [...(reasons.get(s.reason) ?? []), s.code])
  for (const [reason, codes] of reasons) console.log(`  ${reason} (${codes.length}): ${codes.slice(0, 8).join(', ')}${codes.length > 8 ? ', ...' : ''}`)
}
