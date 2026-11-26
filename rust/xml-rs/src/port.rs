//! Rust port of `src/lib/xml.ts` (`parseHealthXml`) plus a zero-copy streaming scanner
//! (`stream_health_xml`) reused by `rust/ingest-rs`.

#![forbid(unsafe_code)]

use std::borrow::Cow;
use std::io::{BufRead, Cursor};

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeDelta, TimeZone};
use indexmap::IndexMap;
use quick_xml::events::attributes::Attribute;
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};
use serde_json::{Map, Value, json};

use crate::{js, utf16};

const MAX_JS_DATE_MS: i64 = 8_640_000_000_000_000;

/// Trim JS whitespace (Unicode White_Space plus U+FEFF BOM).
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}')
}

#[inline]
fn digits2(b: &[u8], i: usize) -> i32 {
    if i + 1 >= b.len() {
        return -1;
    }
    let (a, c) = (b[i].wrapping_sub(b'0'), b[i + 1].wrapping_sub(b'0'));
    if a <= 9 && c <= 9 {
        i32::from(a) * 10 + i32::from(c)
    } else {
        -1
    }
}

#[inline]
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn js_date_utc_ms(year: i32, month_idx: i32, day: i32, hh: i32, mi: i32, ss: i32) -> f64 {
    let y_adj = i64::from(if (0..=99).contains(&year) {
        year + 1900
    } else {
        year
    });
    let total_months = y_adj * 12 + i64::from(month_idx);
    let days = days_from_civil(
        total_months.div_euclid(12),
        total_months.rem_euclid(12) + 1,
        1,
    ) + i64::from(day)
        - 1;
    let ms = days
        .saturating_mul(86_400_000)
        .saturating_add(i64::from(hh) * 3_600_000 + i64::from(mi) * 60_000 + i64::from(ss) * 1_000);
    if ms.abs() > MAX_JS_DATE_MS {
        f64::NAN
    } else {
        ms as f64
    }
}

fn local_ndt_ms(ndt: NaiveDateTime) -> f64 {
    let resolved = match Local.from_local_datetime(&ndt) {
        chrono::LocalResult::Single(dt) | chrono::LocalResult::Ambiguous(dt, _) => {
            dt.timestamp_millis()
        }
        chrono::LocalResult::None => {
            match Local.from_local_datetime(&(ndt + TimeDelta::hours(1))) {
                chrono::LocalResult::Single(dt) | chrono::LocalResult::Ambiguous(dt, _) => {
                    dt.timestamp_millis()
                }
                chrono::LocalResult::None => return f64::NAN,
            }
        }
    };
    if resolved.abs() > MAX_JS_DATE_MS {
        f64::NAN
    } else {
        resolved as f64
    }
}

/// Fallback date parser matching JS `Date.parse(s)` for ISO 8601, Apple offsets, and RFC 2822.
pub fn parse_date_fallback(raw: &str) -> f64 {
    let s = js_trim(raw);
    if s.is_empty() {
        return f64::NAN;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s).or_else(|_| DateTime::parse_from_rfc2822(s)) {
        return dt.timestamp_millis() as f64;
    }
    for fmt in [
        "%Y-%m-%d %H:%M:%S %#z",
        "%Y-%m-%dT%H:%M:%S%#z",
        "%Y-%m-%d %H:%M:%S%.f %#z",
        "%Y-%m-%dT%H:%M:%S%.f%#z",
    ] {
        if let Ok(dt) = DateTime::parse_from_str(s, fmt) {
            return dt.timestamp_millis() as f64;
        }
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(ndt) = NaiveDateTime::parse_from_str(s, fmt) {
            return local_ndt_ms(ndt);
        }
    }
    if s.len() == 10
        && let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d")
        && let Some(ndt) = d.and_hms_opt(0, 0, 0)
    {
        return ndt.and_utc().timestamp_millis() as f64;
    }
    f64::NAN
}

