import { type Db, pool, query } from '../db/pool.js'

/** Admin audit log ("Monitor system activity") */
export async function logAdminAction(
  adminId: string,
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown> = {},
  db: Db = pool,
) {
  await query(
    'insert into admin_actions (admin_id, action, target_type, target_id, details) values ($1, $2, $3, $4, $5)',
    [adminId, action, targetType, targetId, details],
    db,
  )
}
