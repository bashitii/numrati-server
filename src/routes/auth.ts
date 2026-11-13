import type { Session, User } from '@supabase/supabase-js'
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { query, queryOne } from '../db/pool.js'
import { badRequest, forbidden, unauthorized } from '../lib/errors.js'
import { supabaseAdmin, supabaseAuth } from '../lib/supabase.js'
import { currentUser, PROFILE_COLUMNS, requireAuth } from '../middleware/auth.js'
import { parseBody } from '../middleware/validate.js'

export const authRouter = Router()

// Slows down password guessing
authRouter.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }))

const phone = z
  .string()
  .transform((v) => v.replace(/[^0-9+]/g, ''))
  .pipe(z.string().regex(/^\+?[0-9]{8,15}$/, 'Invalid phone number'))
const fullName = z.string().trim().min(2).max(80)

/** Creates the profile row the first time we see a user (role can only be buyer or seller) */
async function ensureProfile(user: User) {
  const meta = user.user_metadata ?? {}
  const name = String(meta.full_name ?? user.email?.split('@')[0] ?? '').trim()
  const role = meta.role === 'seller' ? 'seller' : 'buyer'
  const phoneValue = typeof meta.phone === 'string' && /^\+?[0-9]{8,15}$/.test(meta.phone) ? meta.phone : null
  // "from auth.users" makes sure the account really exists before we attach a profile to it
  await query(
    `insert into profiles (id, full_name, role, phone)
     select id, $2, $3, $4 from auth.users where id = $1
     on conflict (id) do nothing`,
    [user.id, name.length >= 2 ? name.slice(0, 80) : 'Numrati user', role, phoneValue],
  )
}

async function getProfile(userId: string) {
  return queryOne(`select ${PROFILE_COLUMNS} from profiles p where p.id = $1`, [userId])
}

function sessionResponse(session: Session) {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at,
  }
}

async function signedInResponse(session: Session) {
  await ensureProfile(session.user)
  const profile = await getProfile(session.user.id)
  if (profile?.bannedAt) throw forbidden('This account is suspended')
  return { session: sessionResponse(session), user: { ...profile, email: session.user.email } }
}

// POST /api/auth/register
authRouter.post('/register', async (req, res) => {
  const body = parseBody(
    req,
    z.object({
      fullName,
      email: z.string().trim().toLowerCase().email(),
      password: z.string().min(8, 'Password must be at least 8 characters').max(72),
      phone: phone.optional(),
      role: z.enum(['buyer', 'seller']).default('buyer'),
    }),
  )

  const { data, error } = await supabaseAuth().auth.signUp({
    email: body.email,
    password: body.password,
    options: { data: { full_name: body.fullName, phone: body.phone, role: body.role } },
  })
  if (error) throw badRequest(error.message)
  if (data.user) await ensureProfile(data.user)

  // With email confirmation on, there is no session yet: the user must enter the emailed code
  if (!data.session) {
    res.status(201).json({ needsEmailConfirmation: true, email: body.email })
    return
  }
  res.status(201).json(await signedInResponse(data.session))
})

// POST /api/auth/verify-email  { email, code }  (the 6-digit code from the confirmation email)
authRouter.post('/verify-email', async (req, res) => {
  const body = parseBody(req, z.object({ email: z.string().trim().toLowerCase().email(), code: z.string().trim().min(6).max(10) }))
  const { data, error } = await supabaseAuth().auth.verifyOtp({ email: body.email, token: body.code, type: 'email' })
  if (error || !data.session) throw badRequest(error?.message ?? 'Invalid or expired code')
  res.json(await signedInResponse(data.session))
})

// POST /api/auth/resend-code  { email }
authRouter.post('/resend-code', async (req, res) => {
  const body = parseBody(req, z.object({ email: z.string().trim().toLowerCase().email() }))
  const { error } = await supabaseAuth().auth.resend({ type: 'signup', email: body.email })
  if (error) throw badRequest(error.message)
  res.json({ ok: true })
})

// POST /api/auth/login  { email, password }
authRouter.post('/login', async (req, res) => {
  const body = parseBody(req, z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) }))
  const { data, error } = await supabaseAuth().auth.signInWithPassword(body)
  if (error || !data.session) {
    if (error?.code === 'email_not_confirmed') throw forbidden('Please confirm your email first')
    if (error?.code === 'user_banned') throw forbidden('This account is suspended')
    throw unauthorized('Wrong email or password')
  }
  res.json(await signedInResponse(data.session))
})

// POST /api/auth/refresh  { refreshToken }  -> new access token when the old one expires (1 hour)
authRouter.post('/refresh', async (req, res) => {
  const body = parseBody(req, z.object({ refreshToken: z.string().min(1) }))
  const { data, error } = await supabaseAuth().auth.refreshSession({ refresh_token: body.refreshToken })
  if (error || !data.session) throw unauthorized('Session expired, please sign in again')
  res.json(await signedInResponse(data.session))
})

// POST /api/auth/forgot-password  { email }
authRouter.post('/forgot-password', async (req, res) => {
  const body = parseBody(req, z.object({ email: z.string().trim().toLowerCase().email() }))
  await supabaseAuth().auth.resetPasswordForEmail(body.email)
  res.json({ ok: true }) // same answer either way, so emails cannot be probed
})

// POST /api/auth/logout
authRouter.post('/logout', requireAuth, async (req, res) => {
  const token = req.headers.authorization!.slice(7)
  await supabaseAdmin.auth.admin.signOut(token)
  res.json({ ok: true })
})

// GET /api/auth/me
authRouter.get('/me', requireAuth, async (req, res) => {
  const user = currentUser(req)
  const stats = await queryOne(
    `select
       (select count(*)::int from plates where seller_id = $1 and status = 'sold') as sales,
       (select count(*)::int from plates where seller_id = $1 and status in ('pending', 'active')) as listings,
       (select count(*)::int from favorites where user_id = $1) as favorites,
       (select count(*)::int from notifications where user_id = $1 and read_at is null) as "unreadNotifications"`,
    [user.id],
  )
  res.json({ user, stats })
})

// PATCH /api/auth/me  { fullName?, phone? }
authRouter.patch('/me', requireAuth, async (req, res) => {
  const user = currentUser(req)
  const body = parseBody(req, z.object({ fullName: fullName.optional(), phone: phone.nullable().optional() }))
  await query(
    `update profiles set
       full_name = coalesce($2, full_name),
       phone = case when $3 then $4 else phone end,
       updated_at = now()
     where id = $1`,
    [user.id, body.fullName ?? null, body.phone !== undefined, body.phone ?? null],
  )
  res.json({ user: { ...(await getProfile(user.id)), email: user.email } })
})

// POST /api/auth/change-password  { password }
authRouter.post('/change-password', requireAuth, async (req, res) => {
  const user = currentUser(req)
  const body = parseBody(req, z.object({ password: z.string().min(8).max(72) }))
  const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, { password: body.password })
  if (error) throw badRequest(error.message)
  res.json({ ok: true })
})
