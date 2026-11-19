import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { query, queryOne, transaction } from '../db/pool.js'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js'
import { BUCKETS } from '../lib/supabase.js'
import { currentUser, optionalAuth, requireAuth, requireVerified } from '../middleware/auth.js'
import { parseBody, parseParams, parseQuery } from '../middleware/validate.js'
import { notify } from '../services/notifications.js'
import { closeOpenRequests, PLATE_CARD_SELECT, PUBLIC_PLATE_FILTER } from '../services/plates.js'
import { computeListingRisk } from '../services/risk.js'
import { CATEGORIES, GOVERNORATES } from '../services/estimate.js'
import { deleteFiles, saveFile, upload } from '../services/storage.js'

export const platesRouter = Router()

const idParam = z.object({ id: z.guid('Invalid plate id') })
const plateCode = z.string().trim().regex(/^[0-9]{1,2}-[0-9]{1,5}$/, 'Plate number must look like 12-34567')
const price = z.coerce.number().int().min(50).max(5_000_000)
const bool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])

// ---------------------------------------------------------------------------
// GET /api/plates  Browse and search
// ?q=123&category=special&governorate=amman&verifiedOnly=true&minPrice=&maxPrice=&status=active|sold|all
// &sort=latest|priceHigh|priceLow|popular&page=1&limit=20
// ---------------------------------------------------------------------------
platesRouter.get('/', async (req, res) => {
  const q = parseQuery(
    req,
    z.object({
      q: z.string().trim().max(20).optional(),
      category: z.enum(CATEGORIES).optional(),
      governorate: z.enum(GOVERNORATES).optional(),
      verifiedOnly: bool.optional(),
      featured: bool.optional(),
      minPrice: z.coerce.number().int().min(0).optional(),
      maxPrice: z.coerce.number().int().min(0).optional(),
      status: z.enum(['active', 'sold', 'all']).default('all'),
      sort: z.enum(['latest', 'priceHigh', 'priceLow', 'popular']).default('latest'),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }),
  )

  const where = [PUBLIC_PLATE_FILTER]
  const params: unknown[] = []
  const add = (sql: string, value: unknown) => {
    params.push(value)
    where.push(sql.replace('?', `$${params.length}`))
  }

  const digits = q.q?.replace(/\D/g, '')
  if (digits) add(`regexp_replace(p.code, '\\D', '', 'g') like '%' || ? || '%'`, digits)
  if (q.category) add('p.category = ?', q.category)
  if (q.governorate) add('p.governorate = ?', q.governorate)
  if (q.verifiedOnly) where.push(`s.verification_status = 'verified'`)
  if (q.featured) where.push('p.featured')
  if (q.minPrice != null) add('p.price >= ?', q.minPrice)
  if (q.maxPrice != null) add('p.price <= ?', q.maxPrice)
  if (q.status !== 'all') add('p.status = ?', q.status)

  const order = {
    latest: 'p.featured desc, coalesce(p.published_at, p.created_at) desc',
    priceHigh: 'p.price desc',
    priceLow: 'p.price asc',
    popular: 'p.views_count desc',
  }[q.sort]

  // live plates first, then sold. p.id breaks ties so pages never repeat or skip a plate.
  const sql = `${PLATE_CARD_SELECT} where ${where.join(' and ')}
               order by (p.status = 'sold'), ${order}, p.id
               limit ${q.limit + 1} offset ${(q.page - 1) * q.limit}`
  // The page of plates, plus how many plates match in total (for "186 results")
  const [rows, count] = await Promise.all([
    query(sql, params),
    queryOne<{ total: number }>(
      `select count(*)::int as total from plates p join profiles s on s.id = p.seller_id where ${where.join(' and ')}`,
      params,
    ),
  ])
  res.json({ items: rows.slice(0, q.limit), page: q.page, hasMore: rows.length > q.limit, total: count?.total ?? 0 })
})

