//! Pure Rust ports of `src/lib/gpx.ts` (`parseGpxRoute`) and `src/lib/ecg.ts` (`parseEcgCsv`)
//! used by the streaming Rust ingest hot loop.

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::f64::consts::PI;

use xml_rs::js;
use xml_rs::port::{format_utc_day, js_trim, parse_date_fallback, parse_js_num};

const EARTH_RADIUS_M: f64 = 6_371_000.0;
const DEG_TO_RAD: f64 = PI / 180.0;

pub struct ParsedGpxRoute {
    pub filename: String,
    pub day: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub point_count: i64,
    pub distance_km: f64,
    pub elevation_gain_m: f64,
    pub elevation_loss_m: f64,
    pub polyline_json: String,
    pub splits_json: String,
}

pub struct ParsedEcg {
    pub filename: String,
    pub recorded_at: String,
    pub recorded_at_ms: i64,
    pub day: String,
    pub classification: String,
    pub avg_hr: Option<f64>,
    pub sampling_hz: f64,
    pub unit: String,
    pub sample_count: i64,
    pub samples_json: String,
    pub symptoms: Option<String>,
    pub device: Option<String>,
}

#[inline]
fn haversine_meters(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let d_lat = (lat2 - lat1) * DEG_TO_RAD;
    let d_lon = (lon2 - lon1) * DEG_TO_RAD;
    let sin_lat = (d_lat / 2.0).sin();
    let sin_lon = (d_lon / 2.0).sin();
    let a = sin_lat * sin_lat
        + (lat1 * DEG_TO_RAD).cos() * (lat2 * DEG_TO_RAD).cos() * sin_lon * sin_lon;
    2.0 * EARTH_RADIUS_M * a.sqrt().atan2((1.0 - a).sqrt())
}

#[inline]
fn round_coord(v: f64) -> f64 {
    js::math_round(v * 100_000.0) / 100_000.0
}

#[inline]
fn round1(v: f64) -> f64 {
    js::math_round(v * 10.0) / 10.0
}

fn find_ascii_ci(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from + needle.len() > haystack.len() {
        return None;
    }
    let last = haystack.len() - needle.len();
    (from..=last).find(|&i| haystack[i..i + needle.len()].eq_ignore_ascii_case(needle))
}

fn extract_attr<'a>(attrs: &'a str, name: &[u8]) -> Option<&'a str> {
    let b = attrs.as_bytes();
    let mut pos = 0;
    while let Some(idx) = find_ascii_ci(b, name, pos) {
        let word_boundary_ok =
            idx == 0 || !(b[idx - 1].is_ascii_alphanumeric() || b[idx - 1] == b'_');
        let after = idx + name.len();
        if word_boundary_ok && after + 2 <= b.len() && b[after] == b'=' && b[after + 1] == b'"' {
            let val_start = after + 2;
            if let Some(rel_end) = b[val_start..].iter().position(|&c| c == b'"')
                && rel_end > 0
            {
                return Some(&attrs[val_start..val_start + rel_end]);
            }
        }
        pos = idx + 1;
    }
    None
}

fn extract_tag_text<'a>(body: &'a str, open: &[u8], close: &[u8]) -> Option<&'a str> {
    let b = body.as_bytes();
    let start_tag = find_ascii_ci(b, open, 0)?;
    let content_start = start_tag + open.len();
    let end_tag = find_ascii_ci(b, close, content_start)?;
    let slice = &body[content_start..end_tag];
    if slice.is_empty() || slice.contains('<') {
        return None;
    }
    Some(slice)
}

fn find_date_ymd(s: &str) -> Option<&str> {
    let b = s.as_bytes();
    if b.len() < 10 {
        return None;
    }
    for i in 0..=b.len() - 10 {
        if b[i + 4] == b'-'
            && b[i + 7] == b'-'
            && b[i..i + 4].iter().all(u8::is_ascii_digit)
            && b[i + 5..i + 7].iter().all(u8::is_ascii_digit)
            && b[i + 8..i + 10].iter().all(u8::is_ascii_digit)
        {
            return Some(&s[i..i + 10]);
        }
    }
    None
}

