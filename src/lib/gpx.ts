/**
 * Lightweight, zero-dependency parser for Apple Health GPX workout routes
 * (`workout-routes/route_*.gpx`). Computes Haversine distance, smoothed elevation
 * gain/loss, per-km splits, and a compact simplified polyline for offline SVG rendering.
 */

export type RoutePoint = [number, number, number?]; // [lat, lon, ele?]
export type RouteSplit = { km: number; paceMinPerKm: number; eleDeltaM: number };

export type ParsedGpxRoute = {
  filename: string;
  day: string;
  startMs: number;
  endMs: number;
  pointCount: number;
  distanceKm: number;
  elevationGainM: number;
  elevationLossM: number;
  polyline: RoutePoint[];
  splits: RouteSplit[];
};

const EARTH_RADIUS_M = 6_371_000;
const DEG_TO_RAD = Math.PI / 180;

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function roundCoord(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

const TRKPT_RE = /<trkpt\s+([^>]+)>([\s\S]*?)<\/trkpt>/gi;
const LAT_RE = /\blat="([^"]+)"/i;
const LON_RE = /\blon="([^"]+)"/i;
const ELE_RE = /<ele>([^<]+)<\/ele>/i;
const TIME_RE = /<time>([^<]+)<\/time>/i;

/** Parse a GPX string into summary stats, per-km splits, and a simplified polyline (≤ 240 pts). */
export function parseGpxRoute(xml: string, filename: string): ParsedGpxRoute | null {
  type RawPt = { lat: number; lon: number; ele: number | null; ms: number };
  const pts: RawPt[] = [];

  TRKPT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TRKPT_RE.exec(xml)) !== null) {
    const attrs = match[1];
    const body = match[2];
    const latMatch = LAT_RE.exec(attrs);
    const lonMatch = LON_RE.exec(attrs);
    const timeMatch = TIME_RE.exec(body);
    if (!latMatch || !lonMatch || !timeMatch) continue;
    const lat = Number(latMatch[1]);
    const lon = Number(lonMatch[1]);
    const ms = Date.parse(timeMatch[1].trim());
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(ms)) continue;
    const eleMatch = ELE_RE.exec(body);
    const eleRaw = eleMatch ? Number(eleMatch[1]) : NaN;
    pts.push({ lat, lon, ele: Number.isFinite(eleRaw) ? eleRaw : null, ms });
  }

  if (pts.length < 2) return null;

  let totalMeters = 0;
  let elevationGainM = 0;
  let elevationLossM = 0;
  let lastEleAnchor = pts[0].ele;

  const splits: RouteSplit[] = [];
  let splitStartDist = 0;
  let splitStartMs = pts[0].ms;
  let splitStartEle = pts[0].ele;
  let nextKm = 1;

  for (let i = 1; i < pts.length; i += 1) {
    const prev = pts[i - 1];
    const curr = pts[i];
    const seg = haversineMeters(prev.lat, prev.lon, curr.lat, curr.lon);
    // Ignore impossible GPS teleports (> 100 m/s) while keeping normal running/cycling points.
    const dtSec = Math.max(1, (curr.ms - prev.ms) / 1000);
    if (seg / dtSec <= 100) {
      totalMeters += seg;
    }

    if (curr.ele !== null) {
      if (lastEleAnchor === null) {
        lastEleAnchor = curr.ele;
      } else {
        const diff = curr.ele - lastEleAnchor;
        // 2 m hysteresis smooths Apple Watch barometric/GPS altitude jitter.
        if (diff >= 2) {
          elevationGainM += diff;
          lastEleAnchor = curr.ele;
        } else if (diff <= -2) {
          elevationLossM += Math.abs(diff);
          lastEleAnchor = curr.ele;
        }
      }
    }

    while (totalMeters >= nextKm * 1000) {
      const elapsedMin = (curr.ms - splitStartMs) / 60_000;
      const splitKm = (totalMeters - splitStartDist) / 1000;
      const pace = splitKm > 0 && elapsedMin > 0 ? elapsedMin / splitKm : 0;
      const eleDelta =
        curr.ele !== null && splitStartEle !== null ? curr.ele - splitStartEle : 0;
      if (pace > 0 && pace < 60) {
        splits.push({
          km: nextKm,
          paceMinPerKm: Math.round(pace * 100) / 100,
          eleDeltaM: round1(eleDelta),
        });
      }
      splitStartDist = totalMeters;
      splitStartMs = curr.ms;
      splitStartEle = curr.ele;
      nextKm += 1;
    }
  }

  // Uniformly downsample polyline to at most 240 points, always preserving first and last.
  const MAX_POLYLINE = 240;
  const step = pts.length <= MAX_POLYLINE ? 1 : (pts.length - 1) / (MAX_POLYLINE - 1);
  const polyline: RoutePoint[] = [];
  const count = Math.min(pts.length, MAX_POLYLINE);
  for (let i = 0; i < count; i += 1) {
    const idx = i === count - 1 ? pts.length - 1 : Math.round(i * step);
    const pt = pts[idx];
    polyline.push(
      pt.ele === null
        ? [roundCoord(pt.lat), roundCoord(pt.lon)]
        : [roundCoord(pt.lat), roundCoord(pt.lon), round1(pt.ele)],
    );
  }

  const startMs = pts[0].ms;
  const endMs = pts[pts.length - 1].ms;
  const baseName = filename.split("/").pop() ?? filename;
  const dateFromName = baseName.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
  const day = dateFromName ?? new Date(startMs).toISOString().slice(0, 10);

  return {
    filename: baseName,
    day,
    startMs,
    endMs,
    pointCount: pts.length,
    distanceKm: Math.round((totalMeters / 1000) * 1000) / 1000,
    elevationGainM: round1(elevationGainM),
    elevationLossM: round1(elevationLossM),
    polyline,
    splits,
  };
}
