// Metrics: the numbers that say whether the game is healthy.
//
// Every latency is recorded twice, because each view answers a different question:
//   1. A Prometheus histogram (served at /metrics). Counts how many samples fell under each bucket
//      edge, forever. Monitoring tools scrape it and work out percentiles across any time range.
//   2. A rolling window of recent raw samples (used by /status). Gives exact p50/p95/p99 for
//      "right now" without any outside tool.
//
// Percentiles use the nearest-rank method: sort the samples, and p99 is the value 99% of the
// way along. An average would hide the slow 1%, which is exactly what players complain about.

const SLICE_MS = 10_000; // the window is made of 10-second slices...
const WINDOW_MS = 5 * 60_000; // ...covering the last 5 minutes
const SLICE_CAP = 2_000; // samples kept per slice; past that, reservoir sampling keeps a fair random subset

const families = new Map(); // name -> { type, help, series: Map<labelKey, metric> }

function family(name, type, help) {
  let f = families.get(name);
  if (!f) families.set(name, (f = { type, help, series: new Map() }));
  return f;
}

// Labels split one metric into several, e.g. request time per route. Keep the set of values
// small and fixed: a label built from user input (a raw URL, a player name) would create a new
// series per value and eventually exhaust memory. That's called a cardinality explosion.
const labelKey = (labels) => Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, "_")}"`).join(",");

class Histogram {
  constructor(buckets) {
    this.buckets = buckets; // upper edges in ms, ascending
    this.counts = new Array(buckets.length + 1).fill(0); // the last one is +Inf
    this.count = 0;
    this.sum = 0;
    this.slices = [];
  }

  observe(ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.count++;
    this.sum += ms;
    let i = 0;
    while (i < this.buckets.length && ms > this.buckets[i]) i++;
    this.counts[i]++;

    const now = Date.now();
    let slice = this.slices[this.slices.length - 1];
    if (!slice || now - slice.start >= SLICE_MS) {
      this.slices.push((slice = { start: now, values: [], seen: 0 }));
      while (this.slices.length && now - this.slices[0].start > WINDOW_MS) this.slices.shift();
    }
    // Reservoir sampling: once the slice is full, each new sample replaces a random old one
    // with probability CAP/seen, so the kept samples stay a fair picture of the whole slice.
    slice.seen++;
    if (slice.values.length < SLICE_CAP) slice.values.push(ms);
    else {
      const j = Math.floor(Math.random() * slice.seen);
      if (j < SLICE_CAP) slice.values[j] = ms;
    }
  }

  // Percentiles over the samples from the last `sinceMs` milliseconds.
  quantiles(qs = [0.5, 0.95, 0.99], sinceMs = WINDOW_MS) {
    const from = Date.now() - sinceMs;
    const values = [];
    let seen = 0;
    for (const s of this.slices) {
      if (s.start + SLICE_MS <= from) continue;
      for (const v of s.values) values.push(v);
      seen += s.seen;
    }
    if (!values.length) return { n: 0, values: qs.map(() => null) };
    values.sort((a, b) => a - b);
    return { n: seen, values: qs.map((q) => values[Math.max(0, Math.ceil(q * values.length) - 1)]) };
  }
}

export function histogram(name, help, buckets, labels = {}) {
  const f = family(name, "histogram", help);
  const key = labelKey(labels);
  if (!f.series.has(key)) {
    const h = new Histogram(buckets);
    h.labels = labels;
    f.series.set(key, h);
  }
  return f.series.get(key);
}

// The rolling windows behind /status, so a restart (every deploy) doesn't wipe the last 5 minutes.
// Found 2026-11-03: a deploy emptied the status page right after someone had been playing.
// Counters and Prometheus buckets are NOT saved: monitoring tools expect those to reset when a
// process restarts, and they handle it. Only the windows /status reads from are carried over.
export function exportWindows() {
  const out = [];
  for (const [name, f] of families) {
    if (f.type !== "histogram") continue;
    for (const h of f.series.values()) {
      if (h.slices.length) out.push({ name, help: f.help, buckets: h.buckets, labels: h.labels ?? {}, slices: h.slices });
    }
  }
  return out;
}

export function importWindows(saved) {
  const from = Date.now() - WINDOW_MS;
  for (const s of saved ?? []) {
    if (!s?.name || !Array.isArray(s.buckets) || !Array.isArray(s.slices)) continue;
    const h = histogram(s.name, s.help ?? "", s.buckets, s.labels ?? {});
    const fresh = s.slices.filter((x) => x.start >= from && Array.isArray(x.values));
    h.slices = [...fresh, ...h.slices].sort((a, b) => a.start - b.start);
  }
}

export function counter(name, help, labels = {}) {
  const f = family(name, "counter", help);
  const key = labelKey(labels);
  if (!f.series.has(key)) f.series.set(key, { value: 0, inc(n = 1) { this.value += n; } });
  return f.series.get(key);
}

// A gauge is a value that goes up and down (players online, memory). It's read when scraped.
export function gauge(name, help, read) {
  family(name, "gauge", help).series.set("", { read });
}

// The Prometheus text format. Prometheus convention is base units, so ms become seconds.
export function renderPrometheus() {
  const lines = [];
  const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toPrecision(6));
  for (const [name, f] of families) {
    lines.push(`# HELP ${name} ${f.help}`, `# TYPE ${name} ${f.type}`);
    for (const [key, m] of f.series) {
      const with_ = (extra) => `{${[key, extra].filter(Boolean).join(",")}}`;
      if (f.type === "histogram") {
        let running = 0;
        m.buckets.forEach((edge, i) => {
          running += m.counts[i];
          lines.push(`${name}_bucket${with_(`le="${edge / 1000}"`)} ${running}`);
        });
        lines.push(`${name}_bucket${with_('le="+Inf"')} ${m.count}`);
        lines.push(`${name}_sum${key ? `{${key}}` : ""} ${fmt(m.sum / 1000)}`);
        lines.push(`${name}_count${key ? `{${key}}` : ""} ${m.count}`);
      } else {
        const v = f.type === "gauge" ? m.read() : m.value;
        lines.push(`${name}${key ? `{${key}}` : ""} ${fmt(v)}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
