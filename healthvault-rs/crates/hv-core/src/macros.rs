//! Nutrition arithmetic shared by food logging, recipe servings and history refresh.
//!
//! Field order is part of the contract: `serde_json` serialises structs in declaration order, and
//! the TypeScript app hashes snapshot JSON with a fixed key order. Any reorder here breaks the
//! cross-runtime preview hash golden tests.

use serde::{Deserialize, Serialize};

/// The six nutrition values used everywhere in `HealthVault`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Macros {
    pub kcal: f64,
    pub protein_g: f64,
    pub carbs_g: f64,
    pub fat_g: f64,
    pub fibre_g: f64,
    pub sodium_mg: f64,
}

impl Macros {
    pub const ZERO: Self = Self {
        kcal: 0.0,
        protein_g: 0.0,
        carbs_g: 0.0,
        fat_g: 0.0,
        fibre_g: 0.0,
        sodium_mg: 0.0,
    };

    pub fn sum(rows: impl IntoIterator<Item = Self>) -> Self {
        rows.into_iter().fold(Self::ZERO, |a, r| Self {
            kcal: a.kcal + r.kcal,
            protein_g: a.protein_g + r.protein_g,
            carbs_g: a.carbs_g + r.carbs_g,
            fat_g: a.fat_g + r.fat_g,
            fibre_g: a.fibre_g + r.fibre_g,
            sodium_mg: a.sodium_mg + r.sodium_mg,
        })
    }

    pub fn scaled(&self, factor: f64) -> Self {
        Self {
            kcal: self.kcal * factor,
            protein_g: self.protein_g * factor,
            carbs_g: self.carbs_g * factor,
            fat_g: self.fat_g * factor,
            fibre_g: self.fibre_g * factor,
            sodium_mg: self.sodium_mg * factor,
        }
    }

    /// Macros for `basis_grams` of a food whose values are per 100 g.
    pub fn for_grams(per_100g: Self, basis_grams: f64) -> Self {
        per_100g.scaled(basis_grams / 100.0)
    }

    /// Same comparison as `sameMacros` in `food-history.ts`.
    pub fn same(&self, other: &Self, epsilon: f64) -> bool {
        (self.kcal - other.kcal).abs() <= epsilon
            && (self.protein_g - other.protein_g).abs() <= epsilon
            && (self.carbs_g - other.carbs_g).abs() <= epsilon
            && (self.fat_g - other.fat_g).abs() <= epsilon
            && (self.fibre_g - other.fibre_g).abs() <= epsilon
            && (self.sodium_mg - other.sodium_mg).abs() <= epsilon
    }

    pub fn values(&self) -> [f64; 6] {
        [
            self.kcal,
            self.protein_g,
            self.carbs_g,
            self.fat_g,
            self.fibre_g,
            self.sodium_mg,
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_100g_scales_exactly_as_the_typescript_app() {
        let per_100 = Macros {
            kcal: 165.0,
            protein_g: 31.0,
            ..Macros::ZERO
        };
        let got = Macros::for_grams(per_100, 150.0);
        assert!((got.kcal - 247.5).abs() < 1e-9);
        assert!((got.protein_g - 46.5).abs() < 1e-9);
    }

    #[test]
    fn same_macros_uses_inclusive_epsilon() {
        let a = Macros {
            kcal: 100.0,
            ..Macros::ZERO
        };
        let b = Macros {
            kcal: 100.000_000_5,
            ..Macros::ZERO
        };
        assert!(a.same(&b, 1e-6));
        assert!(!a.same(&b, 1e-9));
    }

    #[test]
    fn struct_key_order_matches_history_hash_contract() {
        let json = serde_json::to_string(&Macros {
            kcal: 1.0,
            ..Macros::ZERO
        })
        .unwrap();
        assert_eq!(
            json,
            "{\"kcal\":1.0,\"protein_g\":0.0,\"carbs_g\":0.0,\"fat_g\":0.0,\"fibre_g\":0.0,\"sodium_mg\":0.0}"
        );
    }
}
