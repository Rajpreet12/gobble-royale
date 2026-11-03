// Metrics: if these are wrong, every SLO decision built on them is wrong too.
// Run: npm test (in server/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { counter, exportWindows, histogram, importWindows, renderPrometheus } from "../src/metrics.mjs";

test("percentiles use nearest rank: 1..100 gives p50=50, p95=95, p99=99", () => {
  const h = histogram("test_rank_seconds", "test", [10, 100]);
  for (let v = 100; v >= 1; v--) h.observe(v); // order must not matter
  assert.deepEqual(h.quantiles([0.5, 0.95, 0.99]).values, [50, 95, 99]);
});

test("one slow sample shows in p99 but hides in the average", () => {
  const h = histogram("test_tail_seconds", "test", [10, 100]);
  for (let i = 0; i < 99; i++) h.observe(1);
  h.observe(200);
  const { values: [p50, p99] } = h.quantiles([0.5, 0.99]);
  assert.equal(p50, 1);
  assert.equal(p99, 1); // nearest rank: the 99th of 100 samples is still fast...
  assert.equal(h.quantiles([1]).values[0], 200); // ...the max shows the freeze
  assert.ok(h.sum / h.count < 3, "the average looks healthy, which is exactly the trap");
});

test("no samples means no data, not zero", () => {
  const h = histogram("test_empty_seconds", "test", [10]);
  assert.deepEqual(h.quantiles([0.99]), { n: 0, values: [null] });
});

test("bad samples are ignored instead of poisoning the numbers", () => {
  const h = histogram("test_bad_seconds", "test", [10]);
  for (const v of [NaN, -1, Infinity, "5"]) h.observe(v);
  assert.equal(h.count, 0);
});

test("Prometheus output: cumulative buckets, seconds, +Inf equals count", () => {
  const h = histogram("test_prom_seconds", "A test histogram", [1, 10], { route: "page" });
  for (const v of [0.5, 5, 50]) h.observe(v);
  const text = renderPrometheus();
  assert.match(text, /# TYPE test_prom_seconds histogram/);
  assert.match(text, /test_prom_seconds_bucket\{route="page",le="0.001"\} 1\n/);
  assert.match(text, /test_prom_seconds_bucket\{route="page",le="0.01"\} 2\n/);
  assert.match(text, /test_prom_seconds_bucket\{route="page",le="\+Inf"\} 3\n/);
  assert.match(text, /test_prom_seconds_sum\{route="page"\} 0.0555/);
  assert.match(text, /test_prom_seconds_count\{route="page"\} 3\n/);
});

test("the 5-minute window survives a restart, and stale slices don't come back", () => {
  const h = histogram("test_restart_seconds", "test", [10], { route: "page" });
  for (let v = 1; v <= 10; v++) h.observe(v);
  // What a restart does: save to JSON, start empty, load. Add a slice that's an hour old.
  const saved = JSON.parse(JSON.stringify(exportWindows())).filter((s) => s.name === "test_restart_seconds");
  saved[0].slices.push({ start: Date.now() - 60 * 60_000, values: [9999], seen: 1 });
  h.slices = [];
  importWindows(saved);
  const { n, values: [p50, max] } = h.quantiles([0.5, 1]);
  assert.equal(n, 10);
  assert.equal(p50, 5);
  assert.equal(max, 10, "the hour-old 9999 ms sample must not be restored");
});

test("a histogram created lazily (like a new route) is restored too", () => {
  importWindows([{ name: "test_lazy_seconds", help: "t", buckets: [10], labels: { route: "api" }, slices: [{ start: Date.now(), values: [3], seen: 1 }] }]);
  assert.equal(histogram("test_lazy_seconds", "t", [10], { route: "api" }).quantiles([0.5]).values[0], 3);
});

test("label values can't break the output format", () => {
  counter("test_escape_total", "test", { route: 'evil"\nvalue' }).inc();
  assert.match(renderPrometheus(), /test_escape_total\{route="evil__value"\} 1\n/);
});
