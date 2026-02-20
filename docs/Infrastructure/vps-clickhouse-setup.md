# 🧱 Cachey Infrastructure Setup (VPS + ClickHouse)
Author: Krishna Reddy GV

## Infrastructure

Cachey runs on a self-managed Ubuntu VPS with Docker and ClickHouse.

This document captures the exact infrastructure steps used to deploy Cachey’s analytics backend. It exists to ensure reproducibility and prevent configuration drift.

## 📍 Environment

-   VPS: Ubuntu 24.04 LTS
-   Docker-based deployment
-   ClickHouse bound to `127.0.0.1`
-   Access-managed users (admin + read-only)
-   Designed for production-style analytics backend

------------------------------------------------------------------------

# 1️⃣ Initial Server Setup

## SSH into server

``` bash
ssh root@<SERVER_IP>
```

## Update system

``` bash
apt update && apt upgrade -y
```

## Create non-root user

``` bash
adduser krishna
usermod -aG sudo krishna
```

## Disable root SSH login

``` bash
sudo nano /etc/ssh/sshd_config
PermitRootLogin no
sudo systemctl restart ssh
```

------------------------------------------------------------------------

# 2️⃣ Firewall Configuration (UFW)

``` bash
sudo ufw allow OpenSSH
sudo ufw enable
sudo ufw status
```

------------------------------------------------------------------------

# 3️⃣ Install Docker (Official Repository)

``` bash
sudo apt install ca-certificates curl gnupg -y
sudo install -m 0755 -d /etc/apt/keyrings

curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin -y
```

Add user to docker group:

``` bash
sudo usermod -aG docker krishna
```

Refresh session:

``` bash
newgrp docker
```

Test:

``` bash
docker run hello-world
```

------------------------------------------------------------------------

# 4️⃣ ClickHouse Deployment

## Create directory structure

``` bash
sudo mkdir -p /srv/clickhouse/{data,logs}
sudo chown -R krishna:krishna /srv
```

## /srv/docker-compose.yml

``` yaml
services:
  clickhouse:
    image: clickhouse/clickhouse-server:latest
    container_name: clickhouse
    restart: unless-stopped
    ports:
      - "127.0.0.1:8123:8123"
      - "127.0.0.1:9000:9000"
    environment:
      CLICKHOUSE_DB: cachey
      CLICKHOUSE_USER: cachey_admin
      CLICKHOUSE_PASSWORD: "YOUR_ADMIN_PASSWORD"
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1"
    volumes:
      - /srv/clickhouse/data:/var/lib/clickhouse
      - /srv/clickhouse/logs:/var/log/clickhouse-server
```

Start service:

``` bash
docker compose -f /srv/docker-compose.yml up -d
```

------------------------------------------------------------------------

# 5️⃣ Verify Admin Access

``` bash
curl -u cachey_admin:ADMIN_PASS 'http://127.0.0.1:8123/?query=SELECT%201'
```

Expected:

    1

------------------------------------------------------------------------

# 6️⃣ Create Read-Only User (POST Required)

⚠️ GET = read-only in ClickHouse HTTP\
All modifying queries must use POST.

Generate password:

``` bash
export CACHEY_RO_PASS=$(openssl rand -base64 24)
```

Create user:

``` bash
curl -u cachey_admin:ADMIN_PASS   --data-binary "CREATE USER IF NOT EXISTS cachey_ro   IDENTIFIED WITH sha256_password BY '${CACHEY_RO_PASS}';"   "http://127.0.0.1:8123/"
```

Grant SELECT permissions:

``` bash
curl -u cachey_admin:ADMIN_PASS   --data-binary "GRANT SELECT ON cachey.* TO cachey_ro;"   "http://127.0.0.1:8123/"
```

Test:

``` bash
curl -u cachey_ro:${CACHEY_RO_PASS} "http://127.0.0.1:8123/?query=SHOW%20DATABASES"
```

------------------------------------------------------------------------

# 7️⃣ Create Raw Telemetry Table