/// Fast-path timestamp parser: `"2026-09-01 07:30:00 +0800" -> epoch ms`.
pub fn ms_of_str(s: &str) -> f64 {
    if s.is_empty() {
        return 0.0;
    }
    let b = s.as_bytes();
    if b.len() >= 19
        && b[4] == b'-'
        && b[7] == b'-'
        && matches!(b[10], b' ' | b'T')
        && b[13] == b':'
        && b[16] == b':'
    {
        let (y1, y2, mo, d) = (digits2(b, 0), digits2(b, 2), digits2(b, 5), digits2(b, 8));
        let (hh, mi, ss) = (digits2(b, 11), digits2(b, 14), digits2(b, 17));
        if y1 >= 0 && y2 >= 0 && mo >= 1 && d >= 1 && hh >= 0 && mi >= 0 && ss >= 0 {
            let year = y1 * 100 + y2;
            if b.len() == 19 {
                let utc = js_date_utc_ms(year, mo - 1, d, hh, mi, ss);
                if !utc.is_finite() {
                    return f64::NAN;
                }
                let ms = utc as i64;
                return DateTime::from_timestamp(
                    ms.div_euclid(1_000),
                    (ms.rem_euclid(1_000) * 1_000_000) as u32,
                )
                .map_or(f64::NAN, |dt| local_ndt_ms(dt.naive_utc()));
            }
            let off_idx = 19 + usize::from(b[19] == b' ');
            if off_idx < b.len() {
                let sign_ch = b[off_idx];
                if sign_ch == b'Z' && off_idx + 1 == b.len() {
                    return js_date_utc_ms(year, mo - 1, d, hh, mi, ss);
                }
                if matches!(sign_ch, b'+' | b'-') {
                    let oh = digits2(b, off_idx + 1);
                    let colon = usize::from(off_idx + 3 < b.len() && b[off_idx + 3] == b':');
                    let om = digits2(b, off_idx + 3 + colon);
                    if oh >= 0 && om >= 0 && off_idx + 5 + colon == b.len() {
                        let sign = if sign_ch == b'+' { 1.0 } else { -1.0 };
                        let offset_ms = f64::from(oh * 60 + om) * 60_000.0 * sign;
                        return js_date_utc_ms(year, mo - 1, d, hh, mi, ss) - offset_ms;
                    }
                }
            }
        }
    }
    parse_date_fallback(s)
}

/// Format epoch ms as UTC `"YYYY-MM-DD"`.
pub fn format_utc_day(ms: f64) -> String {
    DateTime::from_timestamp((ms as i64).div_euclid(1_000), 0)
        .map_or_else(String::new, |dt| dt.format("%Y-%m-%d").to_string())
}

#[inline]
fn to_km_ref(value: f64, unit: Option<&str>) -> Option<f64> {
    match js_trim(unit.unwrap_or("")).to_lowercase().as_str() {
        "km" => Some(value),
        "mi" => Some(value * 1.609344),
        "m" => Some(value / 1000.0),
        "yd" => Some(value * 0.0009144),
        "ft" => Some(value * 0.0003048),
        _ => None,
    }
}

#[inline]
fn to_kcal_ref(value: f64, unit: Option<&str>) -> f64 {
    let trimmed = js_trim(unit.unwrap_or(""));
    if trimmed == "Cal" {
        return value;
    }
    match trimmed.to_lowercase().as_str() {
        "kcal" => value,
        "kj" => value * 0.2390057,
        "cal" => value / 1000.0,
        _ => value,
    }
}

#[inline]
fn to_seconds_ref(value: f64, unit: Option<&str>) -> f64 {
    let lower = unit.unwrap_or("sec").to_lowercase();
    if lower.starts_with("min") {
        value * 60.0
    } else if lower.starts_with('h') {
        value * 3600.0
    } else {
        value
    }
}

