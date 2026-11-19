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
 * The 200 plates come from data/plates.json: real plate numbers with their official DVLD prices,
 * taken from the team's DVLD collection spreadsheet (Numrati_DVLD_Collection_Plan.xlsx).
 */
import { readFileSync } from 'node:fs'
import { pool, query, transaction } from '../db/pool.js'
import { supabaseAdmin } from '../lib/supabase.js'

const PASSWORD = 'Numrati2026'
const U = (n: number) => `00000000-0000-4000-a000-00000000000${n}`
const P = (n: number) => `00000000-0000-4000-b000-${String(n).padStart(12, '0')}`
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
  n: number
  seller: number
  code: string
  category: string
  governorate: string
  /** asking price */
  price: number
  /** official DVLD price */
  marketValue: number
  status: 'active' | 'sold' | 'pending'
  featured: boolean
  ageDays: number
  soldDaysAgo: number | null
  extraViews: number
  previousPrice?: number
}
const plates: SeedPlate[] = JSON.parse(readFileSync(new URL('./data/plates.json', import.meta.url), 'utf8'))
const plate = (n: number) => plates.find((p) => p.n === n)!

// Plates with a part in the demo story (fixed numbers in plates.json)
const featuredPlate = plate(1) // Mohammad's featured plate
const chatPlate = plate(3) // Khaled chats with Mohammad and sends a purchase request
const otherChatPlate = plate(7) // Ahmad asks Mohammad about it
const reportedPlate = plate(8) // "incorrect details" report
const suspiciousPlate = plate(11) // listed far below its DVLD price, waiting for admin review
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
      const risky = p.n === suspiciousPlate.n
      await query(
        `insert into plates (id, seller_id, code, category, governorate, price, estimated_value, status, featured,
                             owner_name, owner_national_id, risk_score, risk_flags,
                             published_at, sold_at, reviewed_at, created_at)
         values ($1, $2, $3, $4::plate_category, $5::governorate, $6, $7, $8::listing_status, $9,
                 (select full_name from profiles where id = $2), $10, $11, $12,
                 case when $8::listing_status <> 'pending' then now() - make_interval(days => $13) + interval '1 day' end,
                 case when $14::int is not null then now() - make_interval(days => $14::int) end,
                 case when $8::listing_status <> 'pending' then now() - make_interval(days => $13) + interval '1 day' end,
                 now() - make_interval(days => $13) - interval '1 hour')
         on conflict (id) do nothing`,
        [P(p.n), U(p.seller), p.code, p.category, p.governorate, p.price, p.marketValue, p.status, p.featured,
         `99${String(p.n).padStart(8, '0')}`, risky ? 90 : 12, risky ? ['price_far_below_market', 'price_below_estimate'] : [],
         p.ageDays, p.soldDaysAgo],
        db,
      )
    }

    // Recent price changes, so cards show "+x% this week"
    const hasHistory = (await query('select 1 from price_history limit 1', [], db)).length > 0
    if (!hasHistory) {
      for (const p of plates.filter((x) => x.previousPrice)) {
        await query(
          `insert into price_history (plate_id, old_price, new_price, changed_at) values ($1, $2, $3, now() - interval '3 days')`,
          [P(p.n), p.previousPrice, p.price],
          db,
        )
      }
    }

    const favorites = [[2, 2], [2, 4], [2, 5], [3, 1], [3, 3], [4, 1], [4, 7], [6, 1]]
    for (const [user, plate] of favorites) {
      await query('insert into favorites (user_id, plate_id) values ($1, $2) on conflict do nothing', [U(user), P(plate)], db)
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
      [plates.map((p) => P(p.n)), plates.map((p) => p.extraViews)],
      db,
    )

    // Chats and a purchase request
    await query(
      `insert into conversations (id, plate_id, buyer_id, seller_id, created_at) values
         ($1, $2, $3, $4, now() - interval '2 hours'),
         ($5, $6, $7, $4, now() - interval '1 day')
       on conflict (id) do nothing`,
      [C(1), P(chatPlate.n), U(3), U(2), C(2), P(otherChatPlate.n), U(4)],
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
        [P(chatPlate.n), U(3), U(2), C(1), offer, `I can pay ${jd(offer)} JD and meet at the DVLD this week.`],
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
        [U(3), P(suspiciousPlate.n), U(4), U(5), U(6), P(chatPlate.n), U(2), P(reportedPlate.n),
         `Plate ${suspiciousPlate.code} is listed for ${jd(suspiciousPlate.price)} JD, but its DVLD price is ${jd(suspiciousPlate.marketValue)} JD`,
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
        [U(2), C(1), P(chatPlate.n), P(featuredPlate.n), chatPlate.code, offer, featuredPlate.code],
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
console.log('Adding demo data...')
await seedDatabase()
await pool.end()
console.log(`Done. Sign in with any demo email and the password ${PASSWORD}`)
