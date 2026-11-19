/**
 * Demo data for testing and the capstone presentation:  npm run seed
 * Safe to run more than once (existing rows are skipped).
 *
 * Every demo account uses the password Numrati2026 (test only, delete before a real launch):
 *   admin@numrati.test     Admin
 *   mohammad@numrati.test  Verified seller (main demo account)
 *   khaled@numrati.test    Verified seller and buyer
 *   ahmad@numrati.test     Verified seller
 *   reem@numrati.test      ID verification waiting for admin review
 *   nour@numrati.test      New buyer, not verified yet
 *
 * Two kinds of listings:
 *   - 200 DVLD plates (data/dvld-plates.json): numbers DVLD still sells, with their official DVLD prices,
 *     taken from the team's DVLD collection spreadsheet (Numrati_DVLD_Collection_Plan.xlsx).
 *     They belong to the DVLD account (nobody signs in to it) and are kept by `npm run reset-demo`.
 *   - Owned plates: plates people own and resell, listed by the demo sellers. These carry the demo story
 *     (chats, a purchase request, reports and a suspicious listing for the admin queue).
 */
import { readFileSync } from 'node:fs'
import { pool, query, transaction } from '../db/pool.js'
import { supabaseAdmin } from '../lib/supabase.js'
import { DVLD_ACCOUNT_ID, ensureDvldAccount } from '../services/dvld.js'

