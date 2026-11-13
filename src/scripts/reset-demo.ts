/**
 * Puts the demo back to a clean state:  npm run reset-demo
 * Removes ONLY the six @numrati.test demo accounts, everything they created (listings, chats,
 * requests, reports, notifications) and their uploaded files. Real accounts are not touched.
 * `npm run reset-demo` then runs the seed again.
 */
import { pool, query } from '../db/pool.js'
import { BUCKETS, supabaseAdmin } from '../lib/supabase.js'

const demoUsers = await query<{ id: string; email: string }>(
  `select id, email from auth.users where email like '%@numrati.test'`,
)
console.log(`Removing ${demoUsers.length} demo accounts and their data...`)

// Uploaded files live in "<user id>/..." folders
for (const bucket of Object.values(BUCKETS)) {
  for (const user of demoUsers) {
    const { data } = await supabaseAdmin.storage.from(bucket).list(user.id, { limit: 1000 })
    const paths = (data ?? []).map((file) => `${user.id}/${file.name}`)
    if (paths.length) await supabaseAdmin.storage.from(bucket).remove(paths)
  }
}

// Deleting the login also deletes the profile, and through it every row that belongs to it
for (const user of demoUsers) {
  const { error } = await supabaseAdmin.auth.admin.deleteUser(user.id)
  if (error) throw new Error(`Could not delete ${user.email}: ${error.message}`)
}

// Audit log entries made by the demo admin are kept with an empty admin; clear them too
await query('delete from admin_actions where admin_id is null')

await pool.end()
console.log('Demo data removed.')
