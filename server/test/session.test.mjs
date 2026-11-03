// The "last real session" shown on /status when nobody is playing.
// Run: npm test (in server/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { END_AFTER_EMPTY_MS, SessionTracker } from "../src/session.mjs";

const T0 = Date.parse("2026-11-20T18:00:00Z");
const report = (met, value = 1) => [{ id: "tick", name: "Game tick time", percentile: "p99", targetMs: 10, samples: met === null ? 3 : 900, met, p50: 0.2, p95: 0.5, p99: value }];

test("a session is kept once the field has been empty for a minute", () => {
  const s = new SessionTracker();
  s.update(T0, 2, 10, report(true, 0.8));
  s.update(T0 + 60_000, 3, 13, report(true, 0.9)); // a third player joins, 3 rounds played
  s.update(T0 + 120_000, 0, 13, report(null));
  assert.equal(s.last, null, "not over yet: the field only just emptied");
  s.update(T0 + 120_000 + END_AFTER_EMPTY_MS, 0, 13, report(null));
  assert.deepEqual(s.last, {
    startedAt: T0, endedAt: T0 + 120_000, peakPlayers: 3, rounds: 3,
    slos: [{ id: "tick", name: "Game tick time", percentile: "p99", targetMs: 10, samples: 900, met: true, value: 0.9 }],
  });
});

test("a quick refresh or a deploy's reconnect doesn't split one session in two", () => {
  const s = new SessionTracker();
  s.update(T0, 1, 0, report(true));
  s.update(T0 + 5_000, 0, 0, report(true)); // gone for a moment...
  s.update(T0 + 20_000, 1, 1, report(true)); // ...and back
  assert.equal(s.current.startedAt, T0);
  assert.equal(s.last, null);
});

test("numbers that were never judged (too few samples) are not shown as a verdict", () => {
  const s = new SessionTracker();
  s.update(T0, 1, 0, report(null)); // joined and left within seconds
  s.update(T0 + 10_000, 0, 0, report(null));
  s.update(T0 + 10_000 + END_AFTER_EMPTY_MS, 0, 0, report(null));
  assert.equal(s.last, null, "no judged numbers, so no last session to show");
});

test("the last session survives a restart, and junk in the file is ignored", () => {
  const saved = JSON.parse(JSON.stringify({ startedAt: T0, endedAt: T0 + 1, peakPlayers: 2, rounds: 4, slos: [] }));
  assert.equal(new SessionTracker(saved).last.rounds, 4);
  assert.equal(new SessionTracker({ hello: "world" }).last, null);
  assert.equal(new SessionTracker(undefined).last, null);
});
