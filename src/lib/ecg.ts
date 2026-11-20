/**
 * Parser for Apple Watch ECG CSV recordings (`electrocardiograms/ecg_*.csv`).
 *
 * Extracts metadata headers (Recorded Date, Classification, Symptoms, Device, Sample Rate, Unit)
 * and downsamples the ~15,360-point 512 Hz waveform using min/max envelope preservation so QRS
 * complexes remain crisp in an SVG/Recharts viewer without storing megabytes per recording.
 */

export type ParsedEcg = {
  filename: string;
  recordedAt: string;
  recordedAtMs: number;
  day: string;
  classification: string;
  avgHr: number | null;
  samplingHz: number;
  unit: string;
  sampleCount: number;
  samples: number[];
  symptoms: string | null;
  device: string | null;
};

function parseCsvPair(line: string): [string, string] | null {
  const comma = line.indexOf(",");
  if (comma === -1) return null;
  const key = line.slice(0, comma).trim().replace(/^"|"$/g, "");
  const val = line.slice(comma + 1).trim().replace(/^"|"$/g, "");
  return [key, val];
}

function parseAppleDateMs(raw: string): number {
  // Apple format: "2026-05-26 15:07:24 +0800"
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s*([+-]\d{2})(\d{2})$/);
  if (m) {
    const iso = `${m[1]}T${m[2]}${m[3]}:${m[4]}`;
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) return parsed;
  }
  const fallback = Date.parse(raw);
  return Number.isFinite(fallback) ? fallback : Date.now();
}

/**
 * Min/max envelope downsampling: preserves sharp R-wave peaks & S-wave troughs across buckets.
 * Target ~600 samples for a 30-second strip (~20 pts/sec).
 */
function downsampleEnvelope(raw: number[], maxPoints = 600): number[] {
  if (raw.length <= maxPoints) return raw.map((v) => Math.round(v * 10) / 10);
  const buckets = Math.floor(maxPoints / 2);
  const out: number[] = [];
  for (let b = 0; b < buckets; b += 1) {
    const start = Math.floor((b * raw.length) / buckets);
    const end = Math.max(start + 1, Math.floor(((b + 1) * raw.length) / buckets));
    let min = raw[start];
    let max = raw[start];
    let minIdx = start;
    let maxIdx = start;
    for (let i = start + 1; i < end; i += 1) {
      const v = raw[i];
      if (v < min) {
        min = v;
        minIdx = i;
      }
      if (v > max) {
        max = v;
        maxIdx = i;
      }
    }
    if (minIdx <= maxIdx) {
      out.push(Math.round(min * 10) / 10, Math.round(max * 10) / 10);
    } else {
      out.push(Math.round(max * 10) / 10, Math.round(min * 10) / 10);
    }
  }
  return out;
}

/** Simple R-peak estimator when the CSV header omits Average Heart Rate. */
function estimateHrBpm(raw: number[], samplingHz: number): number | null {
  if (raw.length < samplingHz * 4 || samplingHz <= 0) return null;
  let mean = 0;
  for (let i = 0; i < raw.length; i += 1) mean += raw[i];
  mean /= raw.length;
  let peak = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const centered = raw[i] - mean;
    if (centered > peak) peak = centered;
  }
  if (peak < 50) return null;
  const threshold = mean + peak * 0.52;
  const refractory = Math.round(samplingHz * 0.3); // >= 300ms between beats (<= 200 bpm)
  const peaks: number[] = [];
  let i = 1;
  while (i < raw.length - 1) {
    if (raw[i] > threshold && raw[i] >= raw[i - 1] && raw[i] >= raw[i + 1]) {
      peaks.push(i);
      i += refractory;
    } else {
      i += 1;
    }
  }
  if (peaks.length < 3) return null;
  const intervals: number[] = [];
  for (let j = 1; j < peaks.length; j += 1) {
    const sec = (peaks[j] - peaks[j - 1]) / samplingHz;
    if (sec >= 0.3 && sec <= 2.0) intervals.push(sec);
  }
  if (intervals.length < 2) return null;
  intervals.sort((a, b) => a - b);
  const medianSec = intervals[Math.floor(intervals.length / 2)];
  const bpm = 60 / medianSec;
  return bpm >= 30 && bpm <= 220 ? Math.round(bpm) : null;
}

export function parseEcgCsv(csv: string, filename: string): ParsedEcg | null {
  const lines = csv.split(/\r?\n/);
  const meta = new Map<string, string>();
  const rawSamples: number[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // Numeric sample lines have no comma (or a European decimal comma — handle dot floats first)
    if (!line.includes(",")) {
      const num = Number(line);
      if (Number.isFinite(num)) rawSamples.push(num);
      continue;
    }
    const pair = parseCsvPair(line);
    if (!pair) continue;
    const [key, val] = pair;
    // If key itself is numeric (e.g. locale comma decimal "-203,765"), treat as sample.
    if (/^-?\d+$/.test(key) && /^\d+$/.test(val)) {
      const num = Number(`${key}.${val}`);
      if (Number.isFinite(num)) rawSamples.push(num);
      continue;
    }
    meta.set(key.toLowerCase(), val);
  }

  if (rawSamples.length === 0 && meta.size === 0) return null;

  const baseName = filename.split("/").pop() ?? filename;
  const recordedAt = meta.get("recorded date") ?? "";
  const recordedAtMs = recordedAt ? parseAppleDateMs(recordedAt) : Date.now();
  const day =
    recordedAt.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ??
    baseName.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ??
    new Date(recordedAtMs).toISOString().slice(0, 10);

  const sampleRateStr = meta.get("sample rate") ?? "";
  const hzMatch = sampleRateStr.match(/(\d+(?:\.\d+)?)/);
  const samplingHz = hzMatch ? Number(hzMatch[1]) : 512;

  const hrStr = meta.get("average heart rate") ?? "";
  const hrMatch = hrStr.match(/(\d+(?:\.\d+)?)/);
  const avgHr = hrMatch ? Number(hrMatch[1]) : estimateHrBpm(rawSamples, samplingHz);

  const symptoms = meta.get("symptoms")?.trim() || null;
  const device = meta.get("device")?.trim() || null;
  const classification = meta.get("classification")?.trim() || "Unknown";
  const unit = meta.get("unit")?.trim() || "µV";

  return {
    filename: baseName,
    recordedAt: recordedAt || day,
    recordedAtMs,
    day,
    classification,
    avgHr,
    samplingHz: Number.isFinite(samplingHz) && samplingHz > 0 ? samplingHz : 512,
    unit,
    sampleCount: rawSamples.length,
    samples: downsampleEnvelope(rawSamples, 600),
    symptoms,
    device,
  };
}
