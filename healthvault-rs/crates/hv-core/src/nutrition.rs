//! Portable nutrition rules shared by meal logging, recipe servings and corrections.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::macros::Macros;

pub const MEALS: [&str; 4] = ["breakfast", "lunch", "dinner", "snack"];
pub const FOOD_STATES: [&str; 5] = ["raw", "cooked", "dry", "rehydrated", "none"];
pub const WEIGHED_STATES: [&str; 2] = ["raw", "cooked"];
pub const WEIGHT_SOURCES: [&str; 3] = ["weighed", "counted", "guessed"];
pub const MACRO_SOURCES: [&str; 4] = ["label", "usda", "recipe", "estimated"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Meal {
    Breakfast,
    Lunch,
    Dinner,
    Snack,
}

impl Meal {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Breakfast => "breakfast",
            Self::Lunch => "lunch",
            Self::Dinner => "dinner",
            Self::Snack => "snack",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, CoreError> {
        match raw {
            "breakfast" => Ok(Self::Breakfast),
            "lunch" => Ok(Self::Lunch),
            "dinner" => Ok(Self::Dinner),
            "snack" => Ok(Self::Snack),
            _ => Err(CoreError::validation(
                "meal",
                "expected breakfast, lunch, dinner or snack",
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FoodState {
    Raw,
    Cooked,
    Dry,
    Rehydrated,
    None,
}

impl FoodState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Raw => "raw",
            Self::Cooked => "cooked",
            Self::Dry => "dry",
            Self::Rehydrated => "rehydrated",
            Self::None => "none",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, CoreError> {
        match raw {
            "raw" => Ok(Self::Raw),
            "cooked" => Ok(Self::Cooked),
            "dry" => Ok(Self::Dry),
            "rehydrated" => Ok(Self::Rehydrated),
            "none" => Ok(Self::None),
            _ => Err(CoreError::validation("state", "unknown food state")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MacroSource {
    Label,
    Usda,
    Recipe,
    Estimated,
}

impl MacroSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Label => "label",
            Self::Usda => "usda",
            Self::Recipe => "recipe",
            Self::Estimated => "estimated",
        }
    }

    /// Provenance implied by a legacy row carrying only `estimated` and no `macro_source`.
    pub fn effective(source: Option<&str>, estimated: bool) -> Self {
        match source {
            Some("label") => Self::Label,
            Some("usda") => Self::Usda,
            Some("recipe") => Self::Recipe,
            Some("estimated") => Self::Estimated,
            _ if estimated => Self::Estimated,
            _ => Self::Label,
        }
    }
}

/// `basisGrams` in `recipe-serving.ts`: convert a weighed amount to the food's macro basis.
/// A declared yield factor of 1.0 with mismatched states is an error, never a silent 30% drift.
pub fn basis_grams(
    grams: f64,
    weighed_as: FoodState,
    basis_state: FoodState,
    yield_factor: f64,
    label: &str,
) -> Result<f64, CoreError> {
    if weighed_as == basis_state || basis_state == FoodState::None {
        return Ok(grams);
    }
    let factor = if yield_factor.is_finite() && yield_factor > 0.0 {
        yield_factor
    } else {
        1.0
    };
    if factor == 1.0 {
        return Err(CoreError::domain(format!(
            "{label}: cannot convert {weighed_as:?} grams to the food's {basis_state:?} basis because yieldFactor is 1.0; set yieldFactor on the food or send gramsAs {basis_state:?}"
        )));
    }
    let converted = match (basis_state, weighed_as) {
        (FoodState::Raw, FoodState::Cooked) => grams / factor,
        (FoodState::Cooked, FoodState::Raw) => grams * factor,
        (FoodState::Dry, FoodState::Cooked | FoodState::Rehydrated) => grams / factor,
        (FoodState::Rehydrated, FoodState::Dry) => grams * factor,
        _ => {
            return Err(CoreError::domain(format!(
                "{label}: cannot convert {weighed_as:?} grams to a {basis_state:?} basis with yieldFactor {factor}"
            )));
        }
    };
    Ok(converted)
}

/// The household measure table seeded by migration 0003. A per-food override always wins.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MeasureDefault {
    pub grams: Option<f64>,
    pub ml: Option<f64>,
}

pub fn measure_default(name: &str) -> Option<MeasureDefault> {
    match name {
        "tbsp" => Some(MeasureDefault {
            grams: Some(15.0),
            ml: Some(15.0),
        }),
        "tsp" => Some(MeasureDefault {
            grams: Some(5.0),
            ml: Some(5.0),
        }),
        "kutsarita" => Some(MeasureDefault {
            grams: Some(5.0),
            ml: Some(5.0),
        }),
        "cup" => Some(MeasureDefault {
            grams: Some(240.0),
            ml: Some(240.0),
        }),
        // Units without a universal mass need a per-food override or explicit grams.
        "piece" | "scoop" | "strip" => Some(MeasureDefault {
            grams: None,
            ml: None,
        }),
        _ => None,
    }
}

/// Resolve a `{name, count}` measure against per-food overrides then the global defaults.
pub fn resolve_measure_grams(
    name: &str,
    count: f64,
    overrides: &HashMap<String, f64>,
    label: &str,
) -> Result<f64, CoreError> {
    let grams = overrides
        .get(name)
        .copied()
        .or_else(|| measure_default(name).and_then(|m| m.grams));
    grams.map(|per| per * count).ok_or_else(|| {
        CoreError::validation(
            label,
            format!("measure '{name}' has no mass; add a per-food override"),
        )
    })
}

/// Values captured on a logged entry. Key order mirrors `valuesOf()` in `food-history.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SnapshotValues {
    pub grams: f64,
    pub raw_equivalent_grams: Option<f64>,
    pub kcal: f64,
    pub protein_g: f64,
    pub carbs_g: f64,
    pub fat_g: f64,
    pub fibre_g: f64,
    pub sodium_mg: f64,
}

impl SnapshotValues {
    pub fn macros(&self) -> Macros {
        Macros {
            kcal: self.kcal,
            protein_g: self.protein_g,
            carbs_g: self.carbs_g,
            fat_g: self.fat_g,
            fibre_g: self.fibre_g,
            sodium_mg: self.sodium_mg,
        }
    }
}

/// Rescale a logged portion from its stored per-serving snapshot. Never re-derives from the
/// live food definition: history is immutable until an explicit refresh.
pub fn rescale_snapshot(
    _current: &SnapshotValues,
    per_serving: &SnapshotValues,
    fraction: f64,
) -> SnapshotValues {
    SnapshotValues {
        grams: per_serving.grams * fraction,
        raw_equivalent_grams: per_serving.raw_equivalent_grams.map(|v| v * fraction),
        kcal: per_serving.kcal * fraction,
        protein_g: per_serving.protein_g * fraction,
        carbs_g: per_serving.carbs_g * fraction,
        fat_g: per_serving.fat_g * fraction,
        fibre_g: per_serving.fibre_g * fraction,
        sodium_mg: per_serving.sodium_mg * fraction,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PerServingSnapshot {
    pub grams: f64,
    pub kcal: f64,
    pub protein_g: f64,
    pub carbs_g: f64,
    pub fat_g: f64,
    pub fibre_g: f64,
    pub sodium_mg: f64,
    pub estimated: bool,
    pub snapshot_version: u8,
    pub ingredient_count: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cooked_to_raw_divides_by_yield_factor() {
        let basis = basis_grams(150.0, FoodState::Cooked, FoodState::Raw, 0.75, "entry").unwrap();
        assert!((basis - 200.0).abs() < 1e-9);
    }

    #[test]
    fn mismatched_states_without_a_yield_factor_are_rejected() {
        assert!(basis_grams(100.0, FoodState::Cooked, FoodState::Raw, 1.0, "entry").is_err());
    }

    #[test]
    fn per_food_measure_overrides_beat_global_defaults() {
        let mut overrides = HashMap::new();
        overrides.insert("tbsp".to_owned(), 21.0);
        assert_eq!(
            resolve_measure_grams("tbsp", 2.0, &overrides, "measure").unwrap(),
            42.0
        );
        assert_eq!(
            resolve_measure_grams("tsp", 2.0, &HashMap::new(), "measure").unwrap(),
            10.0
        );
        assert!(resolve_measure_grams("piece", 1.0, &HashMap::new(), "measure").is_err());
    }

    #[test]
    fn rescale_uses_the_stored_snapshot_not_live_food_data() {
        let per_serving = SnapshotValues {
            grams: 100.0,
            raw_equivalent_grams: Some(120.0),
            kcal: 200.0,
            protein_g: 10.0,
            carbs_g: 20.0,
            fat_g: 5.0,
            fibre_g: 2.0,
            sodium_mg: 100.0,
        };
        let got = rescale_snapshot(
            &SnapshotValues {
                kcal: 999.0,
                ..per_serving
            },
            &per_serving,
            0.5,
        );
        assert_eq!(got.kcal, 100.0);
        assert_eq!(got.raw_equivalent_grams, Some(60.0));
    }
}
