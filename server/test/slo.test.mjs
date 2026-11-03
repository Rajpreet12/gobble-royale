// SLO verdicts: when the status page (and the latency alerts) may say Meeting or Missing.
// Run: npm test (in server/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_SAMPLES, exportHistory, httpDuration, importHistory, sloReport } from "../src/slo.mjs";

const page = () => sloReport().find((s) => s.id === "http");

test("one slow request is not enough to call an SLO missed", () => {
  // 2026-11-03: a single 119 ms first page load after a deploy showed the page SLO as missed
  httpDuration("page").observe(119);
  assert.equal(page().samples, 1);
  assert.equal(page().met, null, "too few samples must give no verdict");
});

test("with enough samples the SLO is judged normally", () => {
  for (let i = page().samples; i < MIN_SAMPLES; i++) httpDuration("page").observe(5);
  assert.equal(page().met, true); // p95 of 19 fast + 1 slow is fast
  for (let i = 0; i < MIN_SAMPLES; i++) httpDuration("page").observe(200);
  assert.equal(page().met, false); // now half are slow: genuinely missing
});

test("chart history survives a restart but drops points older than an hour", () => {
  const now = Date.now();
  importHistory({ tick: [{ t: now - 2 * 3_600_000, v: 99, n: 5 }, { t: now - 60_000, v: 1.5, n: 900 }], unknown: [{ t: now, v: 1, n: 1 }] });
  assert.deepEqual(exportHistory().tick, [{ t: now - 60_000, v: 1.5, n: 900 }]);
  assert.equal(exportHistory().unknown, undefined, "unknown SLO ids are ignored");
});
