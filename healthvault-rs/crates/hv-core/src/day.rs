//! Local-calendar-day arithmetic, ported from `src/lib/day.ts`.
//!
//! Every day boundary in `HealthVault` uses the profile timezone, never SQLite's UTC `date('now')`.
//! Unix milliseconds are `i64`; an out-of-range instant falls back to a zero offset rather than
//! panicking (the same behaviour as the TS `Date` clamp at the edges of its range).

use chrono::{DateTime, Datelike, NaiveDate, Offset, Utc, Weekday};
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, TimezoneName};

pub const DEFAULT_TIMEZONE: &str = "Asia/Shanghai";

/// Validated `YYYY-MM-DD` local calendar day. Impossible dates are rejected, matching
/// `isDay()`'s round-trip check in the TypeScript app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Day(NaiveDate);

impl Day {
    /// Sentinel used when a corrupt database row cannot be parsed; never a valid user day.
    pub fn epoch() -> Self {
        Self(NaiveDate::from_ymd_opt(1970, 1, 1).unwrap_or(NaiveDate::MIN))
    }

    pub fn parse(raw: &str) -> Result<Self, CoreError> {
        let s = raw.trim();
        let parsed = NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .map_err(|_| CoreError::InvalidDay(s.to_owned()))?;
        if parsed.format("%Y-%m-%d").to_string() != s {
            return Err(CoreError::InvalidDay(s.to_owned()));
        }
        Ok(Self(parsed))
    }

    pub fn as_str(&self) -> String {
        self.0.format("%Y-%m-%d").to_string()
    }

    pub fn naive(&self) -> NaiveDate {
        self.0
    }

    /// Epoch millis of this day at local midnight. DST is handled by solving the UTC offset
    /// twice, exactly as `localDayStartMs` does in the TS app.
    pub fn start_ms(&self, tz: &TimezoneName) -> i64 {
        let naive_ms = self
            .naive()
            .and_hms_opt(0, 0, 0)
            .map_or(0, |dt| dt.and_utc().timestamp_millis());
        let first = naive_ms.saturating_sub(offset_at(naive_ms, tz));
        naive_ms.saturating_sub(offset_at(first, tz))
    }

    pub fn end_ms(&self, tz: &TimezoneName) -> i64 {
        self.add(1).start_ms(tz)
    }

    pub fn window_ms(&self, tz: &TimezoneName) -> (i64, i64) {
        (self.start_ms(tz), self.end_ms(tz))
    }

    /// Epoch millis for a wall-clock `HH:mm[:ss]` on this local day.
    pub fn time_ms(&self, clock: &str, tz: &TimezoneName) -> Result<i64, CoreError> {
        let parts: Vec<&str> = clock.split(':').collect();
        if parts.is_empty() || parts.len() > 3 {
            return Err(CoreError::validation("time", "expected HH:mm or HH:mm:ss"));
        }
        let number = |ix: usize| -> Result<u32, CoreError> {
            parts
                .get(ix)
                .and_then(|v| v.parse::<u32>().ok())
                .ok_or_else(|| CoreError::validation("time", "expected HH:mm or HH:mm:ss"))
        };
        let (h, m, s) = (
            number(0)?,
            number(1)?,
            parts
                .get(2)
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(0),
        );
        if h > 23 || m > 59 || s > 59 {
            return Err(CoreError::validation("time", "clock value out of range"));
        }
        let naive_ms = self
            .naive()
            .and_hms_opt(h, m, s)
            .map_or(0, |dt| dt.and_utc().timestamp_millis());
        let first = naive_ms.saturating_sub(offset_at(naive_ms, tz));
        Ok(naive_ms.saturating_sub(offset_at(first, tz)))
    }

    pub fn add(&self, n: i64) -> Self {
        let shifted = self
            .naive()
            .checked_add_signed(chrono::Duration::days(n))
            .unwrap_or(self.naive());
        Self(shifted)
    }

    /// 0 = Sunday … 6 = Saturday, matching `Date#getDay` and Apple's activity summaries.
    pub fn weekday_index(&self) -> u32 {
        match self.naive().weekday() {
            Weekday::Sun => 0,
            Weekday::Mon => 1,
            Weekday::Tue => 2,
            Weekday::Wed => 3,
            Weekday::Thu => 4,
            Weekday::Fri => 5,
            Weekday::Sat => 6,
        }
    }

    pub fn week_start(&self) -> Self {
        self.add(-i64::from(self.weekday_index()))
    }

