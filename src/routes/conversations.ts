import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne, transaction } from '../db/pool.js'
import { notFound, tooMany } from '../lib/errors.js'
import { currentUser, requireAuth } from '../middleware/auth.js'
import { parseBody, parseParams, parseQuery } from '../middleware/validate.js'
import { notify } from '../services/notifications.js'

/** Chat between a buyer and the seller of one plate. Only the two people in it can read it. */
export const conversationsRouter = Router()
conversationsRouter.use(requireAuth)

const idParam = z.object({ id: z.guid() })

async function getMyConversation(id: string, userId: string) {
  const conversation = await queryOne(
    'select * from conversations where id = $1 and $2 in (buyer_id, seller_id)',
    [id, userId],
  )
  if (!conversation) throw notFound('Conversation not found')
  return conversation
}

// GET /api/conversations  My chat list with the other person, the plate and unread count
conversationsRouter.get('/', async (req, res) => {
  const user = currentUser(req)
  const items = await query(
    `select
       c.id, c.plate_id as "plateId", p.code as "plateCode", p.price as "platePrice", p.status as "plateStatus",
       case when c.buyer_id = $1 then 'buyer' else 'seller' end as "myRole",
       o.id as "otherId", o.full_name as "otherName", (o.verification_status = 'verified') as "otherVerified",
       c.last_message as "lastMessage", c.last_message_at as "lastMessageAt", c.created_at as "createdAt",
       (select count(*)::int from messages m
         where m.conversation_id = c.id and m.sender_id <> $1
           and m.created_at > case when c.buyer_id = $1 then c.buyer_last_read_at else c.seller_last_read_at end
       ) as unread
     from conversations c
     join plates p on p.id = c.plate_id
     join profiles o on o.id = case when c.buyer_id = $1 then c.seller_id else c.buyer_id end
     where $1 in (c.buyer_id, c.seller_id)
     order by coalesce(c.last_message_at, c.created_at) desc`,
    [user.id],
  )
  res.json({ items })
})

// GET /api/conversations/:id/messages?after=<messageId>
// The chat screen can poll this with `after` set to the last message id it has.
conversationsRouter.get('/:id/messages', async (req, res) => {
  const user = currentUser(req)
  const { id } = parseParams(req, idParam)
  const { after } = parseQuery(req, z.object({ after: z.coerce.number().int().optional() }))
  await getMyConversation(id, user.id)

  const items = await query(
    `select id, sender_id as "senderId", (sender_id = $2) as mine, body, created_at as "createdAt"
     from messages
     where conversation_id = $1 and ($3::bigint is null or id > $3)
     order by id
     limit 500`,
    [id, user.id, after ?? null],
  )
  res.json({ items })
})

// POST /api/conversations/:id/messages  { body }
conversationsRouter.post('/:id/messages', async (req, res) => {
  const user = currentUser(req)
  const { id } = parseParams(req, idParam)
  const { body } = parseBody(req, z.object({ body: z.string().trim().min(1).max(2000) }))
  const conversation = await getMyConversation(id, user.id)

  // Spam guard: at most 20 messages a minute
  const recent = await queryOne<{ n: number }>(
    `select count(*)::int as n from messages where sender_id = $1 and created_at > now() - interval '1 minute'`,
    [user.id],
  )
  if (recent!.n >= 20) throw tooMany('You are sending messages too quickly')

  const message = await transaction(async (db) => {
    const row = await queryOne(
      `insert into messages (conversation_id, sender_id, body) values ($1, $2, $3)
       returning id, sender_id as "senderId", true as mine, body, created_at as "createdAt"`,
      [id, user.id, body],
      db,
    )
    const iAmBuyer = conversation.buyer_id === user.id
    await query(
      `update conversations set last_message = left($2, 140), last_message_at = now(),
         ${iAmBuyer ? 'buyer_last_read_at' : 'seller_last_read_at'} = now()
       where id = $1`,
      [id, body],
      db,
    )

    // Notify the other person, but only once until they read it
    const recipient = iAmBuyer ? conversation.seller_id : conversation.buyer_id
    const alreadyNotified = await queryOne(
      `select 1 from notifications
       where user_id = $1 and type = 'message' and read_at is null and data ->> 'conversation_id' = $2`,
      [recipient, id],
      db,
    )
    if (!alreadyNotified) {
      await notify(
        recipient,
        'message',
        { conversation_id: id, plate_id: conversation.plate_id, sender_name: user.fullName, preview: body.slice(0, 100) },
        db,
      )
    }
    return row
  })

  res.status(201).json({ message })
})

// POST /api/conversations/:id/read
conversationsRouter.post('/:id/read', async (req, res) => {
  const user = currentUser(req)
  const { id } = parseParams(req, idParam)
  const conversation = await getMyConversation(id, user.id)
  const column = conversation.buyer_id === user.id ? 'buyer_last_read_at' : 'seller_last_read_at'
  await query(`update conversations set ${column} = now() where id = $1`, [id])
  await query(
    `update notifications set read_at = now()
     where user_id = $1 and type = 'message' and read_at is null and data ->> 'conversation_id' = $2`,
    [user.id, id],
  )
  res.json({ ok: true })
})
