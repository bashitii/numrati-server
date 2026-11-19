import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().default(4000),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  // Sanadak, the GCP Conversational Agents agent (see src/services/sanadak.ts)
  GCP_PROJECT_ID: z.string().default('midyear-diorama-514913-a7'),
  GCP_LOCATION: z.string().default('global'),
  GCP_AGENT_ID: z.string().default('af82b14f-132c-45e3-801b-a8f5ad6b18ce'),
  GCP_PLAYBOOK_ID: z.string().default('00000000-0000-0000-0000-000000000000'),
  GCP_LANGUAGE: z.string().default('en'),
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
