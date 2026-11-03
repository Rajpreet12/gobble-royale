// The service level indicators (SLIs) we measure, and the objectives (SLOs) we hold them to.
//
//   SLI: a measurement of how users experience the game ("p99 tick time")
//   SLO: the target for it ("p99 tick time under 10 ms")
//   SLA: a promise to customers with a penalty if it's broken. A free game has none.
//
// Each SLO picks the percentile that matches how bad a miss feels: p99 for things every player
// feels at once (the shared game loop), p95 for things that vary by player (their own network).

import { histogram } from "./metrics.mjs";

const MS_BUCKETS_FAST = [0.5, 1, 2, 5, 10, 20, 33, 50, 100, 250];
const MS_BUCKETS_NET = [10, 25, 50, 100, 150, 250, 500, 1000, 2500];

export const tickDuration = histogram(
  "gobble_tick_duration_seconds", "Time the server spends on one tick of every arena", MS_BUCKETS_FAST);
export const tickLag = histogram(
  "gobble_tick_lag_seconds", "How late a tick started compared with its schedule", MS_BUCKETS_FAST);
export const rtt = histogram(
  "gobble_rtt_seconds", "Round trip from server to player and back", MS_BUCKETS_NET);
export const httpDuration = (route) => histogram(
  "gobble_http_request_duration_seconds", "Time to answer an HTTP request, by route", MS_BUCKETS_FAST, { route });

export const SLOS = [
  {
    id: "tick",
    name: "Game tick time",
    metric: tickDuration,
    quantile: 0.99,
    targetMs: 10,
    why: "The server has 33 ms per tick. Past that the whole game slows down for every player at once, so we keep the slowest 1% far below it.",
  },
  {
    id: "lag",
    name: "Tick lateness (stutter)",
    metric: tickLag,
    quantile: 0.99,
    targetMs: 15,
    why: "A tick that starts late means a late snapshot, which players see as a stutter. Garbage collection and a busy CPU cause it.",
  },
  {
    id: "rtt",
    name: "Player round trip",
    metric: rtt,
    quantile: 0.95,
    targetMs: 250,
    why: "Mostly the player's own network and distance to us-east-1, so we use p95: a few players on bad Wi-Fi shouldn't decide whether the service is healthy.",
  },
  {
    id: "http",
    name: "Page and API response",
    metric: httpDuration("page"),
    quantile: 0.95,
    targetMs: 50,
    why: "How fast the server answers for the game page itself (network time not included). A slow first load loses players before they even join.",
  },
];

// One point every 30 seconds for the last hour, per SLO, for the status page charts.
const HISTORY_EVERY_MS = 30_000;
const HISTORY_POINTS = 120;
const history = new Map(SLOS.map((s) => [s.id, []]));

export function startHistory() {
  setInterval(() => {
    for (const s of SLOS) {
      const { n, values: [v] } = s.metric.quantiles([s.quantile], HISTORY_EVERY_MS);
      const points = history.get(s.id);
      points.push({ t: Date.now(), v, n });
      while (points.length > HISTORY_POINTS) points.shift();
    }
  }, HISTORY_EVERY_MS).unref();
}

// Saved on shutdown and loaded on start (see index.mjs), so a deploy doesn't wipe the charts.
export const exportHistory = () => Object.fromEntries(history);
export function importHistory(saved) {
  const oldest = Date.now() - HISTORY_POINTS * HISTORY_EVERY_MS;
  for (const [id, points] of Object.entries(saved ?? {})) {
    if (history.has(id) && Array.isArray(points)) history.set(id, points.filter((p) => p.t >= oldest).slice(-HISTORY_POINTS));
  }
}

// With very few samples a percentile is just one or two requests, and "p95" of a single slow first
// page load says nothing about the service. Found 2026-11-03: one 119 ms request right after a
// deploy marked the page SLO as missed. Below this many samples there's no verdict either way.
export const MIN_SAMPLES = 20;

const round = (v) => (v == null ? null : Math.round(v * 100) / 100);

export function sloReport() {
  return SLOS.map((s) => {
    const { n, values: [p50, p95, p99] } = s.metric.quantiles([0.5, 0.95, 0.99]);
    const measured = s.quantile === 0.99 ? p99 : p95;
    return {
      id: s.id, name: s.name, why: s.why, targetMs: s.targetMs,
      percentile: s.quantile === 0.99 ? "p99" : "p95",
      samples: n, minSamples: MIN_SAMPLES, p50: round(p50), p95: round(p95), p99: round(p99),
      // Too few samples (nobody playing, or just restarted) is "no verdict", never a pass or a miss.
      met: n < MIN_SAMPLES ? null : measured <= s.targetMs,
      history: history.get(s.id).map((p) => ({ t: p.t, v: round(p.v), n: p.n })),
    };
  });
}
