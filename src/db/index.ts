import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

const file = process.env.DATABASE_PATH ?? join(process.cwd(), "data", "health.db");
mkdirSync(dirname(file), { recursive: true });
export const sqlite = new Database(file);
sqlite.pragma("journal_mode = WAL");
export const db = drizzle(sqlite, { schema });

// Idempotent: brings a brand-new file (tests, first boot) up to the current schema.
migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