// ---------------------------------------------------------------------------
// GET /api/plates/:id  Plate details (+ counts a view for signed-in visitors)
// ---------------------------------------------------------------------------
platesRouter.get('/:id', optionalAuth, async (req, res) => {
  const { id } = parseParams(req, idParam)
  const user = req.user

  const plate = await queryOne(`${PLATE_CARD_SELECT} where p.id = $1`, [id])
  const isOwner = plate && user?.id === plate.sellerId
  const isAdmin = user?.role === 'admin'
  if (!plate || (!['active', 'sold'].includes(plate.status) && !isOwner && !isAdmin)) throw notFound('Plate not found')

  // One view per person per day; the seller's own visits do not count
  // (one statement = one round trip, and still all-or-nothing)
  if (user && !isOwner && plate.status === 'active') {
    await query(
      `with counted as (
         insert into plate_views (plate_id, viewer_id) values ($1, $2) on conflict do nothing returning plate_id
       )
       update plates set views_count = views_count + 1 where id in (select plate_id from counted)`,
      [id, user.id],
    )
  }

  const [seller, priceHistory, similar, mine] = await Promise.all([
    queryOne(
      `select s.id, s.full_name as name, (s.verification_status = 'verified') as verified, s.created_at as since,
              (select count(*)::int from plates x where x.seller_id = s.id and x.status = 'sold') as sales
       from profiles s where s.id = $1`,
      [plate.sellerId],
    ),
    query(
      `select old_price as "oldPrice", new_price as "newPrice", changed_at as "changedAt"
       from price_history where plate_id = $1 order by changed_at`,
      [id],
    ),
    query(
      `${PLATE_CARD_SELECT} where ${PUBLIC_PLATE_FILTER} and p.status = 'active' and p.category = $1 and p.id <> $2
       order by abs(p.price - $3) limit 4`,
      [plate.category, id, plate.price],
    ),
    user
      ? queryOne(
          `select
             exists (select 1 from favorites where user_id = $1 and plate_id = $2) as "isFavorite",
             (select id from conversations where buyer_id = $1 and plate_id = $2) as "conversationId",
             (select id from purchase_requests where buyer_id = $1 and plate_id = $2 and status = 'pending') as "pendingRequestId"`,
          [user.id, id],
        )
      : null,
  ])

  // The seller and admins also see the private review fields
  const privateInfo =
    isOwner || isAdmin
      ? await queryOne(
          `select rejection_reason as "rejectionReason", owner_name as "ownerName",
                  risk_score as "riskScore", risk_flags as "riskFlags"
           from plates where id = $1`,
          [id],
        )
      : null

  res.json({
    plate,
    seller,
    priceHistory,
    similar,
    isFavorite: mine?.isFavorite ?? false,
    conversationId: mine?.conversationId ?? null,
    pendingRequestId: mine?.pendingRequestId ?? null,
    isOwner: Boolean(isOwner),
    private: privateInfo,
  })
})

// ---------------------------------------------------------------------------
// POST /api/plates  Create a listing (verified sellers; waits for admin approval)
// multipart/form-data with an optional "ownershipDoc" file, or plain JSON
// ---------------------------------------------------------------------------
platesRouter.post('/', requireAuth, requireVerified, upload.single('ownershipDoc'), async (req, res) => {
  const user = currentUser(req)
  const body = parseBody(
    req,
    z.object({
      code: plateCode,
      category: z.enum(CATEGORIES),
      governorate: z.enum(GOVERNORATES),
      price,
      ownerName: z.string().trim().min(2).max(80),
      ownerNationalId: z.string().trim().regex(/^[0-9]{10}$/, 'National ID must be 10 digits'),
      estimatedValue: z.coerce.number().int().min(1).max(50_000_000).optional(),
    }),
  )

  const pending = await queryOne<{ n: number }>(
    `select count(*)::int as n from plates where seller_id = $1 and status = 'pending'`,
    [user.id],
  )
  if (pending!.n >= 5) throw badRequest('You already have 5 listings waiting for review')

  const taken = await queryOne(`select 1 from plates where code = $1 and status in ('pending', 'active')`, [body.code])
  if (taken) throw conflict('This plate number is already listed')

  const docPath = req.file ? await saveFile(BUCKETS.ownership, user.id, req.file) : null

  try {
    const plate = await transaction(async (db) => {
      const risk = await computeListingRisk(
        { sellerId: user.id, code: body.code, category: body.category, price: body.price, estimate: body.estimatedValue ?? null },
        db,
      )
      const row = await queryOne(
        `insert into plates (seller_id, code, category, governorate, price, estimated_value,
                             owner_name, owner_national_id, ownership_doc_path, risk_score, risk_flags)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         returning id, code, status`,
        [user.id, body.code, body.category, body.governorate, body.price, body.estimatedValue ?? null,
         body.ownerName, body.ownerNationalId, docPath, risk.score, risk.flags],
        db,
      )
      await query(`update profiles set role = 'seller' where id = $1 and role = 'buyer'`, [user.id], db)
      return row
    })
    res.status(201).json({ plate, message: 'Your listing was sent for review' })
  } catch (error) {
    if (docPath) await deleteFiles(BUCKETS.ownership, [docPath])
    throw error
  }
})

