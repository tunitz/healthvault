//! Explicit, hash-gated history refresh rules from `src/lib/services/food-history.ts`.
//!
//! Snapshots are immutable until the user previews a scoped correction. Apply requires the exact
//! preview hash so a stale preview can never silently rewrite rows the user did not see.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::day::Day;
use crate::error::CoreError;
use crate::nutrition::SnapshotValues;

pub const MAX_HISTORY_REFRESH_ROWS: usize = 500;
pub const MACRO_EPSILON: f64 = 1e-6;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryScope {
    pub food_ids: Vec<i64>,
    pub entry_ids: Vec<i64>,
    pub from_day: Option<Day>,
    pub to_day: Option<Day>,
}

impl HistoryScope {
    /// The TS `parseScope`: a global rewrite is never implicit.
    pub fn parse(
        food_ids: &[i64],
        entry_ids: &[i64],
        from_day: Option<Day>,
        to_day: Option<Day>,
    ) -> Result<Self, CoreError> {
        if food_ids.is_empty() && entry_ids.is_empty() {
            return Err(CoreError::validation(
                "scope",
                "scope the refresh with foodIds and/or entryIds; a global past-meal rewrite is never implicit",
            ));
        }
        if food_ids.len() > 200 {
            return Err(CoreError::validation("foodIds", "accepts at most 200 ids"));
        }
        if entry_ids.len() > 500 {
            return Err(CoreError::validation("entryIds", "accepts at most 500 ids"));
        }
        if let (Some(from), Some(to)) = (from_day, to_day)
            && from > to
        {
            return Err(CoreError::validation(
                "fromDay",
                "must be on or before toDay",
            ));
        }
        let mut foods = food_ids.to_vec();
        let mut entries = entry_ids.to_vec();
        foods.sort_unstable();
        foods.dedup();
        entries.sort_unstable();
        entries.dedup();
        Ok(Self {
            food_ids: foods,
            entry_ids: entries,
            from_day,
            to_day,
        })
    }

    pub fn contains_day(&self, day: &Day) -> bool {
        self.from_day.is_none_or(|from| day >= &from) && self.to_day.is_none_or(|to| day <= &to)
    }

    pub fn matches(&self, food_id: i64, entry_id: i64, day: &Day) -> bool {
        self.contains_day(day)
            && (self.food_ids.is_empty() || self.food_ids.contains(&food_id))
            && (self.entry_ids.is_empty() || self.entry_ids.contains(&entry_id))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeStatus {
    Changed,
    Unchanged,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HistoryChange {
    pub kind: String,
    pub entry_id: i64,
    pub ingredient_id: Option<i64>,
    pub food_id: Option<i64>,
    pub name: String,
    pub day: Day,
    pub meal: String,
    pub status: ChangeStatus,
    pub reason: Option<String>,
    pub previous: Option<SnapshotValues>,
    pub proposed: Option<SnapshotValues>,
}

impl HistoryChange {
    fn change_key(&self) -> String {
        format!(
            "{}:{}:{}",
            self.kind,
            self.entry_id,
            self.ingredient_id.unwrap_or(0)
        )
    }
}

/// Stable SHA-256 of the exact change set, byte-for-byte compatible with the TS app's
/// `JSON.stringify({ scope, changes: stable })` hash.
pub fn hash_changes(scope: &HistoryScope, changes: &[HistoryChange]) -> String {
    let mut stable = changes.to_vec();
    stable.sort_unstable_by_key(HistoryChange::change_key);
    let payload = HashPayload {
        scope: HashScope {
            food_ids: &scope.food_ids,
            entry_ids: &scope.entry_ids,
            from_day: scope.from_day.map(|d| d.to_string()),
            to_day: scope.to_day.map(|d| d.to_string()),
        },
        changes: stable,
    };
    let json = serde_json::to_string(&payload).unwrap_or_default();
    hex::encode(Sha256::digest(json.as_bytes()))
}

#[derive(Serialize)]
struct HashPayload<'a> {
    scope: HashScope<'a>,
    changes: Vec<HistoryChange>,
}

#[derive(Serialize)]
struct HashScope<'a> {
    food_ids: &'a [i64],
    entry_ids: &'a [i64],
    from_day: Option<String>,
    to_day: Option<String>,
}

/// Classify one snapshot against the current food definition.
///
/// A row is skipped, never guessed, when provenance is missing or the food's basis state changed.
pub fn classify(
    previous: &SnapshotValues,
    proposed: &SnapshotValues,
    basis_known: bool,
    basis_state_changed: bool,
) -> ChangeStatus {
    if !basis_known || basis_state_changed {
        ChangeStatus::Skipped
    } else if previous.macros().same(&proposed.macros(), MACRO_EPSILON) {
        ChangeStatus::Unchanged
    } else {
        ChangeStatus::Changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(entry: i64, ingredient: Option<i64>) -> HistoryChange {
        HistoryChange {
            kind: "ingredient".into(),
            entry_id: entry,
            ingredient_id: ingredient,
            food_id: Some(7),
            name: "Egg".into(),
            day: Day::parse("2026-11-17").unwrap(),
            meal: "breakfast".into(),
            status: ChangeStatus::Changed,
            reason: None,
            previous: None,
            proposed: None,
        }
    }

    #[test]
    fn global_refresh_scope_is_rejected() {
        assert!(HistoryScope::parse(&[], &[], None, None).is_err());
    }

    #[test]
    fn preview_hash_is_independent_of_change_input_order() {
        let scope = HistoryScope::parse(&[7], &[], None, None).unwrap();
        let a = hash_changes(&scope, &[change(2, None), change(1, Some(3))]);
        let b = hash_changes(&scope, &[change(1, Some(3)), change(2, None)]);
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn changing_one_value_changes_the_hash() {
        let scope = HistoryScope::parse(&[7], &[], None, None).unwrap();
        let mut other = change(1, None);
        other.name = "Egg (large)".into();
        assert_ne!(
            hash_changes(&scope, &[change(1, None)]),
            hash_changes(&scope, &[other])
        );
    }

    #[test]
    fn missing_provenance_is_skipped_not_guessed() {
        let values = SnapshotValues {
            grams: 100.0,
            raw_equivalent_grams: None,
            kcal: 100.0,
            protein_g: 1.0,
            carbs_g: 1.0,
            fat_g: 1.0,
            fibre_g: 0.0,
            sodium_mg: 0.0,
        };
        assert_eq!(
            classify(&values, &values, false, false),
            ChangeStatus::Skipped
        );
        assert_eq!(
            classify(&values, &values, true, true),
            ChangeStatus::Skipped
        );
        assert_eq!(
            classify(&values, &values, true, false),
            ChangeStatus::Unchanged
        );
    }
}
