export const CATEGORIES = ['special', 'exclusive', 'sequential', 'repeated', 'regular'] as const
export const GOVERNORATES = [
  'amman', 'irbid', 'zarqa', 'aqaba', 'balqa', 'karak', 'madaba', 'mafraq', 'jerash', 'ajloun', 'tafilah', 'maan',
] as const
export type Category = (typeof CATEGORIES)[number]
export type Governorate = (typeof GOVERNORATES)[number]

export const MODEL_VERSION = 'rules-v0'

export interface EstimateInput {
  code: string
  category: Category
  governorate: Governorate
  sequential?: boolean
  repeated?: boolean
  short?: boolean
  specialLetters?: boolean
}

/** Pattern traits the price depends on, read from the plate number itself */
export function detectTraits(code: string) {
  const number = code.split('-')[1] ?? code.replace(/\D/g, '')
  const ascending = number.length > 2 && [...number].every((d, i) => i === 0 || +d === +number[i - 1] + 1)
  return {
    sequential: ascending,
    repeated: number.length > 1 && new Set(number).size <= 2,
    short: number.length > 0 && number.length <= 3,
  }
}

/**
 * Rule-based price estimate (same rules as the design).
 * Swap the body for the trained model later and keep the returned shape.
 */
export function estimatePrice(input: EstimateInput) {
  const detected = detectTraits(input.code)
  const traits = {
    sequential: input.sequential ?? detected.sequential,
    repeated: input.repeated ?? detected.repeated,
    short: input.short ?? detected.short,
    specialLetters: input.specialLetters ?? false,
  }
  const amounts = {
    sequential: traits.sequential ? 2000 : 0,
    repeated: traits.repeated ? 1800 : 0,
    short: traits.short ? 1500 : 0,
    specialLetters: traits.specialLetters ? 800 : 0,
    category: { special: 700, exclusive: 1200, sequential: 400, repeated: 400, regular: 0 }[input.category],
  }
  const base = 5000
  const factors = [
    ...Object.entries(amounts)
      .filter(([, amount]) => amount > 0)
      .map(([key, amount]) => ({ key, amount })),
    { key: 'base', amount: base },
  ]
  const suggested = factors.reduce((sum, f) => sum + f.amount, 0)
  const round = (n: number) => Math.round(n / 100) * 100

  return {
    input: { ...input, ...traits },
    traits,
    suggested,
    low: round(suggested * 0.92),
    high: round(suggested * 1.08),
    confidence: Math.min(96, 72 + factors.length * 4),
    demand: Math.min(95, 35 + factors.length * 8),
    factors,
    modelVersion: MODEL_VERSION,
  }
}
