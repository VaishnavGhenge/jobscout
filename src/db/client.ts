import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

/**
 * Returns null when DATABASE_URL isn't configured yet, so pages can render a
 * friendly setup message instead of crashing on first `pnpm dev`.
 */
export const db = process.env.DATABASE_URL
  ? drizzle(neon(process.env.DATABASE_URL), { schema })
  : null;

export function requireDb() {
  if (!db) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env, add your Neon URL, then run `pnpm db:push`.",
    );
  }
  return db;
}

export const isDbConfigured = () => db !== null;
