#![doc = "SQLite storage adapter: migration-compatible schema, single-writer actor, WAL-safe backup."]

pub mod connection;
pub mod error;
pub mod migrations;
pub mod store;

pub use error::StorageError;
pub use store::{StoreHandle, query_one, query_rows, scalar_i64};
