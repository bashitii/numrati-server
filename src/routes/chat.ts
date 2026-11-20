import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { env } from '../config/env.js'
import { currentUser, optionalAuth, requireAuth } from '../middleware/auth.js'
import { parseBody, parseParams } from '../middleware/validate.js'
import { deleteChat, getChat, isSomeoneElsesChat, listChats, saveExchange } from '../services/assistantHistory.js'
import { streamSanadak } from '../services/sanadak.js'

export const chatRouter = Router()

const chatSchema = z.object({
  // One id per conversation, made by the browser. For signed-in users it is the id of the saved chat.
  sessionId: z.guid('Invalid session id'),
  question: z.string().trim().min(1).max(2000),
  // The chat so far (the last few messages), so Sanadak remembers what was said
  history: z
    .array(z.object({ role: z.enum(['user', 'model']), text: z.string().trim().min(1).max(4000) }))
    .max(12)
    .default([]),
})

// POST /api/chat  Ask Sanadak (open to guests; chats of signed-in users are saved).
// The reply is plain text that is sent in pieces while Gemini writes it.
chatRouter.post(
  '/',
  rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }),
  optionalAuth,
  async (req, res) => {
    const { sessionId, question, history } = parseBody(req, chatSchema)
    const userId = req.user?.id ?? null

    // Nobody can continue another user's saved chat
    if (await isSomeoneElsesChat(sessionId, userId)) {
      res.status(403).json({ error: 'This chat belongs to another account' })
      return
    }

    let started = false
    const write = (text: string) => {
      if (!started) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('X-Accel-Buffering', 'no') // ask proxies to pass each piece on straight away
        started = true
      }
      res.write(text)
    }

    let answer = ''
    try {
      answer = await streamSanadak(history, question, write)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('Sanadak (Gemini) error:', message)
      if (!started) {
        // Show the real reason only while developing, never on the live site
        res.status(502).json({
          error: 'The assistant is not available right now',
          details: env.NODE_ENV === 'development' ? message : undefined,
        })
        return
      }
    }

    if (!answer && !started) write('Sorry, I could not answer that. Please try again.')

    // Save the question and the answer for signed-in users. A failure here never hides the answer.
    // (Saved before the reply ends, so the history list is up to date when the page reloads it.)
    if (userId && answer) {
      try {
        await saveExchange(sessionId, userId, question, answer)
      } catch (err) {
        console.error('Could not save Sanadak chat:', err instanceof Error ? err.message : err)
      }
    }
    res.end()
  },
)

const idParam = z.object({ id: z.guid() })

// GET /api/chat/history  My saved Sanadak chats, newest first
chatRouter.get('/history', requireAuth, async (req, res) => {
  res.json({ items: await listChats(currentUser(req).id) })
})

// GET /api/chat/history/:id  One saved chat with all its messages
chatRouter.get('/history/:id', requireAuth, async (req, res) => {
  const { id } = parseParams(req, idParam)
  res.json(await getChat(id, currentUser(req).id))
})

// DELETE /api/chat/history/:id
chatRouter.delete('/history/:id', requireAuth, async (req, res) => {
  const { id } = parseParams(req, idParam)
  await deleteChat(id, currentUser(req).id)
  res.status(204).end()
})
