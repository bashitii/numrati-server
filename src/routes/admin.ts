import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne, transaction } from '../db/pool.js'
import { badRequest, conflict, notFound } from '../lib/errors.js'
import { BUCKETS, supabaseAdmin } from '../lib/supabase.js'
import { currentUser, requireAdmin, requireAuth } from '../middleware/auth.js'
import { parseBody, parseParams, parseQuery } from '../middleware/validate.js'
import { logAdminAction } from '../services/audit.js'
import { notify } from '../services/notifications.js'
import { closeOpenRequests } from '../services/plates.js'
import { signedUrl } from '../services/storage.js'

/** Admin dashboard API. Every change is written to the admin_actions audit log. */
export const adminRouter = Router()
adminRouter.use(requireAuth, requireAdmin)

const uuidParam = z.object({ id: z.guid() })
const numberParam = z.object({ id: z.coerce.number().int() })
const note = z.string().trim().max(500).optional()

// ---------------------------------------------------------------------------
// GET /api/admin/dashboard  Numbers + recent activity
// ---------------------------------------------------------------------------
adminRouter.get('/dashboard', async (_req, res) => {
  const counts = await queryOne(
    `select
       (select count(*)::int from profiles) as users,
       (select count(*)::int from profiles where created_at > now() - interval '7 days') as "newUsersThisWeek",
       (select count(*)::int from verification_requests where status = 'pending') as "pendingVerifications",
       (select count(*)::int from plates where status = 'active') as "activeListings",
       (select count(*)::int from plates where status = 'pending') as "pendingListings",
       (select count(*)::int from plates where status = 'sold') as "soldListings",
       (select count(*)::int from reports where status <> 'closed') as "openReports",
       (select count(*)::int from reports where status = 'new') as "newReports"`,
  )
  const recentActivity = await query(
    `select a.id, a.action, a.target_type as "targetType", a.target_id as "targetId", a.details,
            a.created_at as "createdAt", p.full_name as "adminName"
     from admin_actions a left join profiles p on p.id = a.admin_id
     order by a.created_at desc limit 10`,
  )
  res.json({ ...counts, recentActivity })
})

// GET /api/admin/activity?limit=50  Full audit log
adminRouter.get('/activity', async (req, res) => {
  const { limit } = parseQuery(req, z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }))
  const items = await query(
    `select a.id, a.action, a.target_type as "targetType", a.target_id as "targetId", a.details,
            a.created_at as "createdAt", p.full_name as "adminName"
     from admin_actions a left join profiles p on p.id = a.admin_id
     order by a.created_at desc limit $1`,
    [limit],
  )
  res.json({ items })
})

// ---------------------------------------------------------------------------
// ID verification queue
// ---------------------------------------------------------------------------
adminRouter.get('/verifications', async (req, res) => {
  const { status } = parseQuery(req, z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }))
  const rows = await query(
    `select r.id, r.user_id as "userId", p.full_name as "fullName", p.phone, u.email,
            p.created_at as "registeredAt", r.status, r.admin_note as "adminNote", r.created_at as "submittedAt",
            r.id_front_path, r.id_back_path, r.selfie_path
     from verification_requests r
     join profiles p on p.id = r.user_id
     join auth.users u on u.id = r.user_id
     where r.status = $1
     order by r.created_at ${status === 'pending' ? 'asc' : 'desc'}
     limit 100`,
    [status],
  )
  // Photos are private: send short-lived links instead of storage paths
  const items = await Promise.all(
    rows.map(async ({ id_front_path, id_back_path, selfie_path, ...row }) => ({
      ...row,
      idFrontUrl: await signedUrl(BUCKETS.verification, id_front_path),
      idBackUrl: await signedUrl(BUCKETS.verification, id_back_path),
      selfieUrl: await signedUrl(BUCKETS.verification, selfie_path),
    })),
  )
  res.json({ items })
})

