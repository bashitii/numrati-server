import { createClient } from '@supabase/supabase-js'
import { env } from '../config/env.js'

const options = { auth: { persistSession: false, autoRefreshToken: false } }

/** Service-role client: checks tokens, manages users, reads and writes private files. Server only. */
export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, options)

/**
 * A fresh client for sign-up / sign-in calls. A new one per request, because signing in
 * stores that user's session on the client and we never want sessions shared between requests.
 */
export const supabaseAuth = () => createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, options)

export const BUCKETS = {
  verification: 'verification-docs',
  ownership: 'ownership-docs',
} as const
