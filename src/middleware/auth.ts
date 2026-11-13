import type { NextFunction, Request, Response } from 'express'
import { queryOne } from '../db/pool.js'
import { forbidden, unauthorized } from '../lib/errors.js'
import { supabaseAdmin } from '../lib/supabase.js'

export interface AuthUser {
  id: string
  email: string
  fullName: string
  phone: string | null
  role: 'buyer' | 'seller' | 'admin'
  verificationStatus: 'unverified' | 'pending' | 'verified' | 'rejected'
  bannedAt: string | null
  createdAt: string
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser
    }
  }
}

export const PROFILE_COLUMNS = `
  p.id, p.full_name as "fullName", p.phone, p.role, p.verification_status as "verificationStatus",
  p.banned_at as "bannedAt", p.created_at as "createdAt"`

async function loadUser(req: Request) {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return null

  // Checks the token's signature and expiry. With Supabase's asymmetric signing keys (ES256)
  // this happens locally with a cached public key, so no network call per request.
  // Bans are enforced below through profiles.banned_at.
  const { data, error } = await supabaseAdmin.auth.getClaims(token)
  if (error || !data?.claims?.sub) throw unauthorized('Your session has expired, please sign in again')

  const profile = await queryOne<Omit<AuthUser, 'email'>>(
    `select ${PROFILE_COLUMNS} from profiles p where p.id = $1`,
    [data.claims.sub],
  )
  if (!profile) throw unauthorized('Account profile not found')
  return { ...profile, email: String(data.claims.email ?? '') }
}

/** Signed-in, non-banned users only */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const user = await loadUser(req)
  if (!user) throw unauthorized()
  if (user.bannedAt) throw forbidden('This account is suspended')
  req.user = user
  next()
}

/** Attaches the user when a valid token is sent, but also lets guests through */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const user = await loadUser(req)
    if (user && !user.bannedAt) req.user = user
  } catch {
    // an expired token on a public page just means "guest"
  }
  next()
}

/** Use after requireAuth */
export function requireVerified(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.verificationStatus !== 'verified') throw forbidden('ID verification is required first')
  next()
}

/** Use after requireAuth */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') throw forbidden('Admins only')
  next()
}

/** Helper for handlers that run after requireAuth */
export const currentUser = (req: Request) => {
  if (!req.user) throw unauthorized()
  return req.user
}
