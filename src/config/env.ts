import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().default(4000),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  // Sanadak runs on Gemini in Vertex AI and searches our knowledge base (see src/services/sanadak.ts)
  GCP_PROJECT_ID: z.string().default('midyear-diorama-514913-a7'),
  GCP_LOCATION: z.string().default('global'),
  GCP_DATASTORE_ID: z.string().default('numrati-knowledge-base_1794863661808'),
  GEMINI_MODEL: z.string().default('gemini-3.5-flash'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('Missing or invalid settings in .env (see .env.example):')
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`)
  process.exit(1)
}

export const env = parsed.data
export const clientOrigins = env.CLIENT_ORIGIN.split(',').map((o) => o.trim())
