import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db/pool.js'
import { notFound } from '../lib/errors.js'
import { parseParams } from '../middleware/validate.js'
import { PLATE_CARD_SELECT, PUBLIC_PLATE_FILTER } from '../services/plates.js'

export const usersRouter = Router()

// GET /api/users/:id  Public seller profile with their live listings
usersRouter.get('/:id', async (req, res) => {
  const { id } = parseParams(req, z.object({ id: z.guid() }))
  const seller = await queryOne(
    `select s.id, s.full_name as name, (s.verification_status = 'verified') as verified, s.created_at as since,
            (select count(*)::int from plates x where x.seller_id = s.id and x.status = 'sold') as sales
     from profiles s where s.id = $1 and s.banned_at is null`,
    [id],
  )
  if (!seller) throw notFound('User not found')
  const listings = await query(
    `${PLATE_CARD_SELECT} where ${PUBLIC_PLATE_FILTER} and p.seller_id = $1 order by (p.status = 'sold'), p.created_at desc`,
    [id],
  )
  res.json({ seller, listings })
})
