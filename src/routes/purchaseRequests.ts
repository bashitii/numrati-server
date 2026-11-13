import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne, transaction } from '../db/pool.js'
import { notFound } from '../lib/errors.js'
import { currentUser, requireAuth } from '../middleware/auth.js'
import { parseParams, parseQuery } from '../middleware/validate.js'
import { notify } from '../services/notifications.js'

/**
 * Purchase requests ("Send Purchase Request"). The real ownership transfer happens at the
 * DVLD; this records the offer and connects the buyer and seller.
 * Created with POST /api/plates/:id/purchase-requests.
 */
export const purchaseRequestsRouter = Router()
purchaseRequestsRouter.use(requireAuth)

const idParam = z.object({ id: z.guid() })

// GET /api/purchase-requests?as=seller|buyer
purchaseRequestsRouter.get('/', async (req, res) => {
  const user = currentUser(req)
  const { as } = parseQuery(req, z.object({ as: z.enum(['seller', 'buyer']).default('seller') }))
  const items = await query(
    `select r.id, r.plate_id as "plateId", p.code as "plateCode", p.price as "platePrice",
            r.offered_price as "offeredPrice", r.message, r.status, r.conversation_id as "conversationId",
            r.created_at as "createdAt", r.responded_at as "respondedAt",
            o.id as "otherId", o.full_name as "otherName", (o.verification_status = 'verified') as "otherVerified"
     from purchase_requests r
     join plates p on p.id = r.plate_id
     join profiles o on o.id = ${as === 'seller' ? 'r.buyer_id' : 'r.seller_id'}
     where ${as === 'seller' ? 'r.seller_id' : 'r.buyer_id'} = $1
     order by r.created_at desc`,
    [user.id],
  )
  res.json({ items })
})

// Seller accepts or declines
async function respond(requestId: string, sellerId: string, accept: boolean) {
  await transaction(async (db) => {
    const request = await queryOne(
      `update purchase_requests set status = $3, responded_at = now()
       where id = $1 and seller_id = $2 and status = 'pending'
       returning *`,
      [requestId, sellerId, accept ? 'accepted' : 'declined'],
      db,
    )
    if (!request) throw notFound('Request not found')
    const plate = await queryOne<{ code: string }>('select code from plates where id = $1', [request.plate_id], db)
    await notify(
      request.buyer_id,
      'purchase_update',
      { request_id: request.id, plate_id: request.plate_id, code: plate?.code, status: request.status, conversation_id: request.conversation_id },
      db,
    )
  })
}

purchaseRequestsRouter.post('/:id/accept', async (req, res) => {
  const { id } = parseParams(req, idParam)
  await respond(id, currentUser(req).id, true)
  res.json({ status: 'accepted' })
})

purchaseRequestsRouter.post('/:id/decline', async (req, res) => {
  const { id } = parseParams(req, idParam)
  await respond(id, currentUser(req).id, false)
  res.json({ status: 'declined' })
})

// Buyer cancels their own request
purchaseRequestsRouter.post('/:id/cancel', async (req, res) => {
  const user = currentUser(req)
  const { id } = parseParams(req, idParam)
  const updated = await query(
    `update purchase_requests set status = 'cancelled', responded_at = now()
     where id = $1 and buyer_id = $2 and status = 'pending' returning id`,
    [id, user.id],
  )
  if (!updated.length) throw notFound('Request not found')
  res.json({ status: 'cancelled' })
})
