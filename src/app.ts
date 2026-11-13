import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import { clientOrigins } from './config/env.js'
import { pool } from './db/pool.js'
import { errorHandler, notFoundHandler } from './middleware/error.js'
import { adminRouter } from './routes/admin.js'
import { authRouter } from './routes/auth.js'
import { conversationsRouter } from './routes/conversations.js'
import { estimatesRouter } from './routes/estimates.js'
import { meRouter } from './routes/me.js'
import { notificationsRouter } from './routes/notifications.js'
import { platesRouter } from './routes/plates.js'
import { purchaseRequestsRouter } from './routes/purchaseRequests.js'
import { reportsRouter } from './routes/reports.js'
import { usersRouter } from './routes/users.js'
import { verificationRouter } from './routes/verification.js'

export const app = express()

app.set('trust proxy', 1)
app.use(helmet())
app.use(cors({ origin: clientOrigins }))
app.use(express.json({ limit: '100kb' }))

// One line per request: "GET /api/plates 200 12ms"
app.use((req, res, next) => {
  const start = performance.now()
  res.on('finish', () => {
    if (req.path !== '/api/health') console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Math.round(performance.now() - start)}ms`)
  })
  next()
})

// Health check: is the server up and can it reach the database?
app.get('/api/health', async (_req, res) => {
  await pool.query('select 1')
  res.json({ ok: true, database: 'connected' })
})

app.use('/api/auth', authRouter)
app.use('/api/plates', platesRouter)
app.use('/api/users', usersRouter)
app.use('/api/me', meRouter)
app.use('/api/notifications', notificationsRouter)
app.use('/api/conversations', conversationsRouter)
app.use('/api/purchase-requests', purchaseRequestsRouter)
app.use('/api/verification', verificationRouter)
app.use('/api/reports', reportsRouter)
app.use('/api/estimates', estimatesRouter)
app.use('/api/admin', adminRouter)

app.use(notFoundHandler)
app.use(errorHandler)
