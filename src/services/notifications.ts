import { type Db, pool, query } from '../db/pool.js'

export type NotificationType =
  | 'message' | 'favorite' | 'price_change' | 'purchase_request' | 'purchase_update'
  | 'listing_approved' | 'listing_rejected' | 'listing_suspended'
  | 'verification_approved' | 'verification_rejected' | 'report_update' | 'account_banned'

/** Store a notification. The client turns `type` + `data` into Arabic or English text. */
export async function notify(userId: string, type: NotificationType, data: Record<string, unknown> = {}, db: Db = pool) {
  await query('insert into notifications (user_id, type, data) values ($1, $2, $3)', [userId, type, data], db)
}
