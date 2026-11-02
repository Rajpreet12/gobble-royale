// Deploy gate: the error budget policy from docs/SLO.md, enforced before every deploy.
//
//   Budget left > 25%  -> deploy
//   Budget left <= 25% -> blocked: reliability fixes only (run the deploy by hand with "emergency")
//   Freeze window      -> blocked: Thanksgiving week, when most players come
//   Budget unknown     -> blocked: if we can't see the budget, we don't deploy blind
//
// An emergency deploy (EMERGENCY=true, with a REASON) skips the gate and says so loudly.
// Exits 1 when blocked, so the pipeline stops with the reason on screen.

import { appendFileSync } from "node:fs";

const BUDGET_URL = process.env.BUDGET_URL;
const EMERGENCY = process.env.EMERGENCY === "true";
const REASON = (process.env.REASON ?? "").trim();
const MIN_BUDGET_PERCENT = 25;
// Dates are inclusive, in UTC.
const FREEZES = [{ from: "2026-11-23", to: "2026-11-29", why: "Thanksgiving week freeze" }];

const summary = (line) => {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
};

function decide(now, budget) {
  const today = now.toISOString().slice(0, 10);
  const freeze = FREEZES.find((f) => today >= f.from && today <= f.to);
  if (freeze) return { ok: false, why: `${freeze.why} (${freeze.from} to ${freeze.to}): fixes only.` };
  if (!budget) return { ok: false, why: "Can't read the error budget, so we can't tell whether a deploy is safe." };
  if (budget.budgetLeftPercent <= MIN_BUDGET_PERCENT) {
    return { ok: false, why: `Only ${budget.budgetLeftPercent}% of the error budget is left (policy: no feature deploys at ${MIN_BUDGET_PERCENT}% or below).` };
  }
  return { ok: true, why: `${budget.budgetLeftPercent}% of the error budget left (${budget.budgetLeftMinutes} of ${budget.budgetMinutes} minutes).` };
}

let budget = null;
try {
  const res = await fetch(BUDGET_URL, { signal: AbortSignal.timeout(10_000) });
  if (res.ok) budget = await res.json();
} catch { /* budget stays unknown */ }

const verdict = decide(new Date(), budget);
summary("## Deploy gate");
if (verdict.ok) {
  summary(`✅ Allowed: ${verdict.why}`);
} else if (EMERGENCY) {
  if (!REASON) {
    summary(`🛑 Blocked: ${verdict.why} An emergency deploy needs a reason.`);
    process.exit(1);
  }
  summary(`🚨 EMERGENCY deploy, skipping the gate. It would have said: ${verdict.why}`);
  summary(`Reason given: ${REASON}`);
} else {
  summary(`🛑 Blocked: ${verdict.why}`);
  summary("For an urgent fix, run the Deploy workflow by hand with emergency = true and a reason.");
  process.exit(1);
}