/// Exact port of `parseGpxRoute` (`src/lib/gpx.ts:50`).
pub fn parse_gpx_route(xml: &str, filename: &str) -> Option<ParsedGpxRoute> {
    struct RawPt {
        lat: f64,
        lon: f64,
        ele: Option<f64>,
        ms: f64,
    }

    let b = xml.as_bytes();
    let mut pts: Vec<RawPt> = Vec::new();
    let mut cursor = 0usize;

    while let Some(tag_start) = find_ascii_ci(b, b"<trkpt", cursor) {
        let after_name = tag_start + 6;
        if after_name >= b.len() || !b[after_name].is_ascii_whitespace() {
            cursor = after_name;
            continue;
        }
        let gt = after_name + b[after_name..].iter().position(|&c| c == b'>')?;
        let close_start = find_ascii_ci(b, b"</trkpt>", gt + 1)?;
        cursor = close_start + 8;

        let attrs = &xml[after_name..gt];
        let body = &xml[gt + 1..close_start];

        let (Some(lat_s), Some(lon_s), Some(time_s)) = (
            extract_attr(attrs, b"lat"),
            extract_attr(attrs, b"lon"),
            extract_tag_text(body, b"<time>", b"</time>"),
        ) else {
            continue;
        };

        let (Some(lat), Some(lon)) = (parse_js_num(Some(lat_s)), parse_js_num(Some(lon_s))) else {
            continue;
        };
        let ms = parse_date_fallback(time_s);
        if !ms.is_finite() {
            continue;
        }
        let ele = extract_tag_text(body, b"<ele>", b"</ele>").and_then(|s| parse_js_num(Some(s)));
        pts.push(RawPt { lat, lon, ele, ms });
    }

    if pts.len() < 2 {
        return None;
    }

    let mut total_meters = 0.0f64;
    let mut elevation_gain_m = 0.0f64;
    let mut elevation_loss_m = 0.0f64;
    let mut last_ele_anchor = pts[0].ele;

    let mut splits: Vec<(u32, f64, f64)> = Vec::new();
    let mut split_start_dist = 0.0f64;
    let mut split_start_ms = pts[0].ms;
    let mut split_start_ele = pts[0].ele;
    let mut next_km: u32 = 1;

    for i in 1..pts.len() {
        let prev = &pts[i - 1];
        let curr = &pts[i];
        let seg = haversine_meters(prev.lat, prev.lon, curr.lat, curr.lon);
        let dt_sec = ((curr.ms - prev.ms) / 1000.0).max(1.0);
        if seg / dt_sec <= 100.0 {
            total_meters += seg;
        }

        if let Some(curr_ele) = curr.ele {
            match last_ele_anchor {
                None => last_ele_anchor = Some(curr_ele),
                Some(anchor) => {
                    let diff = curr_ele - anchor;
                    if diff >= 2.0 {
                        elevation_gain_m += diff;
                        last_ele_anchor = Some(curr_ele);
                    } else if diff <= -2.0 {
                        elevation_loss_m += diff.abs();
                        last_ele_anchor = Some(curr_ele);
                    }
                }
            }
        }

        while total_meters >= f64::from(next_km) * 1000.0 {
            let elapsed_min = (curr.ms - split_start_ms) / 60_000.0;
            let split_km = (total_meters - split_start_dist) / 1000.0;
            let pace = if split_km > 0.0 && elapsed_min > 0.0 {
                elapsed_min / split_km
            } else {
                0.0
            };
            let ele_delta = match (curr.ele, split_start_ele) {
                (Some(c), Some(s)) => c - s,
                _ => 0.0,
            };
            if pace > 0.0 && pace < 60.0 {
                splits.push((
                    next_km,
                    js::math_round(pace * 100.0) / 100.0,
                    round1(ele_delta),
                ));
            }
            split_start_dist = total_meters;
            split_start_ms = curr.ms;
            split_start_ele = curr.ele;
            next_km += 1;
        }
    }

    const MAX_POLYLINE: usize = 240;
    let count = pts.len().min(MAX_POLYLINE);
    let step = if pts.len() <= MAX_POLYLINE {
        1.0
    } else {
        (pts.len() - 1) as f64 / (MAX_POLYLINE - 1) as f64
    };

    let mut polyline_json = String::with_capacity(count * 26 + 2);
    polyline_json.push('[');
    for i in 0..count {
        if i > 0 {
            polyline_json.push(',');
        }
        let idx = if i == count - 1 {
            pts.len() - 1
        } else {
            js::math_round(i as f64 * step) as usize
        };
        let pt = &pts[idx];
        polyline_json.push('[');
        polyline_json.push_str(&js::number_to_string(round_coord(pt.lat)));
        polyline_json.push(',');
        polyline_json.push_str(&js::number_to_string(round_coord(pt.lon)));
        if let Some(ele) = pt.ele {
            polyline_json.push(',');
            polyline_json.push_str(&js::number_to_string(round1(ele)));
        }
        polyline_json.push(']');
    }
    polyline_json.push(']');

    let mut splits_json = String::with_capacity(splits.len() * 48 + 2);
    splits_json.push('[');
    for (i, (km, pace, ele_delta)) in splits.iter().enumerate() {
        if i > 0 {
            splits_json.push(',');
        }
        splits_json.push_str(r#"{"km":"#);
        splits_json.push_str(&km.to_string());
        splits_json.push_str(r#","paceMinPerKm":"#);
        splits_json.push_str(&js::number_to_string(*pace));
        splits_json.push_str(r#","eleDeltaM":"#);
        splits_json.push_str(&js::number_to_string(*ele_delta));
        splits_json.push('}');
    }
    splits_json.push(']');

    let start_ms = pts[0].ms;
    let end_ms = pts[pts.len() - 1].ms;
    let base_name = filename.rsplit('/').next().unwrap_or(filename).to_string();
    let day = find_date_ymd(&base_name)
        .map(str::to_string)
        .unwrap_or_else(|| format_utc_day(start_ms));

    Some(ParsedGpxRoute {
        filename: base_name,
        day,
        start_ms: start_ms as i64,
        end_ms: end_ms as i64,
        point_count: pts.len() as i64,
        distance_km: js::math_round((total_meters / 1000.0) * 1000.0) / 1000.0,
        elevation_gain_m: round1(elevation_gain_m),
        elevation_loss_m: round1(elevation_loss_m),
        polyline_json,
        splits_json,
    })
}

fn strip_outer_quotes(s: &str) -> &str {
    s.strip_prefix('"')
        .unwrap_or(s)
        .strip_suffix('"')
        .unwrap_or(s.strip_prefix('"').unwrap_or(s))
}

fn is_signed_int(s: &str) -> bool {
    let s = s.strip_prefix('-').unwrap_or(s);
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn is_unsigned_int(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn extract_first_number(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_digit() {
            let start = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            if i + 1 < b.len() && b[i] == b'.' && b[i + 1].is_ascii_digit() {
                i += 1;
                while i < b.len() && b[i].is_ascii_digit() {
                    i += 1;
                }
            }
            return s[start..i].parse::<f64>().ok().filter(|n| n.is_finite());
        }
        i += 1;
    }
    None
}

fn downsample_envelope(raw: &[f64], max_points: usize) -> Vec<f64> {
    if raw.len() <= max_points {
        return raw.iter().map(|&v| round1(v)).collect();
    }
    let buckets = max_points / 2;
    let mut out = Vec::with_capacity(buckets * 2);
    for b in 0..buckets {
        let start = (b * raw.len()) / buckets;
        let end = (((b + 1) * raw.len()) / buckets).max(start + 1);
        let mut min = raw[start];
        let mut max = raw[start];
        let mut min_idx = start;
        let mut max_idx = start;
        for (i, &v) in raw.iter().enumerate().take(end).skip(start + 1) {
            if v < min {
                min = v;
                min_idx = i;
            }
            if v > max {
                max = v;
                max_idx = i;
            }
        }
        if min_idx <= max_idx {
            out.push(round1(min));
            out.push(round1(max));
        } else {
            out.push(round1(max));
            out.push(round1(min));
        }
    }
    out
}

fn estimate_hr_bpm(raw: &[f64], sampling_hz: f64) -> Option<f64> {
    if (raw.len() as f64) < sampling_hz * 4.0 || sampling_hz <= 0.0 {
        return None;
    }
    let mean = raw.iter().sum::<f64>() / raw.len() as f64;
    let peak = raw.iter().fold(0.0f64, |acc, &v| acc.max(v - mean));
    if peak < 50.0 {
        return None;
    }
    let threshold = mean + peak * 0.52;
    let refractory = (js::math_round(sampling_hz * 0.3) as usize).max(1);
    let mut peaks: Vec<usize> = Vec::new();
    let mut i = 1usize;
    while i + 1 < raw.len() {
        if raw[i] > threshold && raw[i] >= raw[i - 1] && raw[i] >= raw[i + 1] {
            peaks.push(i);
            i += refractory;
        } else {
            i += 1;
        }
    }
    if peaks.len() < 3 {
        return None;
    }
    let mut intervals: Vec<f64> = peaks
        .windows(2)
        .map(|w| (w[1] - w[0]) as f64 / sampling_hz)
        .filter(|sec| (0.3..=2.0).contains(sec))
        .collect();
    if intervals.len() < 2 {
        return None;
    }
    intervals.sort_by(f64::total_cmp);
    let bpm = 60.0 / intervals[intervals.len() / 2];
    (30.0..=220.0).contains(&bpm).then(|| js::math_round(bpm))
}

/// Exact port of `parseEcgCsv` (`src/lib/ecg.ts:116`).
pub fn parse_ecg_csv(csv: &str, filename: &str, now_ms: i64) -> Option<ParsedEcg> {
    let mut meta: HashMap<String, String> = HashMap::new();
    let mut raw_samples: Vec<f64> = Vec::new();

    for raw_line in csv.lines() {
        let line = js_trim(raw_line);
        if line.is_empty() {
            continue;
        }
        let Some(comma) = line.find(',') else {
            if let Some(n) = parse_js_num(Some(line)) {
                raw_samples.push(n);
            }
            continue;
        };
        let key = strip_outer_quotes(js_trim(&line[..comma]));
        let val = strip_outer_quotes(js_trim(&line[comma + 1..]));
        if is_signed_int(key) && is_unsigned_int(val) {
            let combined = format!("{key}.{val}");
            if let Some(n) = parse_js_num(Some(&combined)) {
                raw_samples.push(n);
            }
            continue;
        }
        meta.insert(key.to_lowercase(), val.to_string());
    }

    if raw_samples.is_empty() && meta.is_empty() {
        return None;
    }

    let base_name = filename.rsplit('/').next().unwrap_or(filename).to_string();
    let recorded_at = meta.get("recorded date").cloned().unwrap_or_default();
    let recorded_at_ms = if recorded_at.is_empty() {
        now_ms
    } else {
        let parsed = parse_date_fallback(&recorded_at);
        if parsed.is_finite() {
            parsed as i64
        } else {
            now_ms
        }
    };

    let day = if recorded_at.len() >= 10 && find_date_ymd(&recorded_at[..10]).is_some() {
        recorded_at[..10].to_string()
    } else if let Some(d) = find_date_ymd(&base_name) {
        d.to_string()
    } else {
        format_utc_day(recorded_at_ms as f64)
    };

    let sampling_hz_raw = meta
        .get("sample rate")
        .and_then(|s| extract_first_number(s))
        .unwrap_or(512.0);
    let sampling_hz = if sampling_hz_raw.is_finite() && sampling_hz_raw > 0.0 {
        sampling_hz_raw
    } else {
        512.0
    };

    let avg_hr = meta
        .get("average heart rate")
        .and_then(|s| extract_first_number(s))
        .or_else(|| estimate_hr_bpm(&raw_samples, sampling_hz));

    let opt_meta = |k: &str| {
        meta.get(k)
            .map(|s| js_trim(s))
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };

    let samples = downsample_envelope(&raw_samples, 600);
    let mut samples_json = String::with_capacity(samples.len() * 7 + 2);
    samples_json.push('[');
    for (i, &v) in samples.iter().enumerate() {
        if i > 0 {
            samples_json.push(',');
        }
        samples_json.push_str(&js::number_to_string(v));
    }
    samples_json.push(']');

    Some(ParsedEcg {
        filename: base_name,
        recorded_at: if recorded_at.is_empty() {
            day.clone()
        } else {
            recorded_at
        },
        recorded_at_ms,
        day,
        classification: opt_meta("classification").unwrap_or_else(|| "Unknown".to_string()),
        avg_hr,
        sampling_hz,
        unit: opt_meta("unit").unwrap_or_else(|| "µV".to_string()),
        sample_count: raw_samples.len() as i64,
        samples_json,
        symptoms: opt_meta("symptoms"),
        device: opt_meta("device"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpx_matches_phase5_test() {
        let mut pts = String::new();
        for i in 0..12 {
            let lat = format!("{:.6}", 37.77 + f64::from(i) * 0.001);
            let ele = format!("{:.1}", 10.0 + f64::from(i) * 3.0);
            let sec = i * 30;
            pts.push_str(&format!(
                r#"<trkpt lon="-122.420000" lat="{lat}"><ele>{ele}</ele><time>2026-09-19T09:{:02}:{:02}Z</time></trkpt>"#,
                sec / 60,
                sec % 60,
            ));
            pts.push('\n');
        }
        let xml = format!(r#"<?xml version="1.0"?><gpx><trk><trkseg>{pts}</trkseg></trk></gpx>"#);
        let parsed = parse_gpx_route(
            &xml,
            "apple_health_export/workout-routes/route_2026-09-19_09.00am.gpx",
        )
        .unwrap();
        assert_eq!(parsed.filename, "route_2026-09-19_09.00am.gpx");
        assert_eq!(parsed.day, "2026-09-19");
        assert_eq!(parsed.point_count, 12);
        assert!(parsed.distance_km > 1.1 && parsed.distance_km < 1.3);
        assert!(parsed.elevation_gain_m > 25.0);
        assert!(parsed.splits_json.contains(r#""km":1"#));
    }

    #[test]
    fn ecg_matches_phase5_test() {
        let mut lines = vec![
            "Name,Test User".to_string(),
            "Recorded Date,2026-05-26 09:00:00 +0000".to_string(),
            "Classification,Sinus Rhythm".to_string(),
            "Symptoms,".to_string(),
            r#"Device,"Watch6,1""#.to_string(),
            "Sample Rate,512 hertz".to_string(),
            "Lead,Lead I".to_string(),
            "Unit,µV".to_string(),
            String::new(),
        ];
        for i in 0..512 * 5 {
            lines.push(if i % 512 == 256 { "600.0" } else { "0.0" }.to_string());
        }
        let csv = lines.join("\n");
        let parsed = parse_ecg_csv(
            &csv,
            "apple_health_export/electrocardiograms/ecg_2026-05-26.csv",
            1_700_000_000_000,
        )
        .unwrap();
        assert_eq!(parsed.day, "2026-05-26");
        assert_eq!(parsed.classification, "Sinus Rhythm");
        assert_eq!(parsed.device.as_deref(), Some("Watch6,1"));
        assert_eq!(parsed.sampling_hz, 512.0);
        assert_eq!(parsed.sample_count, 2560);
        assert_eq!(parsed.avg_hr, Some(60.0));
    }
}