const PASSWORD = 'Numrati2026'
const U = (n: number) => `00000000-0000-4000-a000-00000000000${n}`
const P = (n: number) => `00000000-0000-4000-b000-${String(n).padStart(12, '0')}` // DVLD plates
const O = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}` // owned plates
const C = (n: number) => `00000000-0000-4000-c000-00000000000${n}`

const users = [
  { id: U(1), email: 'admin@numrati.test', name: 'Numrati Admin', phone: '+962790000001', role: 'admin', status: 'verified', ageDays: 400 },
  { id: U(2), email: 'mohammad@numrati.test', name: 'محمد العبدالله', phone: '+962791234567', role: 'seller', status: 'verified', ageDays: 240 },
  { id: U(3), email: 'khaled@numrati.test', name: 'خالد العمر', phone: '+962781234567', role: 'seller', status: 'verified', ageDays: 180 },
  { id: U(4), email: 'ahmad@numrati.test', name: 'أحمد المصري', phone: '+962771234567', role: 'seller', status: 'verified', ageDays: 120 },
  { id: U(5), email: 'reem@numrati.test', name: 'ريم الحسن', phone: '+962795550142', role: 'buyer', status: 'pending', ageDays: 3 },
  { id: U(6), email: 'nour@numrati.test', name: 'نور سالم', phone: '+962795550110', role: 'buyer', status: 'unverified', ageDays: 1 },
]

interface SeedPlate {
  id: string
  sellerId: string
  ownership: 'owned' | 'dvld'
  code: string
  category: string
  governorate: string
  /** asking price (DVLD plates: the official DVLD price) */
  price: number
  /** market value (DVLD plates: the same official price) */
  marketValue: number
  status: 'active' | 'sold' | 'pending'
  featured: boolean
  ageDays: number
  soldDaysAgo: number | null
  extraViews: number
  previousPrice?: number
  risky?: boolean
}

// DVLD plates: official prices from the spreadsheet
const dvldPlates: SeedPlate[] = (
  JSON.parse(readFileSync(new URL('./data/dvld-plates.json', import.meta.url), 'utf8')) as {
    n: number; code: string; category: string; governorate: string; price: number; featured: boolean; ageDays: number; extraViews: number
  }[]
).map((p) => ({
  id: P(p.n), sellerId: DVLD_ACCOUNT_ID, ownership: 'dvld', code: p.code, category: p.category, governorate: p.governorate,
  price: p.price, marketValue: p.price, status: 'active', featured: p.featured, ageDays: p.ageDays, soldDaysAgo: null, extraViews: p.extraViews,
}))

// Owned plates: listed by the demo sellers, used by the demo story
// [n, seller, code, category, governorate, price, market value, status, featured, ageDays, soldDaysAgo, extra views, price a few days ago]
const ownedRows: [number, number, string, string, string, number, number, SeedPlate['status'], boolean, number, number | null, number, number | null][] = [
  [1, 2, '1-9252', 'special', 'amman', 85000, 88000, 'active', true, 21, null, 1150, 80800],
  [2, 3, '33-441', 'exclusive', 'irbid', 15000, 15800, 'active', false, 10, null, 215, null],
  [3, 2, '80-4000', 'special', 'amman', 9500, 10200, 'active', false, 12, null, 430, 9550],
  [4, 3, '11-318', 'repeated', 'zarqa', 22000, 21000, 'active', false, 2, null, 760, 20300],
  [5, 4, '11-98881', 'special', 'aqaba', 11200, 11500, 'active', false, 14, null, 420, null],
  [6, 4, '15-51552', 'repeated', 'balqa', 14000, 13200, 'active', false, 16, null, 650, null],
  [7, 2, '20-12345', 'sequential', 'amman', 18000, 19000, 'active', false, 18, null, 490, null],
  [8, 3, '12-6789', 'sequential', 'karak', 4800, 5200, 'active', false, 20, null, 180, null],
  [9, 4, '50-77777', 'regular', 'irbid', 8500, 9900, 'sold', false, 31, 5, 190, null],
  [10, 3, '11-1188', 'special', 'amman', 18000, 17500, 'pending', false, 0, null, 0, null],
  [11, 4, '7-777', 'repeated', 'irbid', 900, 26000, 'pending', false, 0, null, 0, null],
]
const ownedPlates: SeedPlate[] = ownedRows.map(([n, seller, code, category, governorate, price, marketValue, status, featured, ageDays, soldDaysAgo, extraViews, previousPrice]) => ({
  id: O(n), sellerId: U(seller), ownership: 'owned', code, category, governorate, price, marketValue, status, featured, ageDays, soldDaysAgo, extraViews,
  previousPrice: previousPrice ?? undefined, risky: n === 11,
}))
const plates = [...dvldPlates, ...ownedPlates]
const owned = (n: number) => ownedPlates[n - 1]

// Plates with a part in the demo story
const featuredPlate = owned(1) // Mohammad's featured plate
const chatPlate = owned(3) // Khaled chats with Mohammad and sends a purchase request
const otherChatPlate = owned(7) // Ahmad asks Mohammad about it
const reportedPlate = owned(8) // "incorrect details" report
const suspiciousPlate = owned(11) // listed far below its market value, waiting for admin review
const offer = Math.round((chatPlate.price * 0.93) / 100) * 100
const jd = (n: number) => n.toLocaleString('en-US')

async function createAuthUsers() {
  for (const u of users) {
    const { error } = await supabaseAdmin.auth.admin.createUser({
      id: u.id,
      email: u.email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: u.name },
    })
    if (error && error.code !== 'email_exists' && !/already/i.test(error.message)) {
      throw new Error(`Could not create ${u.email}: ${error.message}`)
    }
    console.log(`  ${error ? 'exists ' : 'created'}  ${u.email}`)
  }
}

async function seedDatabase() {
  await transaction(async (db) => {
    for (const u of users) {
      await query(
        `insert into profiles (id, full_name, phone, role, verification_status, verified_at, created_at)
         values ($1, $2, $3, $4::user_role, $5::verification_status, case when $5::verification_status = 'verified' then now() - interval '200 days' end, now() - make_interval(days => $6))
         on conflict (id) do update set role = excluded.role, verification_status = excluded.verification_status`,
        [u.id, u.name, u.phone, u.role, u.status, u.ageDays],
        db,
      )
    }

    await query(
      `insert into verification_requests (user_id, id_front_path, id_back_path, selfie_path, created_at)
       select $1::uuid, $1::text || '/id-front.jpg', $1::text || '/id-back.jpg', $1::text || '/selfie.jpg', now() - interval '2 hours'
       where not exists (select 1 from verification_requests where user_id = $1::uuid)`,
      [U(5)],
      db,
    )

    for (const p of plates) {
      const dvld = p.ownership === 'dvld'
      await query(
        `insert into plates (id, seller_id, code, category, governorate, price, estimated_value, status, featured, ownership,
                             owner_name, owner_national_id, risk_score, risk_flags,
                             published_at, sold_at, reviewed_at, created_at)
         values ($1, $2, $3, $4::plate_category, $5::governorate, $6, $7, $8::listing_status, $9, $10,
                 $11, $12, $13, $14,
                 case when $8::listing_status <> 'pending' then now() - make_interval(days => $15) + interval '1 day' end,
                 case when $16::int is not null then now() - make_interval(days => $16::int) end,
                 case when $8::listing_status <> 'pending' then now() - make_interval(days => $15) + interval '1 day' end,
                 now() - make_interval(days => $15) - interval '1 hour')
         on conflict (id) do nothing`,
        [p.id, p.sellerId, p.code, p.category, p.governorate, p.price, p.marketValue, p.status, p.featured, p.ownership,
         dvld ? 'DVLD' : users.find((u) => u.id === p.sellerId)!.name,
         dvld ? '0000000000' : `99${p.id.slice(-8)}`,
         dvld ? 0 : p.risky ? 90 : 12,
         p.risky ? ['price_far_below_market', 'price_below_estimate'] : [],
         p.ageDays, p.soldDaysAgo],
        db,
      )
    }

    // Recent price changes, so cards show "+x% this week"
    for (const p of plates.filter((x) => x.previousPrice)) {
      await query(
        `insert into price_history (plate_id, old_price, new_price, changed_at)
         select $1, $2, $3, now() - interval '3 days' where not exists (select 1 from price_history where plate_id = $1)`,
        [p.id, p.previousPrice, p.price],
        db,
      )
    }

    const favorites = [[2, 2], [2, 4], [2, 5], [3, 1], [3, 3], [4, 1], [4, 7], [6, 1]]
    for (const [user, plate] of favorites) {
      await query('insert into favorites (user_id, plate_id) values ($1, $2) on conflict do nothing', [U(user), O(plate)], db)
    }
    await query('update plates p set favorites_count = (select count(*) from favorites f where f.plate_id = p.id)', [], db)

    // A steady spread of views over the last 30 days for the analytics chart
    await query(
      `insert into plate_views (plate_id, viewer_id, viewed_on)
       select p.id, v.id, current_date - d
       from plates p
       cross join generate_series(0, 29) as d
       join profiles v on v.id <> p.seller_id
       where p.status = 'active' and (abs(hashtext(p.id::text || v.id::text || d::text)) % 3) = 0
       on conflict do nothing`,
      [],
      db,
    )
    // Plus the views from visitors who weren't signed in
    await query(
      `update plates p set views_count = (select count(*) from plate_views v where v.plate_id = p.id) + x.extra
       from (select unnest($1::uuid[]) as id, unnest($2::int[]) as extra) x
       where x.id = p.id`,
      [plates.map((p) => p.id), plates.map((p) => p.extraViews)],
      db,
    )

    // Chats and a purchase request
    await query(
      `insert into conversations (id, plate_id, buyer_id, seller_id, created_at) values
         ($1, $2, $3, $4, now() - interval '2 hours'),
         ($5, $6, $7, $4, now() - interval '1 day')
       on conflict (id) do nothing`,
      [C(1), chatPlate.id, U(3), U(2), C(2), otherChatPlate.id, U(4)],
      db,
    )
    const hasMessages = (await query('select 1 from messages limit 1', [], db)).length > 0
    if (!hasMessages) {
      const messages: [string, string, string, string][] = [
        [C(1), U(3), `السلام عليكم، هل اللوحة ${chatPlate.code} لا تزال متاحة؟`, '100 minutes'],
        [C(1), U(2), 'وعليكم السلام! نعم، اللوحة متاحة. كيف أستطيع مساعدتك؟', '98 minutes'],
        [C(1), U(3), `هل السعر ${jd(chatPlate.price)} JD قابل للتفاوض؟ أقدر أقدم ${jd(offer)} JD`, '95 minutes'],
        [C(1), U(2), 'يمكن نتفاهم، تعال نجلس ونحكي بالتفاصيل 😊', '92 minutes'],
        [C(1), U(3), 'ممتاز! متى يناسبك؟', '90 minutes'],
        [C(2), U(4), `Hi, is ${otherChatPlate.code} still available?`, '26 hours'],
        [C(2), U(2), 'Yes it is. Thanks for the interest!', '25 hours'],
      ]
      for (const [conversation, sender, body, ago] of messages) {
        await query(
          `insert into messages (conversation_id, sender_id, body, created_at) values ($1, $2, $3, now() - $4::interval)`,
          [conversation, sender, body, ago],
          db,
        )
      }
      await query(
        `update conversations c set
           last_message = m.body, last_message_at = m.created_at,
           buyer_last_read_at = c.created_at, seller_last_read_at = m.created_at - interval '1 minute'
         from (select distinct on (conversation_id) conversation_id, body, created_at
               from messages order by conversation_id, id desc) m
         where m.conversation_id = c.id`,
        [],
        db,
      )
      await query(
        `insert into purchase_requests (plate_id, buyer_id, seller_id, conversation_id, offered_price, message, created_at)
         values ($1, $2, $3, $4, $5, $6, now() - interval '80 minutes')`,
        [chatPlate.id, U(3), U(2), C(1), offer, `I can pay ${jd(offer)} JD and meet at the DVLD this week.`],
        db,
      )
    }

    // Reports, notifications and admin history
    const hasReports = (await query('select 1 from reports limit 1', [], db)).length > 0
    if (!hasReports) {
      await query(
        `insert into reports (reporter_id, plate_id, reported_user_id, reason, details, status, created_at) values
           ($1, $2, $3, 'suspicious_price', $9, 'new', now() - interval '30 minutes'),
           ($4, null, $5, 'unverified_seller', 'This user offers plates in chat without a verified ID', 'review', now() - interval '2 hours'),
           ($3, $6, $7, 'duplicate', $10, 'review', now() - interval '4 hours'),
           ($5, $8, $1, 'incorrect_details', $11, 'closed', now() - interval '1 day')`,
        [U(3), suspiciousPlate.id, U(4), U(5), U(6), chatPlate.id, U(2), reportedPlate.id,
         `Plate ${suspiciousPlate.code} is listed for ${jd(suspiciousPlate.price)} JD, far below its market value of ${jd(suspiciousPlate.marketValue)} JD`,
         `I saw the same plate ${chatPlate.code} posted on another site`,
         `The governorate for plate ${reportedPlate.code} looks wrong`],
        db,
      )
      await query(
        `insert into notifications (user_id, type, data, read_at, created_at) values
           ($1, 'message', jsonb_build_object('conversation_id', $2::text, 'plate_id', $3::text, 'sender_name', 'خالد العمر', 'preview', 'ممتاز! متى يناسبك؟'), null, now() - interval '90 minutes'),
           ($1, 'purchase_request', jsonb_build_object('plate_id', $3::text, 'code', $5::text, 'offered_price', $6::int, 'buyer_name', 'خالد العمر'), null, now() - interval '80 minutes'),
           ($1, 'listing_approved', jsonb_build_object('plate_id', $4::text, 'code', $7::text), now(), now() - interval '20 days'),
           ($1, 'favorite', jsonb_build_object('plate_id', $4::text, 'code', $7::text), now(), now() - interval '1 day')`,
        [U(2), C(1), chatPlate.id, featuredPlate.id, chatPlate.code, offer, featuredPlate.code],
        db,
      )
      await query(
        `insert into admin_actions (admin_id, action, target_type, target_id, details, created_at) values
           ($1, 'verification_approve', 'user', $2, '{"name": "أحمد المصري"}', now() - interval '5 minutes'),
           ($1, 'report_closed', 'report', '4', '{"reason": "incorrect_details"}', now() - interval '30 minutes')`,
        [U(1), U(4)],
        db,
      )
    }
  })
}

console.log('Creating demo accounts...')
await createAuthUsers()
await ensureDvldAccount()
console.log('Adding demo data...')
await seedDatabase()
await pool.end()
console.log(`Done. Sign in with any demo email and the password ${PASSWORD}`)