    pub fn days_until(&self, to: &Day) -> i64 {
        (to.naive() - self.naive()).num_days()
    }
}

impl TryFrom<String> for Day {
    type Error = CoreError;
    fn try_from(raw: String) -> Result<Self, Self::Error> {
        Self::parse(&raw)
    }
}

impl From<Day> for String {
    fn from(day: Day) -> Self {
        day.as_str()
    }
}

impl std::fmt::Display for Day {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0.format("%Y-%m-%d"))
    }
}

fn offset_at(ms: i64, tz: &TimezoneName) -> i64 {
    let Some(instant) = DateTime::<Utc>::from_timestamp_millis(ms) else {
        return 0;
    };
    let local = instant.with_timezone(&tz.tz());
    i64::from(local.offset().fix().local_minus_utc()) * 1_000
}

/// Local calendar day containing an instant (epoch millis) in a zone.
pub fn local_day(ms: i64, tz: &TimezoneName) -> Day {
    let Some(instant) = DateTime::<Utc>::from_timestamp_millis(ms) else {
        return Day(NaiveDate::MIN);
    };
    let local = instant.with_timezone(&tz.tz());
    Day(local.date_naive())
}

/// Newest-last inclusive list of `n` days ending at `end`.
pub fn last_days(n: usize, end: Day) -> Vec<Day> {
    let width = n.max(1);
    (0..width)
        .map(|ix| end.add(ix as i64 - (width as i64 - 1)))
        .collect()
}

/// "HH:mm:ss" in the local zone; `None` renders as an em dash like the TS helper.
pub fn format_clock_seconds(ms: Option<i64>, tz: &TimezoneName) -> String {
    let Some(ms) = ms.filter(|v| *v != 0) else {
        return "—".to_owned();
    };
    let Some(instant) = DateTime::<Utc>::from_timestamp_millis(ms) else {
        return "—".to_owned();
    };
    instant
        .with_timezone(&tz.tz())
        .format("%H:%M:%S")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tz() -> TimezoneName {
        TimezoneName::parse("Asia/Manila").unwrap()
    }

    #[test]
    fn impossible_days_are_rejected() {
        assert!(Day::parse("2026-02-30").is_err());
        assert!(Day::parse("2026-11-17").is_ok());
    }

    #[test]
    fn manila_midnight_is_previous_utc_day_at_16h() {
        let day = Day::parse("2026-11-17").unwrap();
        // 2026-11-17 00:00 +08:00 == 2026-11-16 16:00 UTC
        let utc = DateTime::<Utc>::from_timestamp_millis(day.start_ms(&tz())).unwrap();
        assert_eq!(utc.format("%Y-%m-%d %H:%M").to_string(), "2026-11-16 16:00");
    }

    #[test]
    fn week_is_sunday_based() {
        let tue = Day::parse("2026-11-17").unwrap(); // Tuesday
        assert_eq!(tue.weekday_index(), 2);
        assert_eq!(tue.week_start().as_str(), "2026-11-15");
    }

    #[test]
    fn last_days_is_newest_last_and_inclusive() {
        let days = last_days(3, Day::parse("2026-11-17").unwrap());
        assert_eq!(
            days.iter().map(super::Day::as_str).collect::<Vec<_>>(),
            ["2026-11-15", "2026-11-16", "2026-11-17"]
        );
    }

    #[test]
    fn dst_day_window_is_23_or_25_hours_when_applicable() {
        let zone = TimezoneName::parse("America/New_York").unwrap();
        let spring = Day::parse("2026-03-08").unwrap();
        assert_eq!(
            spring.end_ms(&zone) - spring.start_ms(&zone),
            23 * 3_600_000
        );
        let fall = Day::parse("2026-11-01").unwrap();
        assert_eq!(fall.end_ms(&zone) - fall.start_ms(&zone), 25 * 3_600_000);
    }

    #[test]
    fn instant_maps_back_to_its_local_day() {
        let day = Day::parse("2026-11-17").unwrap();
        let ms = day.start_ms(&tz()) + 3_600_000;
        assert_eq!(local_day(ms, &tz()), day);
    }

    #[test]
    fn time_ms_resolves_wall_clock_in_the_zone() {
        let day = Day::parse("2026-11-17").unwrap();
        let ms = day.time_ms("08:30", &tz()).unwrap();
        assert_eq!(format_clock_seconds(Some(ms), &tz()), "08:30:00");
    }
}
