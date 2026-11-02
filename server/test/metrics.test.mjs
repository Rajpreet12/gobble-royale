// Metrics: if these are wrong, every SLO decision built on them is wrong too.
// Run: npm test (in server/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { counter, histogram, renderPrometheus } from "../src/metrics.mjs";

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

test("label values can't break the output format", () => {
  counter("test_escape_total", "test", { route: 'evil"\nvalue' }).inc();
  assert.match(renderPrometheus(), /test_escape_total\{route="evil__value"\} 1\n/);
});
