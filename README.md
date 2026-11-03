# 🦃 Gobble Royale

**Every turkey online. One field. The Chef is coming.**

A live multiplayer turkey battle royale for Thanksgiving. Everyone who opens the page is a turkey on the same field. The Chef chases the nearest bird, more Chefs come out of the kitchen as the round goes on, and the oven closes in. Be the last turkey standing and win it for your state.

Halloween's guest was the Haunted House of AWS: AI ghost stories read aloud in the dark. This one has no AI and no voice. It's a real-time game where strangers play together, states fight on a live leaderboard, and the whole farm runs like a production service on one **$5 a month** server.

## 🍽️ Pull up a chair

| | |
|---|---|
| 🦃 **Play** | https://gobble.98-88-244-8.sslip.io (on a phone, turn it sideways) |
| 🌡️ **Is the oven hot?** | https://gobble.98-88-244-8.sslip.io/status |
| 📖 **The recipe book** | [SLOs](docs/SLO.md) · [runbook](docs/RUNBOOK.md) · [postmortems](docs/postmortems/) · [pipeline](docs/CI-CD.md) |

## 🧑‍🍳 Tonight's menu: how a round works

| Course | What happens |
|---|---|
| ⏳ **Lobby** | 6 seconds. Waddle around while the family arrives. |
| 🔔 **Run!** | Bots fill the field to at least 10 turkeys, so nobody eats alone. The Chef waits 2.5 seconds to find the carving knife, then hunts. |
| 👨‍🍳 **The Chefs** | Chase the nearest turkey and aim a little ahead of it. They get faster as dinner nears, and more come out at 25s and 50s. |
| 🔥 **The oven** | From 12s the safe ring shrinks. Stay outside it for 1.5s and you're roasted. |
| 🌾 **Hay bales** | Block everyone. Run circles around the Chef. |
| 🪶 **Flap** | A short burst of speed, recharged after 2.5s. |
| 🏆 **Pardoned!** | Last turkey standing wins it for their state. If the 90s clock runs out, every survivor shares the win. |

Turkey names come from two word lists ("Sparkly Giblet", "Sir Gobbles"), never typed, so the table stays family-friendly with nothing to moderate.

## 🏡 The farmhouse: what's in the kitchen

```
Players ──wss://──►  Lightsail nano ($5/mo, 1 TB transfer included, static IP)
                        ├─ Caddy: HTTPS on 443, free Let's Encrypt certificate, WebSockets passed through,
                        │         and a friendly "The farm is restarting" page if the game is down
                        └─ Node.js on 127.0.0.1:8080
                              ├─ serves the page (public/)
                              ├─ runs every arena at 30 ticks/s, sends 15 snapshots/s
                              └─ scores + status metrics ──► /var/lib/gobble/ (saved often and on shutdown)

Watching from outside the farmhouse:
  Uptime checker (Lambda, every minute) ──► DynamoDB ──► [PAGE] / [TICKET] emails (SNS)
  CloudWatch alarms ──► "is the checker itself still running?"
  GitHub Actions ──► CI, then deploy with short-lived AWS credentials (OIDC)
```

