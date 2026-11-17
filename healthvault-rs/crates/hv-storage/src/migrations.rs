//! Forward-only migrations, byte-for-byte copies of the app's `drizzle/0000..0006` SQL.
//!
//! `PRAGMA user_version` is the Rust cursor. Existing Drizzle-managed databases are adopted as a
//! verified baseline instead of being re-created; a partially migrated one is refused so no
//! stack silently finishes another stack's migration.

use rusqlite::{Connection, OptionalExtension};

use crate::error::StorageError;

pub const MIGRATIONS: [&str; 7] = [
    include_str!("../migrations/0000_powerful_maverick.sql"),
    include_str!("../migrations/0001_demonic_doctor_octopus.sql"),
    include_str!("../migrations/0002_cooing_iron_fist.sql"),
    include_str!("../migrations/0003_recipes_measures_provenance.sql"),
    include_str!("../migrations/0004_ingredient_snapshots_history.sql"),
    include_str!("../migrations/0005_magenta_invaders.sql"),
    include_str!("../migrations/0006_whey_action_association.sql"),
];

const REQUIRED_TABLES: [&str; 19] = [
    "activity_summaries",
    "food_log",
    "food_log_ingredients",
    "food_log_revisions",
    "food_revisions",
    "foods",
    "measures",
    "measurements",
    "nutrition_targets",
    "planned_sessions",
    "profile",
    "recipe_ingredients",
    "recipes",
    "records",
    "strength_sets",
    "supplement_logs",
    "supplements",
    "uploads",
    "workouts",
];

fn user_version(conn: &Connection) -> Result<i64, StorageError> {
    Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?)
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, StorageError> {
    let found: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [name],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

fn schema_complete(conn: &Connection) -> Result<bool, StorageError> {
    for table in REQUIRED_TABLES {
        if !table_exists(conn, table)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Adopt a database already migrated by Drizzle, but only if the applied count and the physical
/// schema both prove it is complete. Anything partial is an error, never a guess.
fn adopt_drizzle_baseline(conn: &Connection) -> Result<bool, StorageError> {
    if !table_exists(conn, "__drizzle_migrations")? {
        return Ok(false);
    }
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM __drizzle_migrations", [], |row| {
        row.get(0)
    })?;
    if count != MIGRATIONS.len() as i64 {
        return Err(StorageError::Migration(format!(
            "Drizzle reports {count} applied migrations; expected {}. Finish the migration with the original app before switching stacks.",
            MIGRATIONS.len()
        )));
    }
    if !schema_complete(conn)? {
        return Err(StorageError::Migration(
            "Drizzle reports all migrations applied but the schema is incomplete".into(),
        ));
    }
    conn.pragma_update(None, "user_version", MIGRATIONS.len() as i64)?;
    Ok(true)
}

/// Migrate to a specific version (used by upgrade-path tests and by `hv-migrate --target`).
pub fn migrate_to(conn: &mut Connection, target: usize) -> Result<(), StorageError> {
    let target = target.min(MIGRATIONS.len());
    if user_version(conn)? == 0 && adopt_drizzle_baseline(conn)? {
        return Ok(());
    }
    if target == 0 {
        return Ok(());
    }
    let current = user_version(conn)? as usize;
    if current > target {
        return Err(StorageError::Migration(format!(
            "database is at version {current}, cannot roll back to {target}"
        )));
    }
    if current == 0 && schema_complete(conn)? {
        return Err(StorageError::Migration(
            "database has HealthVault tables but no migration cursor; refusing to guess its version".into(),
        ));
    }
    for (index, step) in MIGRATIONS.iter().enumerate().take(target).skip(current) {
        let tx = conn.transaction()?;
        // Drizzle's `--> statement-breakpoint` marker is a SQL comment to SQLite; removing it
        // keeps the embedded files identical to the ones the TypeScript app applies.
        tx.execute_batch(&step.replace("--> statement-breakpoint", ""))?;
        tx.pragma_update(None, "user_version", (index + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

pub fn migrate(conn: &mut Connection) -> Result<(), StorageError> {
    migrate_to(conn, MIGRATIONS.len())
}

pub fn normalized_schema(conn: &Connection) -> Result<Vec<String>, StorageError> {
    let mut stmt = conn.prepare(
        "SELECT type || ' ' || name || ' ' || sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name",
    )?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.map(|row| {
        row.map(|sql| sql.split_whitespace().collect::<Vec<_>>().join(" "))
            .map_err(StorageError::from)
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_sqlite_is_new_enough_for_the_wal_reset_fix() {
        // SQLITE_VERSION_NUMBER = major*1_000_000 + minor*1_000 + patch.
        assert!(
            rusqlite::version_number() >= 3_051_003,
            "bundled SQLite is too old: {}",
            rusqlite::version()
        );
    }

    #[test]
    fn fresh_database_migrates_to_latest_with_all_tables() {
        let mut conn = crate::connection::open_memory().unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(user_version(&conn).unwrap(), 7);
        assert!(schema_complete(&conn).unwrap());
        let scoop: Option<f64> = conn
            .query_row(
                "SELECT grams_default FROM measures WHERE name = 'scoop'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(scoop, None);
    }

    #[test]
    fn upgrading_from_every_intermediate_version_matches_a_fresh_install() {
        let mut fresh = crate::connection::open_memory().unwrap();
        migrate(&mut fresh).unwrap();
        let expected = normalized_schema(&fresh).unwrap();
        for stop in 1..MIGRATIONS.len() {
            let mut conn = crate::connection::open_memory().unwrap();
            migrate_to(&mut conn, stop).unwrap();
            migrate(&mut conn).unwrap();
            assert_eq!(
                normalized_schema(&conn).unwrap(),
                expected,
                "schema diverged from v{stop}"
            );
        }
    }

    #[test]
    fn a_drizzle_managed_database_is_adopted_not_recreated() {
        let mut conn = crate::connection::open_memory().unwrap();
        migrate(&mut conn).unwrap();
        conn.execute_batch("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY);")
            .unwrap();
        for _ in 0..7 {
            conn.execute("INSERT INTO __drizzle_migrations DEFAULT VALUES", [])
                .unwrap();
        }
        conn.pragma_update(None, "user_version", 0_i64).unwrap();
        let marker = conn
            .query_row("INSERT INTO foods (name, kcal_per_100g, created_at_ms, updated_at_ms) VALUES ('kept', 1, 1, 1) RETURNING id", [], |r| r.get::<_, i64>(0))
            .unwrap();
        migrate(&mut conn).unwrap();
        let kept: i64 = conn
            .query_row("SELECT id FROM foods WHERE name = 'kept'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, marker);
    }

    #[test]
    fn a_partially_migrated_drizzle_database_is_refused() {
        let mut conn = crate::connection::open_memory().unwrap();
        migrate(&mut conn).unwrap();
        conn.execute_batch("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY);")
            .unwrap();
        conn.execute("INSERT INTO __drizzle_migrations DEFAULT VALUES", [])
            .unwrap();
        conn.pragma_update(None, "user_version", 0_i64).unwrap();
        assert!(matches!(
            migrate(&mut conn),
            Err(StorageError::Migration(_))
        ));
    }
}
