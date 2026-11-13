import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db/pool.js'
import { currentUser, requireAuth } from '../middleware/auth.js'
import { parseBody, parseParams, parseQuery } from '../middleware/validate.js'

export const notificationsRouter = Router()
notificationsRouter.use(requireAuth)

// GET /api/notifications?limit=30&before=<id>
notificationsRouter.get('/', async (req, res) => {
  const user = currentUser(req)
  const q = parseQuery(req, z.object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    before: z.coerce.number().int().optional(),
  }))
  const items = await query(
    `select id, type, data, (read_at is null) as unread, created_at as "createdAt"
     from notifications
     where user_id = $1 and ($2::bigint is null or id < $2)
     order by created_at desc, id desc limit $3`,
    [user.id, q.before ?? null, q.limit],
  )
  const unread = await queryOne<{ n: number }>(
    'select count(*)::int as n from notifications where user_id = $1 and read_at is null',
    [user.id],
  )
  res.json({ items, unreadCount: unread!.n })
})

// POST /api/notifications/read  { ids?: number[] }  (no ids = mark all as read)
notificationsRouter.post('/read', async (req, res) => {
  const user = currentUser(req)
  const { ids } = parseBody(req, z.object({ ids: z.array(z.number().int()).max(200).optional() }))
  await query(
    `update notifications set read_at = now()
     where user_id = $1 and read_at is null and ($2::bigint[] is null or id = any($2))`,
    [user.id, ids ?? null],
  )
  res.json({ ok: true })
})

// DELETE /api/notifications/:id
notificationsRouter.delete('/:id', async (req, res) => {
  const user = currentUser(req)
  const { id } = parseParams(req, z.object({ id: z.coerce.number().int() }))
  await query('delete from notifications where id = $1 and user_id = $2', [id, user.id])
  res.json({ ok: true })
})