/// Port of `num()` (`src/lib/xml.ts:98`).
#[inline]
pub fn parse_js_num(v: Option<&str>) -> Option<f64> {
    let s = v.filter(|s| !s.is_empty())?;
    let t = js_trim(s);
    if t.is_empty() {
        return Some(0.0);
    }
    let b = t.as_bytes();
    if !(b[0].is_ascii_digit() || matches!(b[0], b'-' | b'+' | b'.')) {
        return None;
    }
    if b.len() >= 2 && b[0] == b'0' {
        match b[1] {
            b'x' | b'X' => return u64::from_str_radix(&t[2..], 16).ok().map(|n| n as f64),
            b'b' | b'B' => return u64::from_str_radix(&t[2..], 2).ok().map(|n| n as f64),
            b'o' | b'O' => return u64::from_str_radix(&t[2..], 8).ok().map(|n| n as f64),
            _ => {}
        }
    }
    let head = if matches!(b[0], b'+' | b'-') {
        b.get(1).copied()
    } else {
        Some(b[0])
    };
    if matches!(head, Some(b'i' | b'I' | b'n' | b'N')) {
        return None;
    }
    t.parse::<f64>().ok().filter(|n| n.is_finite())
}

#[inline]
fn day_of(iso: &str) -> Cow<'_, str> {
    if iso.is_ascii() {
        Cow::Borrowed(&iso[..iso.len().min(10)])
    } else {
        Cow::Owned(utf16::slice(&utf16::units(iso), 0, 10))
    }
}

#[inline]
fn sleep_stage(raw: &str) -> f64 {
    match raw {
        "HKCategoryValueSleepAnalysisInBed" => 1.0,
        "HKCategoryValueSleepAnalysisAsleepUnspecified" | "HKCategoryValueSleepAnalysisAsleep" => {
            2.0
        }
        "HKCategoryValueSleepAnalysisAwake" => 3.0,
        "HKCategoryValueSleepAnalysisAsleepCore" => 4.0,
        "HKCategoryValueSleepAnalysisAsleepDeep" => 5.0,
        "HKCategoryValueSleepAnalysisAsleepREM" => 6.0,
        _ => 0.0,
    }
}

#[inline]
fn attr_val<'a>(attr: Attribute<'a>) -> Result<Cow<'a, str>, String> {
    if !attr
        .value
        .bytes()
        .any(|b| matches!(b, b'&' | b'\r' | b'\n' | b'\t'))
    {
        return Ok(attr.value);
    }
    attr.normalized_value(XmlVersion::Implicit1_0)
        .map_err(|err| format!("XML entity error: {err}"))
}

pub struct HealthRecordRef<'a> {
    pub type_identifier: &'a str,
    pub unit: &'a str,
    pub value: f64,
    pub start_date: &'a str,
    pub start_ms: f64,
    pub day: &'a str,
    pub end_date: &'a str,
    pub end_ms: f64,
    pub source_name: &'a str,
}

#[derive(Default)]
struct WorkoutStat {
    sum: Option<String>,
    average: Option<String>,
    minimum: Option<String>,
    maximum: Option<String>,
    unit: Option<String>,
}

#[derive(Default)]
struct WorkoutBuilder {
    attrs: [Option<String>; 10],
    meta: IndexMap<String, String>,
    stats: IndexMap<String, WorkoutStat>,
}

