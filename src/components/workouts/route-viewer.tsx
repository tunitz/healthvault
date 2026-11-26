"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { num } from "@/lib/format";
import { formatDistance, formatPace, type Units } from "@/lib/units";
import type { WorkoutRouteRow } from "@/db/queries";

function buildSvgPath(polyline: [number, number, number?][]): {
  path: string;
  start: [number, number];
  end: [number, number];
} | null {
  if (polyline.length < 2) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const [lat, lon] of polyline) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  const midLatRad = (((minLat + maxLat) / 2) * Math.PI) / 180;
  const lonScale = Math.cos(midLatRad) || 1;
  const spanX = Math.max(1e-5, (maxLon - minLon) * lonScale);
  const spanY = Math.max(1e-5, maxLat - minLat);

  const width = 480;
  const height = 260;
  const pad = 22;
  const drawW = width - pad * 2;
  const drawH = height - pad * 2;
  const scale = Math.min(drawW / spanX, drawH / spanY);
  const offsetX = pad + (drawW - spanX * scale) / 2;
  const offsetY = pad + (drawH - spanY * scale) / 2;

  const project = (lat: number, lon: number): [number, number] => [
    Math.round((offsetX + (lon - minLon) * lonScale * scale) * 10) / 10,
    Math.round((offsetY + (maxLat - lat) * scale) * 10) / 10,
  ];

  const projected = polyline.map(([lat, lon]) => project(lat, lon));
  const path = projected
    .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`)
    .join(" ");
  return {
    path,
    start: projected[0],
    end: projected[projected.length - 1],
  };
}

export function RouteViewer({ route, units }: { route: WorkoutRouteRow; units: Units }) {
  const geom = buildSvgPath(route.polyline);

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border p-4" aria-labelledby="route-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 id="route-heading" className="text-sm font-medium">GPS route</h2>
          <p className="num text-xs text-muted-foreground">
            {formatDistance(route.distanceKm, units, 2)} · +{num(route.elevationGainM, 0)} m / −{num(route.elevationLossM, 0)} m elevation · {route.pointCount.toLocaleString("en-US")} trackpoints
          </p>
        </div>
        <span className="text-xs text-muted-foreground">{route.filename}</span>
      </div>

      {geom ? (
        <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/20 p-2">
          <svg
            viewBox="0 0 480 260"
            role="img"
            aria-label={`GPS workout route map covering ${formatDistance(route.distanceKm, units, 2)}`}
            className="h-56 w-full sm:h-64"
          >
            <g stroke="var(--border)" strokeOpacity="0.45" strokeWidth="1">
              <line x1="0" y1="65" x2="480" y2="65" />
              <line x1="0" y1="130" x2="480" y2="130" />
              <line x1="0" y1="195" x2="480" y2="195" />
              <line x1="120" y1="0" x2="120" y2="260" />
              <line x1="240" y1="0" x2="240" y2="260" />
              <line x1="360" y1="0" x2="360" y2="260" />
            </g>
            <path
              d={geom.path}
              fill="none"
              stroke="var(--chart-1)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx={geom.start[0]} cy={geom.start[1]} r="5" fill="var(--chart-2)" stroke="var(--background)" strokeWidth="2" />
            <circle cx={geom.end[0]} cy={geom.end[1]} r="5" fill="var(--destructive)" stroke="var(--background)" strokeWidth="2" />
          </svg>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-3">
              <span className="inline-flex items-center gap-1">
                <span aria-hidden className="size-2 rounded-full bg-[var(--chart-2)]" /> Start
              </span>
              <span className="inline-flex items-center gap-1">
                <span aria-hidden className="size-2 rounded-full bg-destructive" /> Finish
              </span>
            </span>
            <span>Offline GPS projection</span>
          </div>
        </div>
      ) : null}

      {route.splits.length > 0 ? (
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-medium text-muted-foreground">Per-kilometre splits</h3>
          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={route.splits} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="km"
                  tickFormatter={(v) => `km ${v}`}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  width={46}
                  tickFormatter={(v) => formatPace(Number(v), units).replace(/ \/.*$/, "")}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  formatter={(value) => [formatPace(Number(value), units), "Pace"]}
                  labelFormatter={(label) => `Split km ${label}`}
                  contentStyle={{
                    background: "var(--popover)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="paceMinPerKm" fill="var(--chart-1)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">Split</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Pace</th>
                  <th className="py-1.5 text-right font-medium">Elevation</th>
                </tr>
              </thead>
              <tbody>
                {route.splits.map((split) => (
                  <tr key={split.km} className="border-b border-border/50 last:border-0">
                    <td className="num py-1.5 pr-3">km {split.km}</td>
                    <td className="num py-1.5 pr-3 text-right">{formatPace(split.paceMinPerKm, units)}</td>
                    <td className="num py-1.5 text-right text-muted-foreground">
                      {split.eleDeltaM >= 0 ? `+${num(split.eleDeltaM, 0)} m` : `${num(split.eleDeltaM, 0)} m`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
