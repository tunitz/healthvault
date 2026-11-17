use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HealthRecordRow {
    pub type_identifier: String,
    pub unit: String,
    pub value: f64,
    pub start_date: String,
    pub start_ms: i64,
    pub day: String,
    pub end_date: String,
    pub end_ms: i64,
    pub source_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkoutImportRow {
    pub workout_activity_type: String,
    pub start_date: String,
    pub start_ms: i64,
    pub day: String,
    pub end_date: String,
    pub end_ms: i64,
    pub duration_seconds: Option<f64>,
    pub total_distance: Option<f64>,
    pub total_distance_unit: Option<String>,
    pub total_energy_burned: Option<f64>,
    pub total_energy_burned_unit: Option<String>,
    pub avg_hr: Option<f64>,
    pub min_hr: Option<f64>,
    pub max_hr: Option<f64>,
    pub source_name: Option<String>,
    pub metadata_json: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SummaryRow {
    pub date_components: String,
    pub day: String,
    pub active_energy_burned: Option<f64>,
    pub active_energy_burned_goal: Option<f64>,
    pub apple_move_minutes: Option<f64>,
    pub apple_move_minutes_goal: Option<f64>,
    pub apple_exercise_time: Option<f64>,
    pub apple_exercise_time_goal: Option<f64>,
    pub apple_stand_hours: Option<f64>,
    pub apple_stand_hours_goal: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MeCharacteristics {
    pub date_of_birth: Option<String>,
    pub biological_sex: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ParsedHealth {
    pub records: Vec<HealthRecordRow>,
    pub workouts: Vec<WorkoutImportRow>,
    pub summaries: Vec<SummaryRow>,
    pub me: MeCharacteristics,
}

impl ParsedHealth {
    pub fn len(&self) -> usize {
        self.records.len() + self.workouts.len() + self.summaries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn drain(&mut self) -> Self {
        Self {
            records: std::mem::take(&mut self.records),
            workouts: std::mem::take(&mut self.workouts),
            summaries: std::mem::take(&mut self.summaries),
            me: self.me.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IngestReport {
    pub upload_id: i64,
    pub inserted: i64,
    pub duplicates: i64,
}
