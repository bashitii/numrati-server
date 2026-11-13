import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db/pool.js'
import { currentUser, requireAuth } from '../middleware/auth.js'
import { parseQuery } from '../middleware/validate.js'
import { PLATE_CARD_SELECT, PUBLIC_PLATE_FILTER } from '../services/plates.js'

/** Everything under /api/me belongs to the signed-in user */
export const meRouter = Router()
meRouter.use(requireAuth)

// GET /api/me/listings  All my listings in every status (with the rejection reason)
meRouter.get('/listings', async (req, res) => {
  const user = currentUser(req)
  const rows = await query(
    `${PLATE_CARD_SELECT.replace('select', `select p.rejection_reason as "rejectionReason",
       (select count(*)::int from purchase_requests r where r.plate_id = p.id and r.status = 'pending') as "pendingRequests",`)}
     where p.seller_id = $1 and p.status <> 'removed'
     order by p.created_at desc`,
    [user.id],
  )
  res.json({ items: rows })
})

// GET /api/me/favorites
meRouter.get('/favorites', async (req, res) => {
  const user = currentUser(req)
  const rows = await query(
    `${PLATE_CARD_SELECT}
     join favorites f on f.plate_id = p.id and f.user_id = $1
     where ${PUBLIC_PLATE_FILTER}
     order by f.created_at desc`,
    [user.id],
  )
  res.json({ items: rows })
})

// GET /api/me/analytics?days=30  Seller "Sales Analytics" screen
meRouter.get('/analytics', async (req, res) => {
  const user = currentUser(req)
  const { days } = parseQuery(req, z.object({ days: z.coerce.number().int().min(1).max(366).default(30) }))

  const totals = await queryOne(
    `with mine as (select id from plates where seller_id = $1),
          range as (select current_date - ($2::int - 1) as start)
     select
       (select count(*)::int from plate_views v, range where v.plate_id in (select id from mine) and v.viewed_on >= range.start) as views,
       (select count(*)::int from plate_views v, range where v.plate_id in (select id from mine)
          and v.viewed_on >= range.start - $2::int and v.viewed_on < range.start) as "viewsPrevious",
       (select count(*)::int from favorites f, range where f.plate_id in (select id from mine) and f.created_at::date >= range.start) as interested,
       (select count(*)::int from purchase_requests r, range where r.seller_id = $1 and r.created_at::date >= range.start) as requests,
       (select count(*)::int from plates where seller_id = $1 and status = 'sold') as sold`,
    [user.id, days],
  )

  const series = await query(
    `select d::date as day, coalesce(c.views, 0)::int as views
     from generate_series(current_date - ($2::int - 1), current_date, interval '1 day') as d
     left join (
       select v.viewed_on, count(*) as views from plate_views v
       join plates p on p.id = v.plate_id
       where p.seller_id = $1 and v.viewed_on >= current_date - ($2::int - 1)
       group by v.viewed_on
     ) c on c.viewed_on = d::date
     order by d`,
    [user.id, days],
  )

  const listings = await query(
    `select p.id, p.code, p.price, p.status, p.views_count as views, p.favorites_count as interested,
            (select count(*)::int from purchase_requests r where r.plate_id = p.id) as requests
     from plates p
     where p.seller_id = $1 and p.status <> 'removed'
     order by p.views_count desc`,
    [user.id],
  )

  res.json({ days, ...totals, series, listings })
})
