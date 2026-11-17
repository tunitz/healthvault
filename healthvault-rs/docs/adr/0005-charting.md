# ADR 0005: Charting strategy

- Status: accepted for phase 1, revisit after the first UI review
- Context: the web UI uses Recharts. GPUI Kit 0.10 ships `chart::{AreaChart, BarChart, LineChart,
  PieChart, RadarChart}` and `plot::Plot`.
- Decision: use GPUI Kit's chart components for the native app; no embedded browser or web renderer.
  The initial shell reads domain data through `hv-api` and shows structured summaries; per-metric
  charts are added after the core parity suite is green. Correctness and legibility outrank visual
  parity with the Recharts screens.
- Consequences: charts are native and keyboard-accessible; no new JS runtime in the desktop app.
