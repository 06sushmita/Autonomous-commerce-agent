import { neon } from '@neondatabase/serverless';
import { drizzle, NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as dotenv from 'dotenv';
import * as schema from './schema.js';

// Load environment variables from .env.local and .env
dotenv.config({ path: '.env.local' });
dotenv.config();

let dbInstance: NeonHttpDatabase<typeof schema> | null = null;

/**
 * Checks if a live, non-placeholder DATABASE_URL is configured.
 */
export function isDatabaseConfigured(): boolean {
  const url = process.env.DATABASE_URL;
  return Boolean(url && !url.includes('placeholder') && !url.includes('ep-sample-123456'));
}

/**
 * Gets or initializes the Drizzle ORM client connected to Neon PostgreSQL.
 * Returns null if DATABASE_URL is not configured (e.g. offline testing/mock mode).
 */
export function getDb(): NeonHttpDatabase<typeof schema> | null {
  if (!isDatabaseConfigured()) {
    return null;
  }

  if (!dbInstance) {
    const sql = neon(process.env.DATABASE_URL!);
    dbInstance = drizzle(sql, { schema });
  }

  return dbInstance;
}

export { schema };
