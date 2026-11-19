import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { env } from '../config/env.js'
import { parseBody } from '../middleware/validate.js'
import { askSanadak } from '../services/sanadak.js'

export const chatRouter = Router()

const messageSchema = z.object({
  role: z.enum(['user', 'model']),
  text: z.string().trim().min(1).max(2000),
})

const chatSchema = z.object({
  // One id per conversation, made by the browser, so the agent remembers the chat
  sessionId: z.string().regex(/^[a-zA-Z0-9-]{8,64}$/, 'Invalid session id'),
  messages: z.array(messageSchema).min(1).max(30),
})

// POST /api/chat  Ask Sanadak (open to guests, limited so nobody can spam it)
chatRouter.post(
  '/',
  rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }),
  async (req, res) => {
    const { sessionId, messages } = parseBody(req, chatSchema)

    const last = messages[messages.length - 1]
    if (last.role !== 'user') {
      res.status(400).json({ error: 'The last message must be from the user' })
      return
    }
    const isNewChat = messages.filter((m) => m.role === 'user').length === 1

    try {
      const answer = await askSanadak(sessionId, last.text, isNewChat)
      res.type('text/plain; charset=utf-8').send(answer || 'Sorry, I could not answer that. Please try again.')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('Sanadak (GCP agent) error:', message)
      // Show the real reason only while developing, never on the live site
      res.status(502).json({
        error: 'The assistant is not available right now',
        details: env.NODE_ENV === 'development' ? message : undefined,
      })
    }
  },
)