The address comes from [sslip.io](https://sslip.io), a free DNS service that maps `gobble.98-88-244-8.sslip.io` to the server's IP, so Let's Encrypt can issue a certificate without buying a domain. If you buy one later, point it at `98.88.244.8` and change the host in `/etc/caddy/Caddyfile`.

## 📜 Grandma's secret recipe: why it's built this way

- **The Chef keeps the only cookbook.** The server decides everything. Browsers send only a direction (and "flap"), never a position, so no turkey can teleport out of trouble. Speed, collisions and catches all happen on the server.
- **It still feels instant.** Your own turkey moves the moment you press a key and is gently pulled toward the server's position. Other turkeys are drawn 110 ms in the past and blended between snapshots, so they glide instead of jumping.
- **Feeding 5 or 500 costs the same.** Pay-per-message services (API Gateway WebSockets, AppSync) would cost about $1 for every million messages delivered, and 500 players at 15 updates a second is about 27,000 messages a second. One $5 server costs the same whether 5 or 500 people play, and its 1 TB of included transfer covers about 185 hours of 500 players. In a test, the game loop handled 600 players in about 1 ms per tick, against a budget of 33 ms.
- **No load balancer at the table.** A load balancer alone costs about $16 a month. Caddy on the server does the HTTPS for free.
- **Guests who drop out come back.** If a connection goes quiet for 3 seconds, the page shows "Reconnecting..." and rejoins by itself, with backoff and jitter so a whole room doesn't stampede back at once. A deploy is a 2 to 3 second blip.
- **House rules.** At most 4 connections per IP and 40 messages per second per connection, with 512-byte messages. Dead connections are dropped by a 20s ping.

## 🌡️ Is the oven at temperature?

The farm is measured like a production service. What's measured, how, and what it found: [docs/observability.md](docs/observability.md).

- **Live status:** [/status](https://gobble.98-88-244-8.sslip.io/status) shows the SLOs (p99 tick time, tick lateness, p95 round trip, p95 page response), live p50/p95/p99, the last hour, and 30-day availability with the error budget. An SLO needs 20 samples before it's judged, so one slow request can't fail it.
- **Metrics:** `/metrics` in Prometheus format.
- **Availability:** 99.5% of minutes over 30 days, checked from outside by [`uptime/`](uptime/). That leaves **216 minutes** of error budget a month. The policy for spending it is in [docs/SLO.md](docs/SLO.md).
- **Load test:** `npm run loadtest` in `server/`. It exits with code 1 if an SLO is missed.

## 📟 When the turkey's burning: on call

- **[PAGE]**: players can't reach the game and the error budget is burning fast (14.4× over an hour). Act now.
- **[TICKET]**: a slow leak, a latency SLO missed for 10 minutes, or the uptime checker itself breaking. Look tomorrow.
- **One outage, two emails:** firing and resolved. Rules and their simulated-outage tests are in `uptime/src/alerts.mjs` and `uptime/test/`; run them with `node --test uptime/test/alerts.test.mjs`.
- **The [runbook](docs/RUNBOOK.md)** says what to do for each alert. Read the [postmortems](docs/postmortems/) and the [game day](docs/gameday-2026-11-02.md) (the day we burned the turkey on purpose) before your first shift.

## 🚚 From the farm to the table: shipping

**Push to `main`. That's the whole recipe.** Details in [docs/CI-CD.md](docs/CI-CD.md).

1. **CI taste-tests every push:** unit tests, ShellCheck, cfn-lint, the Caddyfile checked with production's Caddy version, and a 60-player load test. Any missed SLO turns the build red.
2. **The deploy gate checks the pantry:** it ships only if more than 25% of the error budget is left and it isn't Thanksgiving week (Nov 23 to 29). Urgent fixes can run by hand with "emergency" and a reason.
3. **It serves, then tastes:** short-lived AWS credentials (no keys stored in GitHub), install, then a smoke test that waits for `/health` to report the new commit.
4. **Burnt? Back to the last good batch:** if the smoke test fails, the previous version is restored automatically.

From `git push` to players: about 94 seconds.

## 👩‍🍳 Cook it at home

```bash
cd server
npm install
npm start
```

Open http://localhost:8080 in two browser windows to play against yourself. Run the tests with `npm test`. Without `TABLE_NAME` or `SCORES_FILE` the leaderboard lives in memory.

## 🏠 The $5 farmhouse: what's running

- **Instance:** Lightsail `gobble-royale`, `nano_3_0` plan (2 vCPU, 512 MB RAM, 1 TB transfer), Ubuntu 24.04, us-east-1a.
- **Static IP:** `gobble-royale-ip` = `98.88.244.8` (free while attached).
- **Firewall:** 80 and 443 open to everyone. SSH (22) only from the Lightsail browser console; a deploy opens it to its own runner and closes it again.
- **First boot:** [`infra/lightsail-setup.sh`](infra/lightsail-setup.sh) runs as the launch script. It installs Caddy and Node 22 (checked against nodejs.org's checksums), adds a 1 GB swap file, runs the game as a locked-down systemd service (`gobble`), and puts Caddy in front. Lightsail runs launch scripts with `sh`, so the script avoids bash-only syntax.

### Ship by hand (if GitHub is out of the kitchen)

```bash
bash update-lightsail.sh
```

This zips `server/`, uploads it to the source bucket, and prints a one-line command. Open the instance in the [Lightsail console](https://lightsail.aws.amazon.com/ls/webapp/us-east-1/instances/gobble-royale/connect), click **Connect using SSH**, and paste the command. The server installs the new version and restarts the game; players reconnect by themselves, and scores and status metrics are kept.

### Handy commands on the server
```bash
systemctl status gobble caddy        # is it running?
journalctl -u gobble -n 50           # game logs
sudo cat /var/lib/gobble/scores.json # the leaderboard
```

## 🧾 The bill

| Dish | Per month |
|---|---|
| Lightsail nano with IPv4, 1 TB of data out included | **$5.00** |
| Uptime checker (Lambda, scheduler, DynamoDB, logs) | about $0.15 (often $0 on the free tier) |
| Two CloudWatch alarms watching the checker | about $0.20 |
| Leftovers from the first ECS setup (idle S3, CodeBuild, ECR, DynamoDB) | fractions of a cent |
| **Total** | **about $5.35** |

Each player uses about 3 KB per second, so the included 1 TB covers about 185 hours of 500 players. Set an AWS Budget alert before you share the link.

## 🦃 Feeding a bigger crowd: ECS Express Mode

`bash deploy.sh` still works. It builds the image in CodeBuild and runs it on ECS Express Mode with a load balancer, 1 to 3 Fargate tasks, and scores in DynamoDB (`TABLE_NAME`). That handles more players but costs about $35 a month. One $5 server handles hundreds of players, so you probably won't need it.

## 🧹 Clearing the table after Thanksgiving

```bash
aws lightsail delete-instance --instance-name gobble-royale
aws lightsail release-static-ip --static-ip-name gobble-royale-ip
aws cloudformation delete-stack --stack-name gobble-royale-uptime          # checker, alerts, alarms
aws cloudformation delete-stack --stack-name gobble-royale-github-deploy   # the GitHub deploy role
aws ecr delete-repository --repository-name gobble-royale --force
aws s3 rm s3://<SourceBucket output>/ --recursive   # the stack can't delete a bucket that isn't empty
aws cloudformation delete-stack --stack-name gobble-royale-base
```

Release the static IP too: a static IP that isn't attached to an instance is billed. Don't leave a turkey in the oven. 🦃
