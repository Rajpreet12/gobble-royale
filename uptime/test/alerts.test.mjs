// Alert rules tested against fake timelines, one simulated minute at a time.
// Run: node --test uptime/test/alerts.test.mjs
// Each scenario is a question an on-call engineer would ask: "would this have woken me up?"

import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/alerts.mjs";

const MIN = 60_000;
const START = Date.parse("2026-11-20T12:00:00Z");

// Plays `minutes` minutes. isBad(m) says whether minute m failed the uptime check; latency(m)
// returns the server's SLO report for that minute (or null). Returns every email sent, with its minute.
function simulate(minutes, isBad, latency = () => null) {
  let state = {};
  const badTimes = [];
  const sent = [];
  for (let m = 0; m < minutes; m++) {
    const now = START + m * MIN;
    if (isBad(m)) badTimes.push(now);
    const out = decide({
      now, badTimes, slos: latency(m), prev: state, slo: 99.5,
      budgetLeftMinutes: 216 - badTimes.length, budgetMinutes: 216, lastReason: "test",
      statusUrl: "https://example/status", budgetUrl: "https://budget.example/",
    });
    state = out.state;
    for (const n of out.notifications) sent.push({ minute: m, id: n.id, event: n.event, subject: n.subject, body: n.body });
  }
  return sent;
}

test("a single failed minute wakes nobody up", () => {
  assert.deepEqual(simulate(120, (m) => m === 30), []);
});

test("a 15-minute outage pages within 5 minutes and sends exactly two emails", () => {
  const sent = simulate(180, (m) => m >= 60 && m < 75);
  assert.deepEqual(sent.map((s) => [s.minute, s.id, s.event]), [
    [64, "page", "firing"], // 5th bad minute: 5 in an hour = burn 16.7×, over 14.4×
    [79, "page", "resolved"], // 5 clean minutes later the short window is clear
  ]);
  // The slow rule also crossed its threshold, but it was covered by the page: no extra emails.
  assert.ok(sent[0].subject.startsWith("[PAGE]"));
  assert.match(sent.at(-1).subject, /^\[RESOLVED\]/);
  assert.ok(sent.every((s) => /^[\x20-\x7e]+$/.test(s.subject)), "subjects must be plain ASCII for SNS");
  // Game day 2026-11-02: /status is down during an outage, so the first link must be one that isn't.
  assert.match(sent[0].body, /1\. Look: https:\/\/budget\.example\//);
});

test("a long outage reminds once an hour", () => {
  const sent = simulate(200, (m) => m >= 10 && m < 150);
  const events = sent.map((s) => [s.minute, s.event]);
  assert.deepEqual(events, [[14, "firing"], [74, "reminder"], [134, "reminder"], [154, "resolved"]]);
  assert.match(sent[1].subject, /still firing, 60 min/);
});

test("a slow leak opens a ticket but never pages", () => {
  // One bad minute every 20 minutes: never 5 in an hour, but 18 in 6 hours (burn 10×, over 6×)
  const sent = simulate(480, (m) => m % 20 === 0);
  assert.ok(sent.length > 0, "expected a ticket");
  assert.ok(sent.every((s) => s.id === "ticket"), "nothing but tickets");
  assert.equal(sent[0].event, "firing");
  assert.ok(sent[0].subject.startsWith("[TICKET]"));
});

test("a latency SLO missed for 10 checks opens a ticket and clears after 3 good ones", () => {
  const report = (met) => [{ id: "tick", name: "Game tick time", percentile: "p99", p99: met ? 2 : 14, targetMs: 10, met }];
  // Missed from minute 5 to 24, then good. A single good check at minute 15 must not clear it.
  const sent = simulate(40, () => false, (m) => report(!(m >= 5 && m < 25) || m === 15));
  assert.deepEqual(sent.map((s) => [s.minute, s.id, s.event]), [
    [14, "latency:tick", "firing"],
    [27, "latency:tick", "resolved"],
  ]);
});

test("no latency report (nobody playing) neither fires nor clears a latency alert", () => {
  const sent = simulate(30, () => false, (m) => (m < 12 ? [{ id: "tick", name: "Game tick time", percentile: "p99", p99: 14, targetMs: 10, met: false }] : [{ id: "tick", name: "Game tick time", percentile: "p99", p99: null, targetMs: 10, met: null }]));
  assert.deepEqual(sent.map((s) => s.event), ["firing"]); // fired at 10 misses, stays open through the silence
});
