import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db/pool.js'
import { badRequest, notFound, tooMany } from '../lib/errors.js'
import { currentUser, requireAuth } from '../middleware/auth.js'
import { parseBody } from '../middleware/validate.js'

export const reportsRouter = Router()
reportsRouter.use(requireAuth)

const REASONS = ['suspicious_price', 'fake_listing', 'unverified_seller', 'duplicate', 'incorrect_details', 'scam', 'other'] as const

// POST /api/reports  { plateId?, reportedUserId?, reason, details? }
reportsRouter.post('/', async (req, res) => {
  const user = currentUser(req)
  const body = parseBody(
    req,
    z
      .object({
        plateId: z.guid().optional(),
        reportedUserId: z.guid().optional(),
        reason: z.enum(REASONS),
        details: z.string().trim().max(1000).optional(),
      })
      .refine((b) => b.plateId || b.reportedUserId, 'Choose a plate or a user to report'),
  )

  let reportedUserId = body.reportedUserId ?? null
  if (body.plateId) {
    const plate = await queryOne<{ seller_id: string }>('select seller_id from plates where id = $1', [body.plateId])
    if (!plate) throw notFound('Plate not found')
    reportedUserId ??= plate.seller_id
  }
  if (reportedUserId === user.id) throw badRequest('You cannot report yourself')

  const today = await queryOne<{ n: number }>(
    `select count(*)::int as n from reports where reporter_id = $1 and created_at > now() - interval '1 day'`,
    [user.id],
  )
  if (today!.n >= 10) throw tooMany('You have sent too many reports today')

  const report = await queryOne(
    `insert into reports (reporter_id, plate_id, reported_user_id, reason, details)
     values ($1, $2, $3, $4, $5) returning id, status, created_at as "createdAt"`,
    [user.id, body.plateId ?? null, reportedUserId, body.reason, body.details || null],
  )
  res.status(201).json({ report, message: 'Thanks, our team will review this report' })
})

// GET /api/reports/mine
reportsRouter.get('/mine', async (req, res) => {
  const user = currentUser(req)
  const items = await query(
    `select r.id, r.reason, r.details, r.status, r.admin_note as "adminNote", r.created_at as "createdAt",
            r.plate_id as "plateId", p.code as "plateCode"
     from reports r left join plates p on p.id = r.plate_id
     where r.reporter_id = $1 order by r.created_at desc`,
    [user.id],
  )
  res.json({ items })
})