// ---------------------------------------------------------------------------
// PATCH /api/plates/:id  Seller edits price / category / governorate
// A price change on a live listing stays live unless it now looks suspicious.
// Other changes, or editing a rejected listing, send it back for review.
// ---------------------------------------------------------------------------
platesRouter.patch('/:id', requireAuth, async (req, res) => {
  const user = currentUser(req)
  const { id } = parseParams(req, idParam)
  const body = parseBody(
    req,
    z.object({
      price: price.optional(),
      category: z.enum(CATEGORIES).optional(),
      governorate: z.enum(GOVERNORATES).optional(),
    }),
  )

  const result = await transaction(async (db) => {
    const plate = await queryOne(
      'select * from plates where id = $1 and seller_id = $2 for update',
      [id, user.id],
      db,
    )
    if (!plate) throw notFound('Listing not found')
    if (!['pending', 'active', 'rejected'].includes(plate.status)) throw badRequest('This listing can no longer be edited')

    const next = {
      price: body.price ?? plate.price,
      category: body.category ?? plate.category,
      governorate: body.governorate ?? plate.governorate,
    }
    const risk = await computeListingRisk(
      { sellerId: user.id, code: plate.code, category: next.category, price: next.price, estimate: plate.estimated_value, excludePlateId: plate.id },
      db,
    )

    let status: string = plate.status
    if (
      plate.status === 'rejected' ||
      next.category !== plate.category ||
      next.governorate !== plate.governorate ||
      (plate.status === 'active' && risk.score >= 60)
    ) {
      status = 'pending'
    }
    if (status === 'pending' && plate.status === 'rejected') {
      const taken = await queryOne(
        `select 1 from plates where code = $1 and status in ('pending', 'active') and id <> $2`,
        [plate.code, plate.id],
        db,
      )
      if (taken) throw conflict('This plate number is already listed')
    }

    const backToReview = status === 'pending'
    await query(
      `update plates set price = $2, category = $3, governorate = $4, status = $5,
         risk_score = $6, risk_flags = $7, updated_at = now(),
         rejection_reason = case when $8 then null else rejection_reason end,
         reviewed_by = case when $8 then null else reviewed_by end,
         reviewed_at = case when $8 then null else reviewed_at end
       where id = $1`,
      [plate.id, next.price, next.category, next.governorate, status, risk.score, risk.flags, backToReview],
      db,
    )

    // Price history + alert everyone who saved this plate
    if (next.price !== plate.price) {
      await query('insert into price_history (plate_id, old_price, new_price) values ($1, $2, $3)', [plate.id, plate.price, next.price], db)
      if (status === 'active') {
        const fans = await query<{ user_id: string }>('select user_id from favorites where plate_id = $1', [plate.id], db)
        for (const fan of fans) {
          await notify(fan.user_id, 'price_change', { plate_id: plate.id, code: plate.code, old_price: plate.price, new_price: next.price }, db)
        }
      }
    }
    return { status }
  })

  res.json({ ...result, message: result.status === 'pending' ? 'Changes sent for review' : 'Listing updated' })
})

// POST /api/plates/:id/sold  Seller marks a live listing as sold
platesRouter.post('/:id/sold', requireAuth, async (req, res) => {
  const user = currentUser(req)
  const { id } = parseParams(req, idParam)
  await transaction(async (db) => {
    const updated = await query(
      `update plates set status = 'sold', sold_at = now(), featured = false, updated_at = now()
       where id = $1 and seller_id = $2 and status = 'active' returning id`,
      [id, user.id],
      db,
    )
    if (!updated.length) throw notFound('Only your live listings can be marked as sold')
    await closeOpenRequests(id, 'sold', db)
  })
  res.json({ ok: true })
})

