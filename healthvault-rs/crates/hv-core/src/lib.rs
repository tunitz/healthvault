#![doc = "Framework-free `HealthVault` domain rules. No IO, UI, async runtime or HTTP framework."]

pub mod agent;
pub mod day;
pub mod error;
pub mod history;
pub mod macros;
pub mod nutrition;
pub mod workouts;

pub use day::{DEFAULT_TIMEZONE, Day};
pub use error::{CoreError, TimezoneName};
pub use history::{HistoryChange, HistoryScope, MAX_HISTORY_REFRESH_ROWS};
pub use macros::Macros;
pub use nutrition::{Meal, SnapshotValues};
pub use workouts::{DailyPoint, FiveKAttempt, QuantityRecord, WorkoutRow};