// POST /api/admin/verifications/:id/approve | /reject  { note? }
adminRouter.post('/verifications/:id/:decision', async (req, res) => {
  const admin = currentUser(req)
  const { id, decision } = parseParams(req, numberParam.extend({ decision: z.enum(['approve', 'reject']) }))
  const body = parseBody(req, z.object({ note }))
  const approve = decision === 'approve'

  await transaction(async (db) => {
    const request = await queryOne(
      `update verification_requests
       set status = $2, admin_note = $3, reviewed_by = $4, reviewed_at = now()
       where id = $1 and status = 'pending' returning user_id`,
      [id, approve ? 'approved' : 'rejected', body.note || null, admin.id],
      db,
    )
    if (!request) throw notFound('Request not found or already reviewed')
    await query(
      `update profiles set verification_status = $2, verified_at = case when $3 then now() else null end, updated_at = now()
       where id = $1`,
      [request.user_id, approve ? 'verified' : 'rejected', approve],
      db,
    )
    await notify(request.user_id, approve ? 'verification_approved' : 'verification_rejected', { note: body.note || null }, db)
    await logAdminAction(admin.id, `verification_${decision}`, 'user', request.user_id, { request_id: id, note: body.note }, db)
  })
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
adminRouter.get('/users', async (req, res) => {
  const q = parseQuery(
    req,
    z.object({
      search: z.string().trim().max(80).optional(),
      page: z.coerce.number().int().min(1).default(1),
    }),
  )
  const items = await query(
    `select p.id, p.full_name as "fullName", u.email, p.phone, p.role, p.verification_status as "verificationStatus",
            p.banned_at as "bannedAt", p.ban_reason as "banReason", p.created_at as "createdAt",
            (select count(*)::int from plates x where x.seller_id = p.id and x.status <> 'removed') as listings
     from profiles p join auth.users u on u.id = p.id
     where $1::text is null or p.full_name ilike '%' || $1 || '%' or u.email ilike '%' || $1 || '%' or p.phone like '%' || $1 || '%'
     order by p.created_at desc
     limit 50 offset $2`,
    [q.search || null, (q.page - 1) * 50],
  )
  res.json({ items, page: q.page })
})

// POST /api/admin/users/:id/ban  { reason? }   |   POST /api/admin/users/:id/unban
adminRouter.post('/users/:id/:action', async (req, res) => {
  const admin = currentUser(req)
  const { id, action } = parseParams(req, uuidParam.extend({ action: z.enum(['ban', 'unban']) }))
  const body = parseBody(req, z.object({ reason: note }))
  if (id === admin.id) throw badRequest('You cannot ban yourself')
  const ban = action === 'ban'

  await transaction(async (db) => {
    const target = await queryOne<{ role: string }>('select role from profiles where id = $1', [id], db)
    if (!target) throw notFound('User not found')
    if (target.role === 'admin') throw badRequest('Admins cannot be banned here')
    await query(
      `update profiles set banned_at = case when $2 then now() else null end,
         ban_reason = case when $2 then $3 else null end, updated_at = now()
       where id = $1`,
      [id, ban, body.reason || null],
      db,
    )
    if (ban) await notify(id, 'account_banned', { reason: body.reason || null }, db)
    await logAdminAction(admin.id, `user_${action}`, 'user', id, { reason: body.reason }, db)
  })

  // Also end their current sessions so a banned user is logged out right away
  if (ban) await supabaseAdmin.auth.admin.updateUserById(id, { ban_duration: '876000h' })
  else await supabaseAdmin.auth.admin.updateUserById(id, { ban_duration: 'none' })

  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Listings review
// ---------------------------------------------------------------------------
// GET /api/admin/listings?status=pending  (riskiest first)
adminRouter.get('/listings', async (req, res) => {
  const { status } = parseQuery(
    req,
    z.object({ status: z.enum(['pending', 'active', 'rejected', 'suspended', 'sold', 'removed']).default('pending') }),
  )
  const rows = await query(
    `select p.id, p.code, p.category, p.governorate, p.price, p.estimated_value as "estimatedValue", p.status,
            p.featured, p.views_count as views, p.rejection_reason as "rejectionReason", p.created_at as "createdAt",
            p.seller_id as "sellerId", s.full_name as "sellerName", (s.verification_status = 'verified') as "sellerVerified",
            p.owner_name as "ownerName", p.owner_national_id as "ownerNationalId",
            p.risk_score as "riskScore", p.risk_flags as "riskFlags", p.ownership_doc_path,
            (select count(*)::int from reports r where r.plate_id = p.id and r.status <> 'closed') as "openReports"
     from plates p join profiles s on s.id = p.seller_id
     where p.status = $1
     order by ${status === 'pending' ? 'p.risk_score desc, p.created_at asc' : 'p.created_at desc'}
     limit 100`,
    [status],
  )
  const items = await Promise.all(
    rows.map(async ({ ownership_doc_path, ...row }) => ({
      ...row,
      ownershipDocUrl: await signedUrl(BUCKETS.ownership, ownership_doc_path),
    })),
  )
  res.json({ items })
})

// POST /api/admin/listings/:id/approve | reject | suspend | remove | restore  { reason? }
adminRouter.post('/listings/:id/:action', async (req, res) => {
  const admin = currentUser(req)
  const { id, action } = parseParams(
    req,
    uuidParam.extend({ action: z.enum(['approve', 'reject', 'suspend', 'remove', 'restore', 'feature', 'unfeature']) }),
  )
  const { reason } = parseBody(req, z.object({ reason: note }))

  await transaction(async (db) => {
    const plate = await queryOne('select * from plates where id = $1 for update', [id], db)
    if (!plate) throw notFound('Listing not found')

    // Featured ("premium") flag on a live listing
    if (action === 'feature' || action === 'unfeature') {
      if (plate.status !== 'active') throw badRequest('Only live listings can be featured')
      await query('update plates set featured = $2, updated_at = now() where id = $1', [id, action === 'feature'], db)
      await logAdminAction(admin.id, `listing_${action}`, 'plate', id, { code: plate.code }, db)
      return
    }

    const newStatus = { approve: 'active', restore: 'active', reject: 'rejected', suspend: 'suspended', remove: 'removed' }[action]
    if (action === 'approve' && plate.status !== 'pending') throw badRequest('Only pending listings can be approved')
    if (action === 'restore' && plate.status !== 'suspended') throw badRequest('Only suspended listings can be restored')
    if (newStatus === 'active') {
      const taken = await queryOne(
        `select 1 from plates where code = $1 and status = 'active' and id <> $2`,
        [plate.code, id],
        db,
      )
      if (taken) throw conflict('Another live listing already uses this plate number')
    }

    await query(
      `update plates set
         status = $2::listing_status,
         rejection_reason = case when $2::listing_status = 'active' then null else $3 end,
         published_at = case when $2::listing_status = 'active' then coalesce(published_at, now()) else published_at end,
         featured = case when $2::listing_status = 'active' then featured else false end,
         reviewed_by = $4, reviewed_at = now(), updated_at = now()
       where id = $1`,
      [id, newStatus, reason || null, admin.id],
      db,
    )
    if (newStatus === 'suspended' || newStatus === 'removed') await closeOpenRequests(id, 'closed', db)

    const type = newStatus === 'active' ? 'listing_approved' : newStatus === 'rejected' ? 'listing_rejected' : 'listing_suspended'
    await notify(plate.seller_id, type, { plate_id: id, code: plate.code, reason: reason || null }, db)
    await logAdminAction(admin.id, `listing_${action}`, 'plate', id, { code: plate.code, reason }, db)
  })
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
adminRouter.get('/reports', async (req, res) => {
  const { status } = parseQuery(req, z.object({ status: z.enum(['new', 'review', 'closed', 'open']).default('open') }))
  const items = await query(
    `select r.id, r.reason, r.details, r.status, r.admin_note as "adminNote", r.created_at as "createdAt",
            r.plate_id as "plateId", p.code as "plateCode", p.status as "plateStatus",
            r.reporter_id as "reporterId", rp.full_name as "reporterName",
            r.reported_user_id as "reportedUserId", ru.full_name as "reportedUserName"
     from reports r
     left join plates p on p.id = r.plate_id
     left join profiles rp on rp.id = r.reporter_id
     left join profiles ru on ru.id = r.reported_user_id
     where ${status === 'open' ? `r.status <> 'closed'` : 'r.status = $1'}
     order by r.created_at desc limit 100`,
    status === 'open' ? [] : [status],
  )
  res.json({ items })
})

// PATCH /api/admin/reports/:id  { status: 'review' | 'closed', note? }
adminRouter.patch('/reports/:id', async (req, res) => {
  const admin = currentUser(req)
  const { id } = parseParams(req, numberParam)
  const body = parseBody(req, z.object({ status: z.enum(['new', 'review', 'closed']), note }))

  await transaction(async (db) => {
    const report = await queryOne(
      `update reports set status = $2, admin_note = coalesce($3, admin_note), handled_by = $4, handled_at = now()
       where id = $1 returning reporter_id, plate_id`,
      [id, body.status, body.note || null, admin.id],
      db,
    )
    if (!report) throw notFound('Report not found')
    if (body.status === 'closed' && report.reporter_id) {
      await notify(report.reporter_id, 'report_update', { report_id: id, status: body.status, plate_id: report.plate_id }, db)
    }
    await logAdminAction(admin.id, `report_${body.status}`, 'report', String(id), { note: body.note }, db)
  })
  res.json({ ok: true })
})
