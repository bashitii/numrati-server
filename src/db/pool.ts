import pg from 'pg'
import { env } from '../config/env.js'

// Return bigint counts and numeric values as JS numbers (they are small in this app)
pg.types.setTypeParser(20, (v) => Number(v))
pg.types.setTypeParser(1700, (v) => Number(v))

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(env.DATABASE_URL)

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
  max: 10,
})

export type Db = pg.Pool | pg.PoolClient

/** Run a query and return all rows */
export async function query<T = Record<string, any>>(text: string, params: unknown[] = [], db: Db = pool) {
  const result = await db.query(text, params)
  return result.rows as T[]
}

/** Run a query and return the first row, or null */
export async function queryOne<T = Record<string, any>>(text: string, params: unknown[] = [], db: Db = pool) {
  const rows = await query<T>(text, params, db)
  return rows[0] ?? null
}

/** Run several queries as one all-or-nothing transaction */
export async function transaction<T>(work: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const result = await work(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}
