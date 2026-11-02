// The state leaderboard: wins and rounds played per state.
// Kept in memory for fast reads, and saved so a restart keeps the scores:
//   SCORES_FILE  a JSON file on the server's disk (the $5 Lightsail setup)
//   TABLE_NAME   a DynamoDB table (for running more than one server)

import { readFile, rename, writeFile } from "node:fs/promises";

const FILE = process.env.SCORES_FILE;
const TABLE = process.env.TABLE_NAME;

// Only loaded when a table is configured, so the file setup doesn't pay for the AWS SDK in memory.
let db = null;
let Scan, Update;
if (TABLE) {
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const lib = await import("@aws-sdk/lib-dynamodb");
  db = lib.DynamoDBDocumentClient.from(new DynamoDBClient({}));
  Scan = lib.ScanCommand;
  Update = lib.UpdateCommand;
}

// pk is a state code, or "_TOTAL" for the all-time counters.
const board = new Map();
let dirty = false;

export async function loadScores() {
  if (FILE) {
    try {
      for (const [pk, counts] of Object.entries(JSON.parse(await readFile(FILE, "utf8")))) board.set(pk, counts);
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // first start: no file yet
    }
    return;
  }
  if (!db) return;
  let ExclusiveStartKey;
  do {
    const page = await db.send(new Scan({ TableName: TABLE, ExclusiveStartKey }));
    for (const { pk, ...counts } of page.Items ?? []) board.set(pk, counts);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
}

// File: write changes every few seconds (to a temp file, then rename, so a crash never leaves half a file).
// DynamoDB: re-read the table so every server shows the same board.
export function syncScores() {
  if (FILE) {
    setInterval(() => saveFile().catch((err) => console.warn("Scores not saved", err.code)), 5_000).unref();
  } else if (db) {
    setInterval(() => loadScores().catch((err) => console.warn("Leaderboard sync failed", err.name)), 30_000).unref();
  }
}

export async function saveFile() {
  if (!FILE || !dirty) return;
  dirty = false;
  await writeFile(`${FILE}.tmp`, JSON.stringify(Object.fromEntries(board)));
  await rename(`${FILE}.tmp`, FILE);
}

// Updates memory at once; saving happens in the background and a failure never stops the game.
export function record(pk, fields) {
  const row = board.get(pk) ?? {};
  for (const [k, v] of Object.entries(fields)) row[k] = (row[k] ?? 0) + v;
  board.set(pk, row);
  dirty = true;
  if (!db) return;
  const names = Object.keys(fields);
  db.send(new Update({
    TableName: TABLE,
    Key: { pk },
    UpdateExpression: `ADD ${names.map((_, i) => `#f${i} :v${i}`).join(", ")}`,
    ExpressionAttributeNames: Object.fromEntries(names.map((n, i) => [`#f${i}`, n])),
    ExpressionAttributeValues: Object.fromEntries(names.map((n, i) => [`:v${i}`, fields[n]])),
  })).catch((err) => console.warn("Score not saved", err.name));
}

export function leaderboard(limit = 10) {
  const states = [...board.entries()]
    .filter(([pk]) => !pk.startsWith("_"))
    .map(([code, row]) => ({ code, wins: row.wins ?? 0, plays: row.plays ?? 0 }))
    .sort((a, b) => b.wins - a.wins || b.plays - a.plays)
    .slice(0, limit);
  const total = board.get("_TOTAL") ?? {};
  return { states, stuffed: total.stuffed ?? 0, rounds: total.rounds ?? 0 };
}
