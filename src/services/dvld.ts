import { randomBytes } from 'node:crypto'
import { type Db, pool, query, queryOne } from '../db/pool.js'
import { supabaseAdmin } from '../lib/supabase.js'
import { GOVERNORATES, type Category, type Governorate } from './estimate.js'

/**
 * DVLD plates are numbers DVLD still sells and nobody has bought yet. Every listing needs an owner,
 * so they belong to this special "DVLD" account. Nobody can sign in to it (its password is random
 * and never stored): admins add, reprice and remove DVLD plates from the admin panel instead.
 */
export const DVLD_ACCOUNT_ID = '00000000-0000-4000-8000-00000000d71d'
export const DVLD_NAME = 'دائرة ترخيص السواقين والمركبات (DVLD)'
const DVLD_EMAIL = 'dvld@numrati.system'

let accountReady = false

/** Creates the DVLD account the first time it is needed */
export async function ensureDvldAccount() {
  if (accountReady) return DVLD_ACCOUNT_ID
  const existing = await queryOne('select 1 from profiles where id = $1', [DVLD_ACCOUNT_ID])
  if (!existing) {
    const { error } = await supabaseAdmin.auth.admin.createUser({
      id: DVLD_ACCOUNT_ID,
      email: DVLD_EMAIL,
      password: randomBytes(32).toString('base64url'),
      email_confirm: true,
      user_metadata: { full_name: DVLD_NAME },
    })
    if (error && error.code !== 'email_exists' && !/already/i.test(error.message)) throw new Error(`Could not create the DVLD account: ${error.message}`)
    await query(
      `insert into profiles (id, full_name, role, verification_status, verified_at)
       values ($1, $2, 'seller', 'verified', now())
       on conflict (id) do update set full_name = excluded.full_name, role = 'seller', verification_status = 'verified', banned_at = null`,
      [DVLD_ACCOUNT_ID, DVLD_NAME],
    )
  }
  accountReady = true
  return DVLD_ACCOUNT_ID
}

/** The plate's category, worked out from its number (same rules as the demo data) */
export function categoryFor(code: string): Category {
  const num = code.split('-')[1] ?? ''
  if (num.length <= 2) return 'exclusive'
  if (new Set(num).size <= 2) return 'repeated'
  const steps = new Set([...num].slice(1).map((d, i) => +d - +num[i]))
  if (steps.size === 1 && (steps.has(1) || steps.has(-1))) return 'sequential'
  if (num.length === 3) return 'special'
  return 'regular'
}

export interface DvldPlateInput {
  code: string
  price: number
  governorate?: string
}

/**
 * Adds DVLD plates at their official price. They go live right away (an admin is adding them).
 * Numbers that are wrong, repeated in the list or already listed are skipped and reported back.
 */
export async function addDvldPlates(rows: DvldPlateInput[], options: { adminId?: string; db?: Db; dryRun?: boolean } = {}) {
  const db = options.db ?? pool
  const dvldId = await ensureDvldAccount()
  const skipped: { code: string; reason: string }[] = []
  const valid: { code: string; price: number; governorate: Governorate }[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const code = String(row.code ?? '').trim()
    const price = Math.round(Number(row.price))
    if (!/^[0-9]{1,2}-[0-9]{1,5}$/.test(code)) skipped.push({ code, reason: 'Number must look like 31-1234' })
    else if (!Number.isFinite(price) || price < 50 || price > 5_000_000) skipped.push({ code, reason: 'Price must be between 50 and 5,000,000 JD' })
    else if (seen.has(code)) skipped.push({ code, reason: 'Appears twice in this list' })
    else {
      seen.add(code)
      const gov = String(row.governorate ?? '').trim().toLowerCase()
      valid.push({ code, price, governorate: (GOVERNORATES as readonly string[]).includes(gov) ? (gov as Governorate) : 'amman' })
    }
  }

  // One query to find numbers that already have an open listing (DVLD or owned)
  const taken = new Set(
    (await query<{ code: string }>(
      `select code from plates where code = any($1) and status in ('pending', 'active')`,
      [valid.map((v) => v.code)],
      db,
    )).map((r) => r.code),
  )
  const toAdd = valid.filter((v) => {
    if (!taken.has(v.code)) return true
    skipped.push({ code: v.code, reason: 'Already listed' })
    return false
  })

  // A dry run only reports what would be added
  if (options.dryRun) return { added: toAdd.map((v) => ({ id: '', code: v.code })), skipped }

  // One insert for the whole list; "on conflict" also covers a number listed at the same moment
  const added = toAdd.length
    ? await query<{ id: string; code: string }>(
        `insert into plates (seller_id, code, category, governorate, price, estimated_value, status, ownership,
                             owner_name, owner_national_id, risk_score, reviewed_by, reviewed_at, published_at)
         select $1, x.code, x.category::plate_category, x.governorate::governorate, x.price, x.price, 'active', 'dvld',
                'DVLD', '0000000000', 0, $6, now(), now()
         from unnest($2::text[], $3::text[], $4::text[], $5::int[]) as x(code, category, governorate, price)
         on conflict (code) where status in ('pending', 'active') do nothing
         returning id, code`,
        [dvldId, toAdd.map((v) => v.code), toAdd.map((v) => categoryFor(v.code)), toAdd.map((v) => v.governorate), toAdd.map((v) => v.price), options.adminId ?? null],
        db,
      )
    : []

  const addedCodes = new Set(added.map((a) => a.code))
  for (const v of toAdd) if (!addedCodes.has(v.code)) skipped.push({ code: v.code, reason: 'Already listed' })
  return { added, skipped }
}
