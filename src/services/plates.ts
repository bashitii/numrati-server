import { type Db, pool, query } from '../db/pool.js'

/**
 * Public listing card. Field names match the React app's `Plate` type.
 * Private fields (owner name, national ID, risk score) are never selected here.
 */
export const PLATE_CARD_SELECT = `
  select
    p.id, p.code, p.price, p.estimated_value as "marketValue", p.category, p.governorate,
    (s.verification_status = 'verified') as verified,
    p.featured as premium,
    p.views_count as views,
    p.favorites_count as interested,
    coalesce(round(100.0 * (p.price - w.old_price) / nullif(w.old_price, 0), 1), 0)::float8 as "weeklyChange",
    (p.status = 'sold') as sold,
    p.status,
    p.seller_id as "sellerId",
    s.full_name as "sellerName",
    p.published_at as "publishedAt",
    p.created_at as "createdAt"
  from plates p
  join profiles s on s.id = p.seller_id
  left join lateral (
    select h.old_price from price_history h
    where h.plate_id = p.id and h.changed_at >= now() - interval '7 days'
    order by h.changed_at limit 1
  ) w on true`

/** Public listings are live or sold, from sellers who are not banned */
export const PUBLIC_PLATE_FILTER = `p.status in ('active', 'sold') and s.banned_at is null`

/** When a plate is sold or taken down, its open purchase requests are closed */
export async function closeOpenRequests(plateId: string, reason: 'sold' | 'closed', db: Db = pool) {
  await query(
    `update purchase_requests set status = $2, responded_at = now()
     where plate_id = $1 and status = 'pending'`,
    [plateId, reason === 'sold' ? 'declined' : 'cancelled'],
    db,
  )
}