pub struct WorkoutOwned {
    pub workout_activity_type: String,
    pub start_date: String,
    pub start_ms: f64,
    pub day: String,
    pub end_date: String,
    pub end_ms: f64,
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

pub struct SummaryOwned {
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

#[derive(Default, Clone)]
pub struct MeOwned {
    pub date_of_birth: Option<String>,
    pub biological_sex: Option<String>,
}

pub trait HealthSink {
    fn on_record(&mut self, r: &HealthRecordRef<'_>) -> Result<(), String>;
    fn on_workout(&mut self, w: WorkoutOwned) -> Result<(), String>;
    fn on_summary(&mut self, s: SummaryOwned) -> Result<(), String>;
}

struct PendingRecord {
    type_identifier: String,
    unit: String,
    value: f64,
    start_date: String,
    end_date: String,
    source_name: String,
}

struct RawRecord<'a> {
    rt: Cow<'a, str>,
    u: Cow<'a, str>,
    val: f64,
    sd: Cow<'a, str>,
    ed: Option<Cow<'a, str>>,
    sn: Cow<'a, str>,
}

fn parse_record_attrs<'a>(e: &'a BytesStart<'a>) -> Result<RawRecord<'a>, String> {
    let (mut rt, mut u, mut rv, mut sd, mut ed, mut sn) = (
        Cow::Borrowed(""),
        Cow::Borrowed(""),
        Cow::Borrowed(""),
        Cow::Borrowed(""),
        None,
        Cow::Borrowed(""),
    );
    for attr in e.attributes() {
        let attr = attr.map_err(|err| format!("XML attribute error: {err}"))?;
        match attr.key.as_ref() {
            "type" => rt = attr_val(attr)?,
            "unit" => u = attr_val(attr)?,
            "value" => rv = attr_val(attr)?,
            "startDate" => sd = attr_val(attr)?,
            "endDate" => ed = Some(attr_val(attr)?),
            "sourceName" => sn = attr_val(attr)?,
            _ => {}
        }
    }
    let val = if rt.as_ref() == "HKCategoryTypeIdentifierSleepAnalysis" {
        sleep_stage(rv.as_ref())
    } else if rt.starts_with("HKQuantity") {
        parse_js_num(Some(rv.as_ref())).unwrap_or(0.0)
    } else {
        1.0
    };
    Ok(RawRecord {
        rt,
        u,
        val,
        sd,
        ed,
        sn,
    })
}

fn emit_record_fields<S: HealthSink>(
    sink: &mut S,
    rt: &str,
    u: &str,
    value: f64,
    start_date: &str,
    end_date: &str,
    source_name: &str,
) -> Result<(), String> {
    let start_ms = ms_of_str(start_date);
    let end_ms = if end_date == start_date {
        start_ms
    } else {
        ms_of_str(end_date)
    };
    let day = day_of(start_date);
    sink.on_record(&HealthRecordRef {
        type_identifier: rt,
        unit: u,
        value,
        start_date,
        start_ms,
        day: day.as_ref(),
        end_date,
        end_ms,
        source_name,
    })
}

fn parse_me(e: &BytesStart<'_>, me: &mut MeOwned) -> Result<(), String> {
    for attr in e.attributes() {
        let attr = attr.map_err(|err| format!("XML attribute error: {err}"))?;
        match attr.key.as_ref() {
            "HKCharacteristicTypeIdentifierDateOfBirth" => {
                let dob = attr_val(attr)?;
                let b = dob.as_bytes();
                if b.len() == 10
                    && b[4] == b'-'
                    && b[7] == b'-'
                    && b[0..4]
                        .iter()
                        .chain(&b[5..7])
                        .chain(&b[8..10])
                        .all(u8::is_ascii_digit)
                {
                    me.date_of_birth = Some(dob.into_owned());
                }
            }
            "HKCharacteristicTypeIdentifierBiologicalSex" => {
                let sex = attr_val(attr)?;
                if !sex.is_empty() {
                    me.biological_sex = Some(
                        sex.strip_prefix("HKBiologicalSex")
                            .unwrap_or(sex.as_ref())
                            .to_lowercase(),
                    );
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn parse_summary(e: &BytesStart<'_>) -> Result<SummaryOwned, String> {
    let mut dc = String::new();
    let mut eu: Option<String> = None;
    let mut v: [Option<f64>; 8] = [None; 8];
    for attr in e.attributes() {
        let attr = attr.map_err(|err| format!("XML attribute error: {err}"))?;
        let key = attr.key;
        let val = attr_val(attr)?;
        match key.as_ref() {
            "dateComponents" => dc = val.into_owned(),
            "activeEnergyBurnedUnit" => eu = Some(val.into_owned()),
            "activeEnergyBurned" => v[0] = parse_js_num(Some(val.as_ref())),
            "activeEnergyBurnedGoal" => v[1] = parse_js_num(Some(val.as_ref())),
            "appleMoveMinutes" => v[2] = parse_js_num(Some(val.as_ref())),
            "appleMoveMinutesGoal" => v[3] = parse_js_num(Some(val.as_ref())),
            "appleExerciseTime" => v[4] = parse_js_num(Some(val.as_ref())),
            "appleExerciseTimeGoal" => v[5] = parse_js_num(Some(val.as_ref())),
            "appleStandHours" => v[6] = parse_js_num(Some(val.as_ref())),
            "appleStandHoursGoal" => v[7] = parse_js_num(Some(val.as_ref())),
            _ => {}
        }
    }
    let day = day_of(&dc).into_owned();
    Ok(SummaryOwned {
        date_components: dc,
        day,
        active_energy_burned: v[0].map(|n| to_kcal_ref(n, eu.as_deref())),
        active_energy_burned_goal: v[1].map(|n| to_kcal_ref(n, eu.as_deref())),
        apple_move_minutes: v[2],
        apple_move_minutes_goal: v[3],
        apple_exercise_time: v[4],
        apple_exercise_time_goal: v[5],
        apple_stand_hours: v[6],
        apple_stand_hours_goal: v[7],
    })
}

fn parse_workout_start(e: &BytesStart<'_>) -> Result<WorkoutBuilder, String> {
    const KEYS: [&str; 10] = [
        "workoutActivityType",
        "startDate",
        "endDate",
        "duration",
        "durationUnit",
        "totalDistance",
        "totalDistanceUnit",
        "totalEnergyBurned",
        "totalEnergyBurnedUnit",
        "sourceName",
    ];
    let mut wb = WorkoutBuilder::default();
    for attr in e.attributes() {
        let attr = attr.map_err(|err| format!("XML attribute error: {err}"))?;
        if let Some(i) = KEYS.iter().position(|&k| k == attr.key.as_ref()) {
            wb.attrs[i] = Some(attr_val(attr)?.into_owned());
        }
    }
    Ok(wb)
}

fn parse_workout_child(e: &BytesStart<'_>, wb: &mut WorkoutBuilder) -> Result<(), String> {
    match e.name().as_ref() {
        "WorkoutStatistics" => {
            let (mut sk, mut stat) = (String::new(), WorkoutStat::default());
            for attr in e.attributes() {
                let attr = attr.map_err(|err| format!("XML attribute error: {err}"))?;
                let (k, val) = (attr.key, attr_val(attr)?);
                match k.as_ref() {
                    "type" => sk = val.into_owned(),
                    "sum" => stat.sum = Some(val.into_owned()),
                    "average" => stat.average = Some(val.into_owned()),
                    "minimum" => stat.minimum = Some(val.into_owned()),
                    "maximum" => stat.maximum = Some(val.into_owned()),
                    "unit" => stat.unit = Some(val.into_owned()),
                    _ => {}
                }
            }
            if !sk.is_empty() {
                wb.stats.insert(sk, stat);
            }
        }
        "MetadataEntry" => {
            let (mut mk, mut mv) = (None, None);
            for attr in e.attributes() {
                let attr = attr.map_err(|err| format!("XML attribute error: {err}"))?;
                let (k, val) = (attr.key, attr_val(attr)?);
                match k.as_ref() {
                    "key" => mk = Some(val.into_owned()),
                    "value" => mv = Some(val.into_owned()),
                    _ => {}
                }
            }
            wb.meta.insert(
                mk.unwrap_or_else(|| "undefined".into()),
                mv.unwrap_or_else(|| "undefined".into()),
            );
        }
        _ => {}
    }
    Ok(())
}

fn finish_workout(wb: WorkoutBuilder) -> Result<WorkoutOwned, String> {
    let [act, sd, ed, dur, dur_u, td, td_u, te, te_u, src] = wb.attrs;
    let (start_date, end_date) = (sd.unwrap_or_default(), ed.unwrap_or_default());
    let any = |n: &str| {
        wb.stats
            .iter()
            .find(|(k, _)| k.to_lowercase().contains(n))
            .map(|(_, v)| v)
    };
    let dist_s = wb
        .stats
        .get("HKQuantityTypeIdentifierDistanceWalkingRunning")
        .or_else(|| any("distance"));
    let eng_s = wb
        .stats
        .get("HKQuantityTypeIdentifierActiveEnergyBurned")
        .or_else(|| any("energyburned"));
    let hr_s = wb
        .stats
        .get("HKQuantityTypeIdentifierHeartRate")
        .or_else(|| any("heartrate"));

    let dist_raw = dist_s
        .and_then(|s| parse_js_num(s.sum.as_deref()))
        .or_else(|| parse_js_num(td.as_deref()));
    let dist_unit = dist_s.and_then(|s| s.unit.as_deref()).or(td_u.as_deref());
    let dist_km = dist_raw.and_then(|v| to_km_ref(v, dist_unit));
    let unsup = dist_raw.is_some()
        && dist_km.is_none()
        && dist_unit.is_some_and(|u| !js_trim(u).is_empty());
    let eng_raw = eng_s
        .and_then(|s| parse_js_num(s.sum.as_deref()))
        .or_else(|| parse_js_num(te.as_deref()));
    let eng_unit = eng_s.and_then(|s| s.unit.as_deref()).or(te_u.as_deref());

    Ok(WorkoutOwned {
        workout_activity_type: act.unwrap_or_else(|| "Unknown".into()),
        start_ms: ms_of_str(&start_date),
        day: day_of(&start_date).into_owned(),
        end_ms: ms_of_str(&end_date),
        start_date,
        end_date,
        duration_seconds: parse_js_num(dur.as_deref()).map(|d| to_seconds_ref(d, dur_u.as_deref())),
        total_distance: dist_km.or(unsup.then_some(dist_raw).flatten()),
        total_distance_unit: if dist_km.is_some() || dist_raw.is_none() {
            Some("km".into())
        } else if unsup {
            dist_unit.map(str::to_string)
        } else {
            None
        },
        total_energy_burned: eng_raw.map(|v| to_kcal_ref(v, eng_unit)),
        total_energy_burned_unit: Some("kcal".into()),
        avg_hr: hr_s.and_then(|s| parse_js_num(s.average.as_deref())),
        min_hr: hr_s.and_then(|s| parse_js_num(s.minimum.as_deref())),
        max_hr: hr_s.and_then(|s| parse_js_num(s.maximum.as_deref())),
        source_name: src,
        metadata_json: (!wb.meta.is_empty())
            .then(|| serde_json::to_string(&wb.meta).map_err(|e| e.to_string()))
            .transpose()?,
    })
}

/// Stream-parse Apple Health XML from any `BufRead`, invoking `sink` as rows complete.
pub fn stream_health_xml<R: BufRead, S: HealthSink>(
    reader: R,
    sink: &mut S,
) -> Result<MeOwned, String> {
    let mut xml = Reader::from_reader(reader);
    xml.config_mut().check_end_names = true;
    xml.config_mut().check_comments = true;

    let mut buf = Vec::with_capacity(8 * 1024);
    let (mut depth, mut in_corr) = (0usize, false);
    let (mut workout, mut pending_rec, mut me) = (
        None::<WorkoutBuilder>,
        None::<PendingRecord>,
        MeOwned::default(),
    );

    loop {
        buf.clear();
        match xml.read_event_into(&mut buf) {
            Ok(Event::Empty(e)) => match e.name().as_ref() {
                "Correlation" => {}
                "Me" => parse_me(&e, &mut me)?,
                _ if workout.is_some() => parse_workout_child(&e, workout.as_mut().unwrap())?,
                _ if in_corr => {}
                "Record" => {
                    let r = parse_record_attrs(&e)?;
                    emit_record_fields(
                        sink,
                        &r.rt,
                        &r.u,
                        r.val,
                        &r.sd,
                        r.ed.as_deref().unwrap_or(&r.sd),
                        &r.sn,
                    )?;
                }
                "ActivitySummary" => sink.on_summary(parse_summary(&e)?)?,
                "Workout" => sink.on_workout(finish_workout(parse_workout_start(&e)?)?)?,
                _ => {}
            },
            Ok(Event::Start(e)) => {
                depth += 1;
                match e.name().as_ref() {
                    "Correlation" => in_corr = true,
                    "Me" => parse_me(&e, &mut me)?,
                    _ if workout.is_some() => parse_workout_child(&e, workout.as_mut().unwrap())?,
                    _ if in_corr => {}
                    "Workout" => workout = Some(parse_workout_start(&e)?),
                    "ActivitySummary" => sink.on_summary(parse_summary(&e)?)?,
                    "Record" => {
                        let r = parse_record_attrs(&e)?;
                        let start_date = r.sd.into_owned();
                        let end_date = r.ed.map_or_else(|| start_date.clone(), Cow::into_owned);
                        pending_rec = Some(PendingRecord {
                            type_identifier: r.rt.into_owned(),
                            unit: r.u.into_owned(),
                            value: r.val,
                            start_date,
                            end_date,
                            source_name: r.sn.into_owned(),
                        });
                    }
                    _ => {}
                }
            }
            Ok(Event::End(e)) => {
                if depth == 0 {
                    return Err("Unexpected close tag".into());
                }
                depth -= 1;
                match e.name().as_ref() {
                    "Correlation" => in_corr = false,
                    "Workout" => {
                        if let Some(wb) = workout.take() {
                            sink.on_workout(finish_workout(wb)?)?;
                        }
                    }
                    "Record" => {
                        if let Some(r) = pending_rec.take() {
                            emit_record_fields(
                                sink,
                                &r.type_identifier,
                                &r.unit,
                                r.value,
                                &r.start_date,
                                &r.end_date,
                                &r.source_name,
                            )?;
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(e))
                if depth == 0 && e.as_ref().bytes().any(|b| !b.is_ascii_whitespace()) =>
            {
                return Err("Text data outside of root node.".into());
            }
            Ok(Event::Eof) => {
                if depth > 0 {
                    return Err("Unclosed root tag".into());
                }
                break;
            }
            Ok(_) => {}
            Err(err) => return Err(format!("XML parse error: {err}")),
        }
    }
    Ok(me)
}

#[inline]
fn opt_n(v: Option<f64>) -> Value {
    v.map_or_else(js::undefined, js::number)
}
#[inline]
fn opt_s(v: Option<String>) -> Value {
    v.map_or_else(js::undefined, Value::String)
}

struct JsonCollectSink {
    records: Vec<Value>,
    workouts: Vec<Value>,
    summaries: Vec<Value>,
}

impl HealthSink for JsonCollectSink {
    fn on_record(&mut self, r: &HealthRecordRef<'_>) -> Result<(), String> {
        let mut m = Map::with_capacity(9);
        m.insert("typeIdentifier".into(), r.type_identifier.into());
        m.insert("unit".into(), r.unit.into());
        m.insert("value".into(), js::number(r.value));
        m.insert("startDate".into(), r.start_date.into());
        m.insert("startMs".into(), js::number(r.start_ms));
        m.insert("day".into(), r.day.into());
        m.insert("endDate".into(), r.end_date.into());
        m.insert("endMs".into(), js::number(r.end_ms));
        m.insert("sourceName".into(), r.source_name.into());
        self.records.push(Value::Object(m));
        Ok(())
    }

    fn on_workout(&mut self, w: WorkoutOwned) -> Result<(), String> {
        self.workouts.push(json!({
            "workoutActivityType": w.workout_activity_type,
            "startDate": w.start_date, "startMs": js::number(w.start_ms), "day": w.day,
            "endDate": w.end_date, "endMs": js::number(w.end_ms),
            "durationSeconds": opt_n(w.duration_seconds),
            "totalDistance": opt_n(w.total_distance), "totalDistanceUnit": opt_s(w.total_distance_unit),
            "totalEnergyBurned": opt_n(w.total_energy_burned), "totalEnergyBurnedUnit": opt_s(w.total_energy_burned_unit),
            "avgHr": opt_n(w.avg_hr), "minHr": opt_n(w.min_hr), "maxHr": opt_n(w.max_hr),
            "sourceName": opt_s(w.source_name), "metadataJson": opt_s(w.metadata_json),
        }));
        Ok(())
    }

    fn on_summary(&mut self, s: SummaryOwned) -> Result<(), String> {
        self.summaries.push(json!({
            "dateComponents": s.date_components, "day": s.day,
            "activeEnergyBurned": opt_n(s.active_energy_burned), "activeEnergyBurnedGoal": opt_n(s.active_energy_burned_goal),
            "appleMoveMinutes": opt_n(s.apple_move_minutes), "appleMoveMinutesGoal": opt_n(s.apple_move_minutes_goal),
            "appleExerciseTime": opt_n(s.apple_exercise_time), "appleExerciseTimeGoal": opt_n(s.apple_exercise_time_goal),
            "appleStandHours": opt_n(s.apple_stand_hours), "appleStandHoursGoal": opt_n(s.apple_stand_hours_goal),
        }));
        Ok(())
    }
}

/// Port of `parseHealthXml` (`src/lib/xml.ts:285`).
pub fn parse_health_xml(xml: String) -> Result<Value, String> {
    let mut sink = JsonCollectSink {
        records: Vec::new(),
        workouts: Vec::new(),
        summaries: Vec::new(),
    };
    let me = stream_health_xml(Cursor::new(xml.as_bytes()), &mut sink)?;
    let mut me_map = Map::new();
    if let Some(dob) = me.date_of_birth {
        me_map.insert("dateOfBirth".into(), dob.into());
    }
    if let Some(sex) = me.biological_sex {
        me_map.insert("biologicalSex".into(), sex.into());
    }
    Ok(
        json!({ "records": sink.records, "workouts": sink.workouts, "summaries": sink.summaries, "me": me_map }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_apple_health_xml() {
        assert_eq!(ms_of_str(""), 0.0);
        assert_eq!(ms_of_str("2026-09-01 07:30:00 +0800"), 1_788_219_000_000.0);
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?><HealthData>
          <Me HKCharacteristicTypeIdentifierDateOfBirth="1995-04-12" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale"/>
          <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" value="not-a-number" startDate="2026-01-01 07:00:00 +0800" endDate="2026-01-01 07:00:00 +0800" sourceName="Scale"/>
          <ActivitySummary dateComponents="2026-01-01" activeEnergyBurned="1000" activeEnergyBurnedUnit="kJ"/>
          <Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Watch" startDate="2026-01-05 06:00:00 +0800" endDate="2026-01-05 06:30:00 +0800" duration="30" durationUnit="min">
            <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="3.106856" unit="mi"/>
          </Workout>
        </HealthData>"#;
        let parsed = parse_health_xml(xml.into()).unwrap();
        assert_eq!(parsed["records"][0]["value"], 0);
        assert!((parsed["workouts"][0]["totalDistance"].as_f64().unwrap() - 5.0).abs() < 1e-4);
        assert_eq!(parsed["me"]["dateOfBirth"], "1995-04-12");
    }
}
