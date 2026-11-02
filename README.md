# 🦃 Gobble Royale

A live multiplayer turkey battle royale for Thanksgiving. Everyone online is a turkey on one shared field. The Chef chases the nearest bird, more Chefs arrive as the round goes on, and the oven closes in. Be the last turkey standing and win it for your state.

Nothing like the Haunted House: no AI writing, no voice. It's a real-time game where strangers play together, and states compete on a live leaderboard.

**Live:** https://gobble.98-88-244-8.sslip.io on one **$5/month** Amazon Lightsail server.

```
Browser ──wss://──►  Lightsail nano ($5/mo, 1 TB transfer included, static IP)
                        ├─ Caddy: HTTPS on 443, free Let's Encrypt certificate, WebSockets passed through
                        └─ Node.js on 127.0.0.1:8080
                              ├─ serves the page (public/)
                              ├─ runs every arena at 30 ticks/s, sends 15 snapshots/s
                              └─ scores ──► /var/lib/gobble/scores.json (saved every 5s and on shutdown)
```

The address comes from [sslip.io](https://sslip.io), a free DNS service that maps `gobble.98-88-244-8.sslip.io` to the server's IP, so Let's Encrypt can issue a certificate without you buying a domain. If you buy one later, point it at `98.88.244.8` and change the host in `/etc/caddy/Caddyfile`.

## Is it healthy?

- **Live status:** https://gobble.98-88-244-8.sslip.io/status shows the SLOs (p99 tick time, tick lateness, p95 round trip, p95 page response), live p50/p95/p99, and the last hour.
- **Metrics:** `/metrics` in Prometheus format.
- **Load test:** `npm run loadtest` in `server/`. It exits with code 1 if an SLO is missed.
- **Uptime from outside:** [`uptime/`](uptime/) is a Lambda that checks every minute whether a player could load the page and open the game connection. The status page shows 30-day availability, the error budget, and burn rate. Deploy with `cd uptime && sam deploy`. Cost: about $0.15 a month (often $0 on the free tier).
- **Alerts:** the same checker emails a **[PAGE]** when the error budget burns fast (a real outage), and a **[TICKET]** for a slow leak, a latency SLO missed for 10 minutes, or the checker itself breaking. Rules and tests are in `uptime/src/alerts.mjs` and `uptime/test/`. Run the tests with `node --test uptime/test/alerts.test.mjs`.
- **The SLOs, error budget policy and alert rules:** [docs/SLO.md](docs/SLO.md).
- **Shipping:** push to `main`. CI runs tests, linters and a load test that blocks slow changes; then the deploy checks the error budget, ships, smoke-tests, and rolls back by itself if needed. See [docs/CI-CD.md](docs/CI-CD.md).
- **On call:** the [runbook](docs/RUNBOOK.md) has what to do for each alert, plus [postmortems](docs/postmortems/) and a [game day](docs/gameday-2026-11-02.md) that tested all of it with a planned outage.
- What's measured, how, and what it found: [docs/observability.md](docs/observability.md).

## How a round works
| | |
|---|---|
| ⏳ Lobby | 6 seconds. Waddle around while others join. |
| 🔔 Run! | Bots fill the field to at least 10 turkeys, so nobody plays alone. The Chef waits 2.5 seconds, then hunts. |
| 👨‍🍳 Chefs | Chase the nearest turkey and aim a little ahead of it. They speed up over time, and more join at 25s and 50s. |
| 🔥 Oven | From 12s the safe ring shrinks. Stay outside for 1.5s and you're roasted. |
| 🌾 Hay bales | Block everyone. Run circles around them. |
| 🪶 Flap | A short burst of speed, recharged after 2.5s. |
| 🏆 Win | Last turkey standing. If the 90s clock runs out, every survivor shares the win. |

## Why it's built this way
- **The server decides everything.** Browsers send only a direction (and "flap"), never a position, so nobody can teleport out of trouble. Speed, collisions and catches all happen on the server.
- **It still feels instant.** Your own turkey moves the moment you press a key and is gently pulled toward the server's position. Other turkeys are drawn 110 ms in the past and blended between snapshots, so they glide instead of jumping.
- **Costs stay flat if it goes viral.** Pay-per-message services (API Gateway WebSockets, AppSync) would cost about $1 for every million messages delivered, and 500 players at 15 updates a second is about 27,000 messages a second. One $5 server costs the same whether 5 or 500 people play, and its 1 TB of included transfer covers about 185 hours of 500 players. In a test, the game loop handled 600 players in about 1 ms per tick, against a budget of 33 ms.
- **No load balancer.** A load balancer alone costs about $16 a month. Caddy on the server does the HTTPS for free.
- **Family-friendly by design.** Names are picked from two word lists ("Sparkly Giblet"), never typed, so there's nothing to moderate.
- **Abuse limits.** At most 4 connections per IP and 40 messages per second per connection, with 512-byte messages. Dead connections are dropped by a 20s ping.

## Run it locally

```bash
cd server
npm install
npm start
```

Open http://localhost:8080 in two browser windows to play against yourself. Without `TABLE_NAME` the leaderboard lives in memory.

## The $5 server (what's running)

- **Instance:** Lightsail `gobble-royale`, `nano_3_0` plan (2 vCPU, 512 MB RAM, 1 TB transfer), Ubuntu 24.04, us-east-1a.
- **Static IP:** `gobble-royale-ip` = `98.88.244.8` (free while attached).
- **Firewall:** 80 and 443 open to everyone. SSH (22) only from the Lightsail browser console.
- **First boot:** [`infra/lightsail-setup.sh`](infra/lightsail-setup.sh) runs as the launch script. It installs Caddy and Node 22 (checked against nodejs.org's checksums), adds a 1 GB swap file, runs the game as a locked-down systemd service (`gobble`), and puts Caddy in front. Lightsail runs launch scripts with `sh`, so the script avoids bash-only syntax.

### Ship an update

```bash
bash update-lightsail.sh
```

This zips `server/`, uploads it to the source bucket, and prints a one-line command. Open the instance in the [Lightsail console](https://lightsail.aws.amazon.com/ls/webapp/us-east-1/instances/gobble-royale/connect), click **Connect using SSH**, and paste the command. The server installs the new version and restarts the game (players reconnect in a few seconds). The scores file is kept.

### Handy commands on the server
```bash
systemctl status gobble caddy        # is it running?
journalctl -u gobble -n 50           # game logs
sudo cat /var/lib/gobble/scores.json # the leaderboard
```

## Cost
- Lightsail nano with IPv4: **$5 a month**, including 1 TB of data out (about 3 KB per second per player, so about 185 hours at 500 players). The static IP is free while attached.
- The S3 source bucket, CodeBuild project, ECR repository and DynamoDB table in the `gobble-royale-base` stack sit idle and cost fractions of a cent. They're left over from the first (ECS) setup, and the S3 bucket is still used for updates.
- Set an AWS Budget alert before you share the link.

## If it gets huge: ECS Express Mode
`bash deploy.sh` still works. It builds the image in CodeBuild and runs it on ECS Express Mode with a load balancer, 1 to 3 Fargate tasks, and scores in DynamoDB (`TABLE_NAME`). That handles more players but costs about $35 a month. One $5 server handles hundreds of players, so you probably won't need it.

## Clean up after Thanksgiving
```bash
aws lightsail delete-instance --instance-name gobble-royale
aws lightsail release-static-ip --static-ip-name gobble-royale-ip
aws ecr delete-repository --repository-name gobble-royale --force
aws s3 rm s3://<SourceBucket output>/ --recursive   # the stack can't delete a bucket that isn't empty
aws cloudformation delete-stack --stack-name gobble-royale-base
```
Release the static IP too: a static IP that isn't attached to an instance is billed.