``` bash
curl -u cachey_admin:ADMIN_PASS --data-binary @- "http://127.0.0.1:8123/?database=cachey" <<'SQL'
CREATE TABLE IF NOT EXISTS cdn_logs_raw
(
  ts DateTime64(3, 'UTC'),
  partner LowCardinality(String),
  service LowCardinality(String),
  region LowCardinality(String),
  pop LowCardinality(String),
  url_type LowCardinality(String),
  status UInt16,
  cache_status LowCardinality(String),
  ttms_ms UInt32,
  bytes UInt64,
  ua_family LowCardinality(String),
  request_id String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (partner, service, region, pop, ts);
SQL
```

Verify:

``` bash
curl -u cachey_admin:ADMIN_PASS "http://127.0.0.1:8123/?database=cachey&query=SHOW%20TABLES"
```

------------------------------------------------------------------------

# 8️⃣ 5-Minute Aggregation Query

``` bash
curl -u cachey_admin:ADMIN_PASS --data-binary @- "http://127.0.0.1:8123/?database=cachey" <<'SQL'
SELECT
  toStartOfFiveMinute(ts) AS bucket,
  partner,
  service,
  region,
  count() AS requests,
  quantile(0.95)(ttms_ms) AS p95_ms,
  round(100.0 * avg(cache_status = 'HIT'), 2) AS hit_pct,
  round(100.0 * avg(status >= 500), 2) AS err5xx_pct
FROM cdn_logs_raw
GROUP BY bucket, partner, service, region
ORDER BY bucket DESC
LIMIT 20;
SQL
```

------------------------------------------------------------------------

# 🔐 Security Decisions

-   Database bound to localhost only
-   Separate admin and read-only users
-   Access management enabled
-   No public DB exposure
-   Principle of least privilege

------------------------------------------------------------------------

# 🚀 Next Phase

-   Generator → JSONEachRow → ClickHouse ingestion
-   5-minute aggregation automation
-   Reverse proxy (Caddy) + HTTPS
-   Vercel → API → ClickHouse (RO user only)

# 🧱 Cachey Infrastructure Setup (VPS + ClickHouse)

### (Telemetry Pipeline + Automation)

------------------------------------------------------------------------

## 📍 Environment 

-   Deterministic telemetry generator (`cdn-telemetry-kit`)
-   JSONEachRow ingestion via HTTP
-   Raw minute analytics table (`raw_minute`)
-   30-day TTL retention policy
-   Daily automated ingestion (cron)
-   Weekly Docker cleanup
-   Daily disk usage monitoring

Sensitive information redacted. Never commit real passwords to GitHub.

------------------------------------------------------------------------

# 9️⃣ Create `raw_minute` Analytics Table

``` bash
docker exec -it clickhouse clickhouse-client --query "
CREATE TABLE IF NOT EXISTS cachey.raw_minute
(
  seed UInt16,

  ts DateTime,
  partner LowCardinality(String),
  service LowCardinality(String),
  region LowCardinality(String),
  pop LowCardinality(String),
  host LowCardinality(String),
  content_type LowCardinality(String),
  ua_family LowCardinality(String),

  requests UInt32,
  bytes_sent UInt64,
  p50_ms Float32,
  p95_ms Float32,
  p99_ms Float32,
  cache_hit_rate Float32,

  http_2xx_count UInt32,
  http_3xx_count UInt32,
  http_4xx_count UInt32,
  http_5xx_count UInt32,

  status_200 UInt32,
  status_206 UInt32,
  status_304 UInt32,
  status_403 UInt32,
  status_404 UInt32,
  status_429 UInt32,
  status_500 UInt32,
  status_502 UInt32,
  status_503 UInt32,
  status_504 UInt32,

  crc_errors UInt32
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (partner, service, region, pop, ts, content_type, ua_family, host)
"
```

------------------------------------------------------------------------

# 🔄 10️⃣ Apply 30-Day TTL Retention

``` bash
docker exec -it clickhouse clickhouse-client   --query "ALTER TABLE cachey.raw_minute MODIFY TTL ts + INTERVAL 30 DAY DELETE;"
```

