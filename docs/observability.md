# Observability: measuring Gobble Royale (phase 1)

What we measure, how, what we found, and the concepts behind it.

- Live status page: https://gobble.98-88-244-8.sslip.io/status
- Raw metrics (Prometheus format): https://gobble.98-88-244-8.sslip.io/metrics

## The concepts, in one minute

| Term | Meaning | Here |
|---|---|---|
| **SLI** (service level indicator) | A measurement of how users experience the service | p99 game tick time |
| **SLO** (service level objective) | The target we hold the SLI to | p99 tick time under 10 ms |
| **SLA** (service level agreement) | A contract with customers, with a penalty if broken | None: it's a free game. Your SLOs should always be stricter than any SLA. |
| **p50 / p95 / p99** | Sort every sample; the value 50% / 95% / 99% of the way along | p99 = only 1 in 100 ticks were slower |
| **Error budget** | How much failure the SLO allows | Coming in phase 2 |

**Why percentiles, not averages:** if 99 ticks take 1 ms and one takes 200 ms, the average is about 3 ms and looks fine, but every player felt that 200 ms freeze. The p99 shows it; the average hides it.

## The SLOs

Defined in [`server/src/slo.mjs`](../server/src/slo.mjs).

| SLI | SLO | Why this percentile |
|---|---|---|
| Game tick time | p99 < 10 ms | The loop is shared: one slow tick hurts every player at once, so we watch the slowest 1%. The hard limit is 33 ms (30 ticks a second). |
| Tick lateness (stutter) | p99 < 15 ms | How far past its deadline a tick ran. Late ticks mean late snapshots, which players see as stutter. |
| Player round trip | p95 < 250 ms | Mostly the player's own network. p95, so a few people on bad Wi-Fi don't decide whether *the service* is healthy. |
| Page response | p95 < 50 ms | Server time to answer for the game page. A slow first load loses players before they join. |

Two rules the code follows:
- **Only record while someone is playing.** An idle server ticks fast and would make the numbers look better than any player felt.
- **No data is not a pass.** With zero samples the status says "No data", never "Meeting".

## How it's measured

[`server/src/metrics.mjs`](../server/src/metrics.mjs) records every latency in two ways:

1. **Prometheus histogram** (`/metrics`): counts how many samples fell under each bucket edge (`le="0.002"` means 2 ms or less), forever. Tools like Prometheus or Grafana scrape it and calculate percentiles over any time range. Units are seconds, by Prometheus convention.
2. **Rolling window** (`/status`): raw samples from the last 5 minutes, in 10-second slices. Percentiles use the *nearest-rank* method: sort, then take the value at position ceil(q × n). Each slice keeps at most 2,000 samples; past that, *reservoir sampling* replaces random old samples so the kept ones stay a fair picture.

Where the numbers come from:
- **Tick time and lateness:** timed around the game loop in [`index.mjs`](../server/src/index.mjs).
- **Round trip:** every 2 seconds the server sends `{t:"ping", n}`, the page answers `{t:"pong", n}`, and the *server* times it. The page never reports its own number, so it can't be faked.
- **HTTP:** timed from request to response finish, labelled by route.

**Labels and cardinality:** the route label comes from a fixed list (`page`, `api`, `status`...), never the raw URL. If it used the URL, anyone requesting `/random-1`, `/random-2`... would create a new metric series each time until the server ran out of memory. That's called a cardinality explosion, and it's a classic way to take down a monitoring system.

### Counters and gauges
- **Counters** only go up: `gobble_joins_total`, `gobble_messages_dropped_total` (rate limit), `gobble_snapshots_skipped_total` (a player's connection is backed up, an early warning), `gobble_turkeys_out_total{by}`. You get rates by comparing two readings.
- **Gauges** go up and down: players online, rooms, memory, and event loop utilization (share of time Node was busy; near 100% means it can't keep up).

## Load testing

```bash
cd server
MAX_PER_IP=500 PORT=8090 npm start                       # terminal 1: a local server
npm run loadtest -- --url http://localhost:8090 --players 60 --seconds 45   # terminal 2
```

[`scripts/loadtest.mjs`](../server/scripts/loadtest.mjs) connects fake players who wander and flap, measures what *they* felt (join time, round trip, gap between snapshots), prints the server's SLO report, and **exits with code 1 if any SLO is missed**. Phase 5 uses that exit code to block slow changes in CI.

Don't point it at the live game: real players share that server, and the bots would count on the leaderboard. To test on the real hardware, run a second copy of the server on another port on the same machine, as we did below.

## What phase 1 found

The first load test failed, and that turned out to be useful.

| Run | Machine | Snapshot gap p50 (target ~66.7 ms) | Tick lateness p99 | Tick time p99 |
|---|---|---|---|---|
| 1. Original `setInterval` loop | Windows laptop, 60 players | **81.8 ms** (game ran ~20% slow) | 15.3 ms ❌ | 4.2 ms |
| 2. Fixed-timestep loop | Windows laptop, 60 players | **66.3 ms** ✅ | 15.4 ms ❌ | 3.6 ms |
| 3. Fixed-timestep loop | Lightsail (Linux), 30 players | **66.7 ms** ✅ (max 72 ms) | **1.4 ms** ✅ | 1.6 ms |

**Finding 1: the game slowed down whenever the server woke up late.** `setInterval` assumes each tick runs on time. Every late wake-up delayed that tick *and all the ones after it*, so game time fell behind real time. Players got 20% fewer updates than intended, and the Chef and turkeys moved slower. The fix in `index.mjs` is a **fixed-timestep loop**: each tick has a deadline; a late wake-up runs the ticks it missed (up to 3) so game time keeps pace, and a delay of over a second (a laptop waking from sleep) resyncs instead of fast-forwarding. Result: 24% more snapshots delivered in the same test.

**Finding 2: the remaining 15 ms lateness was the Windows timer, not the code.** Windows wakes timers about every 15.6 ms by default, so ticks start up to 15 ms late. The same code on Linux was 1.4 ms at p99. This is why you measure on the real hardware before you trust a number.

**Finding 3: the earlier "1.14 ms per tick" was an average.** The real p99 under load is 3.6 to 4.2 ms on the laptop and 1.6 ms on Linux. All are well inside the 10 ms target, but now we know the *tail*, not just the middle.

## How this maps to the job

- *"Own components in production"*: SLIs and SLOs on a live service, with a public status page.
- *"Incident response"*: the load test found a real defect (the game running 20% slow), we found the root cause, fixed it, and proved the fix with before/after numbers.
- *"Write clear documentation"*: this file.
- *"Evolve best practices"*: route labels from a fixed list, no-data-is-not-a-pass, measure on production hardware, and a load test that can gate CI.

**Phase 2 (done):** the availability SLO (99.5% of minutes over 30 days), error budget and burn rate, measured from outside by [`uptime/`](../uptime/). See [SLO.md](SLO.md).
