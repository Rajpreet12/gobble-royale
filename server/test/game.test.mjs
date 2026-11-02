// Game rules: the things that would make the game unfair or broken if they regressed.
// Run: npm test (in server/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { H, Room, TICK_HZ, TURKEY_R, W, collide } from "../src/game.mjs";
import { isName, isState } from "../src/names.mjs";

const fakeWs = () => {
  const ws = { readyState: 1, bufferedAmount: 0, sent: [], send(d) { ws.sent.push(JSON.parse(d)); } };
  return ws;
};
const ticks = (room, seconds) => { for (let i = 0; i < seconds * TICK_HZ; i++) room.tick(); };
const untilPlaying = (room) => { for (let i = 0; i < 20 * TICK_HZ && room.phase !== "play"; i++) room.tick(); };

test("a turkey can't leave the field or walk into a hay bale", () => {
  const bale = { x: 500, y: 500, r: 40 };
  const t = { x: -50, y: H + 50 };
  collide(t, TURKEY_R, [bale]);
  assert.deepEqual([t.x, t.y], [TURKEY_R, H - TURKEY_R]);

  const inside = { x: 505, y: 500 };
  collide(inside, TURKEY_R, [bale]);
  assert.ok(Math.hypot(inside.x - bale.x, inside.y - bale.y) >= bale.r + TURKEY_R - 1e-9);
});

test("bots fill the field so the first player never plays alone", () => {
  const room = new Room(1);
  room.add(fakeWs(), "Sir Gobbles", "TX");
  untilPlaying(room);
  assert.equal(room.turkeys.size, 10);
  assert.equal(room.humans().length, 1);
});

test("the Chef waits 2.5 seconds before hunting", () => {
  const room = new Room(1);
  room.add(fakeWs(), "Sir Gobbles", "TX");
  untilPlaying(room);
  const start = room.chefs.map((c) => [c.x, c.y]);
  ticks(room, 2);
  assert.deepEqual(room.chefs.map((c) => [c.x, c.y]), start, "Chefs moved during the warm-up");
  ticks(room, 1.5);
  assert.notDeepEqual(room.chefs.map((c) => [c.x, c.y]), start, "Chefs never started hunting");
});

test("input is clamped: a hacked client can't move faster than anyone else", () => {
  const room = new Room(1);
  const t = room.add(fakeWs(), "Sir Gobbles", "TX");
  room.input(t.id, { x: 50, y: -50 });
  assert.deepEqual(t.input, { x: 1, y: -1 });
  room.input(t.id, { x: "fast", y: null });
  assert.deepEqual(t.input, { x: 0, y: 0 });
});

test("the last turkey standing wins, and the winner hears about it", () => {
  const room = new Room(1);
  const ws = fakeWs();
  room.add(ws, "Sir Gobbles", "TX");
  untilPlaying(room);
  for (const t of room.turkeys.values()) if (t.bot) room.out(t, "chef");
  room.tick();
  assert.equal(room.phase, "over");
  const result = ws.sent.find((m) => m.t === "result");
  assert.equal(result.won, true);
  assert.equal(result.place, 1);
});

test("names and states only come from the lists", () => {
  assert.ok(isName("Sparkly Giblet"));
  assert.ok(!isName("Sparkly Giblet Extra"));
  assert.ok(!isName("<script> Giblet"));
  assert.ok(!isName(""));
  assert.ok(isState("TX"));
  assert.ok(!isState("ZZ"));
});

test("the field is the size the browser expects", () => {
  assert.deepEqual([W, H], [1600, 1000]);
});
