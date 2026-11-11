/**
 * `bun run db:migrate` — apply migrations through the app's shared initializer.
 *
 * `drizzle-kit migrate` would bypass the `${DATABASE_PATH}.migrate-lock` sidecar that
 * `src/db/index.ts` and the Rust runner share, so a manual migration could race a booting app,
 * a `next build` worker, or the Rust binary. Importing the module runs the same locked,
 * idempotent initializer every process uses.
 */
import { sqlite } from "../src/db";

sqlite.close();