Verify:

``` bash
docker exec -it clickhouse clickhouse-client   --query "SHOW CREATE TABLE cachey.raw_minute"
```

Look for:

    TTL ts + toIntervalDay(30)

------------------------------------------------------------------------

# 🔧 11️⃣ Telemetry Generator Setup (VPS)

Clone repository:

``` bash
git clone https://github.com/<REDACTED>/cdn-telemetry-kit.git
cd cdn-telemetry-kit
```

Install Python environment:

``` bash
sudo apt install python3-venv python3-pip -y
python3 -m venv .venv
source .venv/bin/activate
pip install numpy pandas
```

Test JSON emission:

``` bash
python3 scripts/emit_json_eachrow.py   --minutes 10   --seed 7   --start 2026-02-20T00:00:00Z | head -n 2
```

------------------------------------------------------------------------

# 🚀 12️⃣ Manual JSONEachRow Ingestion

``` bash
python3 scripts/emit_json_eachrow.py   --minutes 10   --seed 7   --start 2026-02-20T00:00:00Z | curl -K ~/.ch_curl   "http://127.0.0.1:8123/?query=INSERT%20INTO%20cachey.raw_minute%20FORMAT%20JSONEachRow"   --data-binary @-
```

Verify:

``` bash
docker exec -it clickhouse clickhouse-client   --query "SELECT count() FROM cachey.raw_minute"
```

------------------------------------------------------------------------

# 🔐 13️⃣ Secure Curl Authentication

Create protected auth file:

``` bash
cat > ~/.ch_curl <<'EOF'
user = "cachey_admin:<REDACTED_PASSWORD>"
EOF
chmod 600 ~/.ch_curl
```

Test:

``` bash
curl -K ~/.ch_curl --get   --data-urlencode "query=SELECT user()"   http://127.0.0.1:8123/
```

------------------------------------------------------------------------

# 🔁 14️⃣ Daily Seed Automation

Script location:

    ~/scripts/seed_yesterday.sh

Responsibilities:

-   Compute yesterday UTC boundaries
-   DELETE yesterday range (POST)
-   Insert 1440 minutes
-   Validate row count
-   Log execution

Logs:

    ~/logs/seed_yesterday_YYYY-MM-DD.log

------------------------------------------------------------------------

# ⏰ 15️⃣ Cron Jobs

``` cron
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

5 0 * * * /home/krishna/scripts/disk_check.sh
10 0 * * * /home/krishna/scripts/seed_yesterday.sh
30 3 * * 0 docker system prune -af --volumes >> /home/krishna/logs/docker_prune.log 2>&1
```

------------------------------------------------------------------------

# 💾 16️⃣ Disk Monitoring

Create:

``` bash
~/scripts/disk_check.sh
```

Function:

-   Log disk usage daily
-   Alert if ≥ 80%
-   Prevent silent disk exhaustion

------------------------------------------------------------------------

# 🔒 Security Model (Final State)

-   ClickHouse bound to `127.0.0.1`
-   Admin user: `cachey_admin` (write access)
-   Read-only user: `cachey_ro` (future API use)
-   Credentials stored locally only (never committed)
-   Principle of least privilege enforced
-   30-day TTL prevents runaway disk growth

------------------------------------------------------------------------

# 🧠 Operational Notes

-   GET = read-only in ClickHouse HTTP
-   All DELETE/ALTER/CREATE must use POST
-   ClickHouse DateTime requires: `YYYY-MM-DD HH:MM:SS`
-   Cron runs minimal environment → define SHELL and PATH explicitly
-   First large ingestion triggers heavy merge I/O (expected)

------------------------------------------------------------------------

# 📈 Future Extensions

-   Materialized 5-minute aggregation table(For now 1-min works well)
-   Anomaly detection (z-score in ClickHouse)
-   API layer using read-only user
-   Reverse proxy (Caddy) + HTTPS
-   Observability stack (Grafana/ELK)

------------------------------------------------------------------------

