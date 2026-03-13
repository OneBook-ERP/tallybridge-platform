import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const EnvSchema = z.object({
    PORT: z.string().default('3000').transform(Number),
    HOST: z.string().default('0.0.0.0'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    REDIS_URL: z.string().default('redis://localhost:6379'),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
    ERPNEXT_URL: z.string().url().optional(),
    ERPNEXT_API_KEY: z.string().optional(),
    ERPNEXT_API_SECRET: z.string().optional(),
    ERPNEXT_WEBHOOK_SECRET: z.string().optional(),
})

const parsed = EnvSchema.safeParse(process.env)
if (!parsed.success) {
    console.error('❌  Invalid environment variables:')
    console.error(parsed.error.flatten().fieldErrors)
    process.exit(1)
}

export const env = parsed.data
