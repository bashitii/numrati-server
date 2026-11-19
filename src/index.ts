import { app } from './app.js'
import { env } from './config/env.js'
import { pool } from './db/pool.js'

const server = app.listen(env.PORT, () => {
  console.log(`Numrati API running on http://localhost:${env.PORT}/api`)
})

async function shutdown() {
  server.close()
  await pool.end()
  process.exit(0)
}
// If a background task fails (e.g. Google Cloud sign-in is missing), log it instead of stopping the whole server
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled error:', reason instanceof Error ? reason.message : reason)
})

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