// DELETE /api/plates/:id  Seller removes a listing
platesRouter.delete('/:id', requireAuth, async (req, res) => {
  const user = currentUser(req)
  const { id } = parseParams(req, idParam)
  await transaction(async (db) => {
    const updated = await query(
      `update plates set status = 'removed', featured = false, updated_at = now()
       where id = $1 and seller_id = $2 and status in ('pending', 'active', 'rejected', 'suspended') returning id`,
      [id, user.id],
      db,
    )
    if (!updated.length) throw notFound('Listing not found')
    await closeOpenRequests(id, 'closed', db)
  })
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------------
platesRouter.post('/:id/favorite', requireAuth, async (req, res) => {
  const user = currentUser(req)
  const { id } = parseParams(req, idParam)
  await transaction(async (db) => {
    const plate = await queryOne(`select id, code, seller_id from plates where id = $1 and status = 'active'`, [id], db)
    if (!plate) throw notFound('This plate is not available')
    const added = await query(
      'insert into favorites (user_id, plate_id) values ($1, $2) on conflict do nothing returning plate_id',
      [user.id, id],
      db,
    )
    if (added.length) {
      await query('update plates set favorites_count = favorites_count + 1 where id = $1', [id], db)
      if (plate.seller_id !== user.id) await notify(plate.seller_id, 'favorite', { plate_id: id, code: plate.code }, db)
    }
  })
  res.json({ isFavorite: true })
})

platesRouter.delete('/:id/favorite', requireAuth, async (req, res) => {
  const user = currentUser(req)
  const { id } = parseParams(req, idParam)
  await transaction(async (db) => {
    const removed = await query('delete from favorites where user_id = $1 and plate_id = $2 returning plate_id', [user.id, id], db)
    if (removed.length) await query('update plates set favorites_count = greatest(favorites_count - 1, 0) where id = $1', [id], db)
  })
  res.json({ isFavorite: false })
})

// ---------------------------------------------------------------------------
// Chat with the seller / send a purchase request
// ---------------------------------------------------------------------------
async function startConversation(plateId: string, buyerId: string, db?: Parameters<typeof query>[2]) {
  const plate = await queryOne(`select id, code, price, seller_id from plates where id = $1 and status = 'active'`, [plateId], db)
  if (!plate) throw notFound('This plate is not available')
  if (plate.seller_id === buyerId) throw badRequest('This is your own listing')
  const conversation = await queryOne<{ id: string }>(
    `insert into conversations (plate_id, buyer_id, seller_id) values ($1, $2, $3)
     on conflict (plate_id, buyer_id) do update set plate_id = excluded.plate_id
     returning id`,
    [plateId, buyerId, plate.seller_id],
    db,
  )
  return { plate, conversationId: conversation!.id }
}

// POST /api/plates/:id/conversation  -> { conversationId }
platesRouter.post('/:id/conversation', requireAuth, async (req, res) => {
  const user = currentUser(req)
  const { id } = parseParams(req, idParam)
  const { conversationId } = await startConversation(id, user.id)
  res.json({ conversationId })
})

// POST /api/plates/:id/purchase-requests  { offeredPrice?, message? }
platesRouter.post(
  '/:id/purchase-requests',
  rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }),
  requireAuth,
  async (req, res) => {
    const user = currentUser(req)
    if (user.verificationStatus !== 'verified') throw forbidden('ID verification is required before sending a purchase request')
    const { id } = parseParams(req, idParam)
    const body = parseBody(
      req,
      z.object({
        offeredPrice: z.coerce.number().int().min(1).max(50_000_000).optional(),
        message: z.string().trim().max(500).optional(),
      }),
    )

    const result = await transaction(async (db) => {
      const { plate, conversationId } = await startConversation(id, user.id, db)
      const existing = await queryOne(
        `select 1 from purchase_requests where plate_id = $1 and buyer_id = $2 and status = 'pending'`,
        [id, user.id],
        db,
      )
      if (existing) throw conflict('You already sent a request for this plate')

      const offeredPrice = body.offeredPrice ?? plate.price
      const request = await queryOne<{ id: string }>(
        `insert into purchase_requests (plate_id, buyer_id, seller_id, conversation_id, offered_price, message)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [id, user.id, plate.seller_id, conversationId, offeredPrice, body.message || null],
        db,
      )
      await notify(
        plate.seller_id,
        'purchase_request',
        { request_id: request!.id, plate_id: id, code: plate.code, offered_price: offeredPrice, buyer_name: user.fullName, conversation_id: conversationId },
        db,
      )
      return { requestId: request!.id, conversationId, code: plate.code, offeredPrice }
    })
    res.status(201).json(result)
  },
)
