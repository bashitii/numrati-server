import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db/pool.js'
import { currentUser, requireAuth } from '../middleware/auth.js'
import { parseBody } from '../middleware/validate.js'
import { CATEGORIES, detectTraits, estimatePrice, GOVERNORATES } from '../services/estimate.js'

export const estimatesRouter = Router()

const inputSchema = z.object({
  code: z.string().trim().regex(/^[0-9]{1,2}-[0-9]{1,5}$/, 'Plate number must look like 12-34567'),
  category: z.enum(CATEGORIES),
  governorate: z.enum(GOVERNORATES),
  sequential: z.boolean().optional(),
  repeated: z.boolean().optional(),
  short: z.boolean().optional(),
  specialLetters: z.boolean().optional(),
})

// GET /api/estimates/traits?code=12-345  Auto-detect patterns while the user types
estimatesRouter.get('/traits', (req, res) => {
  res.json(detectTraits(String(req.query.code ?? '')))
})

// POST /api/estimates  Get a price estimate (open to guests)
estimatesRouter.post('/', (req, res) => {
  res.json(estimatePrice(parseBody(req, inputSchema)))
})

// POST /api/estimates/saved  "Save Report" (recomputed here, never trusted from the browser)
estimatesRouter.post('/saved', requireAuth, async (req, res) => {
  const user = currentUser(req)
  const result = estimatePrice(parseBody(req, inputSchema))
  const saved = await queryOne(
    `insert into price_estimates (user_id, code, category, governorate, traits, low, high, suggested, confidence, factors, model_version)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning id, created_at as "createdAt"`,
    [user.id, result.input.code, result.input.category, result.input.governorate, result.traits,
     result.low, result.high, result.suggested, result.confidence, JSON.stringify(result.factors), result.modelVersion],
  )
  res.status(201).json({ ...saved, ...result })
})

// GET /api/estimates/saved
estimatesRouter.get('/saved', requireAuth, async (req, res) => {
  const user = currentUser(req)
  const items = await query(
    `select id, code, category, governorate, traits, low, high, suggested, confidence, factors,
            model_version as "modelVersion", created_at as "createdAt"
     from price_estimates where user_id = $1 order by created_at desc limit 50`,
    [user.id],
  )
  res.json({ items })
})

// DELETE /api/estimates/saved/:id
estimatesRouter.delete('/saved/:id', requireAuth, async (req, res) => {
  await query('delete from price_estimates where id = $1 and user_id = $2', [Number(req.params.id) || 0, currentUser(req).id])
  res.json({ ok: true })
})
