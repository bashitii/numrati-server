import { type Db, pool, queryOne } from '../db/pool.js'
import type { Category } from './estimate.js'

/**
 * How suspicious a listing looks (0-100). Admins see the score and flags in the review queue,
 * so fake "too cheap to be true" listings stand out.
 */
export async function computeListingRisk(
  input: { sellerId: string; code: string; category: Category; price: number; estimate: number | null; excludePlateId?: string },
  db: Db = pool,
) {
  const digits = input.code.split('-')[1]?.length ?? 0
  const exclude = input.excludePlateId ?? null
  let score = 5
  const flags: string[] = []

  // Market median for the same category and number length, falling back to the whole category.
  // Needs at least 3 similar listings, otherwise one odd plate would skew the "market price".
  let median = (
    await queryOne<{ median: number | null }>(
      `select case when count(*) >= 3 then percentile_cont(0.5) within group (order by price) end as median
       from plates
       where category = $1 and status in ('active', 'sold')
         and char_length(split_part(code, '-', 2)) = $2
         and id is distinct from $3`,
      [input.category, digits, exclude],
      db,
    )
  )?.median
  if (median == null) {
    median = (
      await queryOne<{ median: number | null }>(
        `select case when count(*) >= 3 then percentile_cont(0.5) within group (order by price) end as median
         from plates where category = $1 and status in ('active', 'sold') and id is distinct from $2`,
        [input.category, exclude],
        db,
      )
    )?.median
  }

  if (median != null) {
    if (input.price < median * 0.3) {
      score += 55
      flags.push('price_far_below_market')
    } else if (input.price < median * 0.5) {
      score += 30
      flags.push('price_below_market')
    } else if (input.price > median * 4) {
      score += 15
      flags.push('price_far_above_market')
    }
  }

  if (input.estimate != null && input.price < input.estimate * 0.5) {
    score += 20
    flags.push('price_below_estimate')
  }

  const seller = await queryOne<{ newAccount: boolean; recentRejections: number; codeRejectedElsewhere: boolean }>(
    `select
       (p.created_at > now() - interval '7 days') as "newAccount",
       (select count(*)::int from plates x
         where x.seller_id = p.id and x.status in ('rejected', 'suspended') and x.updated_at > now() - interval '30 days') as "recentRejections",
       exists (select 1 from plates x
         where x.code = $2 and x.seller_id <> p.id and x.status in ('rejected', 'suspended', 'removed')) as "codeRejectedElsewhere"
     from profiles p where p.id = $1`,
    [input.sellerId, input.code],
    db,
  )
  if (seller?.newAccount) {
    score += 15
    flags.push('new_account')
  }
  if ((seller?.recentRejections ?? 0) >= 2) {
    score += 15
    flags.push('recent_rejections')
  }
  if (seller?.codeRejectedElsewhere) {
    score += 10
    flags.push('code_listed_by_another_seller')
  }

  return { score: Math.min(score, 100), flags }
}
