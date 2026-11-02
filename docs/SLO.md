# Gobble Royale service level objectives

**Service:** Gobble Royale game server (Lightsail `gobble-royale`, https://gobble.98-88-244-8.sslip.io)
**Owner:** Rajpreet
**Live view:** [/status](https://gobble.98-88-244-8.sslip.io/status)
**Reviewed:** every Monday until Thanksgiving, then monthly

## Why we have SLOs

Players don't care about CPU graphs. They care about two things: *can I get in?* and *does it feel smooth?* Each SLO below measures one of those from the player's side and sets a target that's good enough without demanding perfection. Perfection (100%) would mean never deploying anything.

## 1. Availability

| | |
|---|---|
| **SLI** | Share of minutes in which a player could reach the game: `/health` answers `200 {"ok":true}` within 5 s **and** the game WebSocket at `/play` opens within 5 s |
| **Measured by** | [`uptime/src/uptime.mjs`](../uptime/src/uptime.mjs), a Lambda that checks once a minute from outside the server. A failed check is retried once after 2 s; the minute is bad only if both fail. |
| **SLO** | **99.5%** of minutes, over a rolling 30 days |
| **Error budget** | 0.5% of 43,200 minutes = **216 minutes (3.6 hours) a month** |

**Why 99.5% and not 99.9%?** It's one $5 server. Ubuntu security updates that need a reboot, a deploy, and a Lightsail maintenance event each cost a few minutes. 99.9% allows only 43 minutes a month and would need a second server and a load balancer, which is about $35 a month. 99.5% matches what one server can honestly promise.

**Why both checks?** `/health` alone would pass even if Caddy broke WebSocket forwarding, and then the page loads but nobody can play. The WebSocket check catches that.

**Known blind spot:** the checker runs in us-east-1, the same region as the server. It won't notice a problem between a player's internet provider and AWS, or a whole-region outage. A second checker somewhere else (phase 3) would cover that.

## 2. Smoothness (latency)

Measured on the server itself and shown on `/status`. See [observability.md](observability.md) for how.

| SLI | SLO | Measured over |
|---|---|---|
| Game tick time | p99 < 10 ms | last 5 minutes, only while people play |
| Tick lateness | p99 < 15 ms | same |
| Player round trip | p95 < 250 ms | same |
| Page response | p95 < 50 ms | same |

Latency SLOs don't spend the availability budget. If one is missed, the game still works, but it feels worse. They're checked in every load test, and CI will fail a change that misses one (phase 5).

## Error budget policy

The budget is there to be spent on change. This is what we do at each level:

| Budget left | What it means | What we do |
|---|---|---|
| **More than 50%** | Healthy | Ship freely. Deploys any time. |
| **25 to 50%** | Spending faster than planned | Deploy only during quiet hours, with a rollback ready. Find out what spent it. |
| **Under 25%** | At risk | No new features. Only reliability fixes and urgent security updates. |
| **Used up (0%)** | SLO missed for the month | Feature freeze until the 30-day window recovers. Write a postmortem for every outage that spent budget. |

**Thanksgiving week (Nov 23 to 29):** this is when most players come, so we freeze features and deploy only fixes, whatever the budget says.

## Burn rate: how fast the budget is going

Burn rate compares the current failure rate with the pace that would use up the budget exactly at the end of 30 days.

- **1×** = right on pace to use all 216 minutes by day 30.
- **14.4×** for 1 hour = 2% of the month's budget gone in that hour; the whole budget would be gone in about 2 days.
- **6×** for 6 hours = 5% of the budget gone; empty in about 5 days.

## Alerts

Rules: [`uptime/src/alerts.mjs`](../uptime/src/alerts.mjs). Tests: [`uptime/test/alerts.test.mjs`](../uptime/test/alerts.test.mjs). They're emailed through an SNS topic to the owner.

| Alert | Fires when | Clears when | Means |
|---|---|---|---|
| **[PAGE]** Players can't reach the game | 1-hour burn rate ≥ 14.4× **and** 5-minute burn rate ≥ 14.4× | The last 5 minutes are clean | Act now, even at 3 AM |
| **[TICKET]** Slowly burning the budget | 6-hour burn rate ≥ 6× **and** 30-minute burn rate ≥ 6× | The last 30 minutes are clean | Look tomorrow |
| **[TICKET]** The game feels slow | A latency SLO missed for 10 checks in a row | 3 good checks in a row | Players can still play; no budget spent |
| **[TICKET]** The uptime checker stopped | It hasn't run for 10 minutes (CloudWatch alarm) | It runs again | Outages would go unnoticed |
| **[TICKET]** The uptime checker is failing | Errors in 2 of the last 3 five-minute periods (CloudWatch alarm) | No errors | Alerts may not be sent |

**Why two windows per rule:** the long window stops a single blip from firing; the short window means the alert clears minutes after the problem does, instead of staying red for an hour.

**What a full outage looks like** (this is a test case): the page fires at the 5th bad minute (5 in an hour = burn 16.7×), sends a reminder every hour while it lasts, and resolves 5 clean minutes after recovery. That's two emails for a short outage.

**Inhibition:** a big outage also trips the slow-burn rule. If that rule starts while the page is firing, it's marked as part of the same outage and stays quiet until it clears. One problem, one conversation.

**Who watches the watcher:** if the checker breaks, no outage alert could ever fire. Two CloudWatch alarms watch the checker from outside and email the same topic.

**Known gap:** email only. A page that arrives as an email can sit unread for hours. Real on-call tools (PagerDuty, Opsgenie, or AWS Incident Manager) call or push to your phone and escalate to a second person if you don't acknowledge it. The SNS topic can feed any of them later without changing the rules.

### Test the alert path

```bash
aws lambda invoke --function-name <ProbeFunctionName output> --cli-binary-format raw-in-base64-out \
  --payload '{"testAlert":true}' /dev/stdout
```

This sends one email marked `[TEST]`. Do it after changing anything about alerting, and whenever a new person joins on-call.

## Changing an SLO

SLOs change only on purpose: write down what changed and why in this file, with a date. Never loosen one in the middle of an incident to make it look met.

| Date | Change |
|---|---|
| 2026-11-02 | First version: availability 99.5% over 30 days; four latency SLOs from phase 1 |
