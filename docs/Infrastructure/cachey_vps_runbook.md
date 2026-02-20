# 🧠 Cachey VPS Runbook (3AM Survival Guide)

Author: Krishna Reddy GV Purpose: Full operational recovery + debug
manual Environment: Ubuntu 24.04 VPS (2 vCPU / 8GB RAM / 100GB NVMe)
Database: ClickHouse (Docker, private) Data Source: cdn-telemetry-kit

------------------------------------------------------------------------

# 🚦 0. QUICK HEALTH CHECK (When Something Feels Wrong)

Run these immediately:

``` bash
docker ps
docker stats --no-stream
df -h /
```

If ClickHouse container is NOT running:

``` bash
docker compose -f /srv/docker-compose.yml up -d
```

Check ClickHouse alive:

``` bash
curl -K ~/.ch_curl --get --data-urlencode "query=SELECT 1" http://127.0.0.1:8123/
```

Expected:

    1

------------------------------------------------------------------------

# 🛑 1. How to Stop Everything Safely

Stop ClickHouse:

``` bash
docker stop clickhouse
```

Start again:

``` bash
docker start clickhouse
```

Full restart:

``` bash
docker restart clickhouse
```

Shutdown entire docker stack:

``` bash
docker compose -f /srv/docker-compose.yml down
```

⚠️ Data is safe because volumes are mounted to:

    /srv/clickhouse/data

------------------------------------------------------------------------

# 📊 2. Verify Data Health

Total rows:

``` bash
docker exec -it clickhouse clickhouse-client   --query "SELECT count() FROM cachey.raw_minute"
```

Yesterday row count:

``` bash
docker exec -it clickhouse clickhouse-client   --query "
SELECT count()
FROM cachey.raw_minute
WHERE ts >= toDateTime(toStartOfDay(now() - INTERVAL 1 DAY))
  AND ts <  toDateTime(toStartOfDay(now()))
"
```

Expected ≈ 720000 (based on density).

Min/Max timestamps:

``` bash
docker exec -it clickhouse clickhouse-client   --query "SELECT min(ts), max(ts) FROM cachey.raw_minute"
```

------------------------------------------------------------------------

# 🔄 3. Manually Re-run Yesterday Ingestion

If cron failed:

``` bash
/home/krishna/scripts/seed_yesterday.sh
```

Check logs:

``` bash
tail -n 100 ~/logs/seed_yesterday_$(date -u +%F).log
```

If you see READONLY error → ensure DELETE uses POST. If DateTime parse
fails → ensure format is 'YYYY-MM-DD HH:MM:SS'.

------------------------------------------------------------------------

# 📦 4. Manual JSON Insertion Test

Quick test ingestion:

``` bash
cd ~/cdn-telemetry-kit
source .venv/bin/activate

python3 scripts/emit_json_eachrow.py   --minutes 5   --seed 7   --start 2026-02-20T00:00:00Z | curl -K ~/.ch_curl   "http://127.0.0.1:8123/?query=INSERT%20INTO%20cachey.raw_minute%20FORMAT%20JSONEachRow"   --data-binary @-
```

Then verify row count increased.

------------------------------------------------------------------------

# 💾 5. Disk Emergency Procedure

Check usage:

``` bash
df -h /
```

If \> 80%:

1)  Check ClickHouse size:

``` bash
du -sh /srv/clickhouse/data
```

2)  Manual Docker cleanup:

``` bash
docker system prune -af --volumes
```

3)  Verify TTL:

``` bash
docker exec -it clickhouse clickhouse-client   --query "SHOW CREATE TABLE cachey.raw_minute"
```

Should include:

    TTL ts + toIntervalDay(30)

------------------------------------------------------------------------

# 🧹 6. Cron Jobs Verification

List cron:

``` bash
crontab -l
```

Should contain:

    SHELL=/bin/bash
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

    5 0 * * * /home/krishna/scripts/disk_check.sh
    10 0 * * * /home/krishna/scripts/seed_yesterday.sh
    30 3 * * 0 docker system prune -af --volumes >> /home/krishna/logs/docker_prune.log 2>&1

If cron failed:

``` bash
grep CRON /var/log/syslog
```

------------------------------------------------------------------------

# 🔐 7. Authentication Check

Auth file:

``` bash
ls -la ~/.ch_curl
```

Should be:

    -rw-------

Test:

``` bash
curl -K ~/.ch_curl --get   --data-urlencode "query=SELECT user()"   http://127.0.0.1:8123/
```

Expected:

    cachey_admin

------------------------------------------------------------------------

# 🔎 8. Performance Check

Active queries:

``` bash
docker exec -it clickhouse clickhouse-client   --query "SELECT * FROM system.processes"
```

Table size:

``` bash
docker exec -it clickhouse clickhouse-client   --query "
SELECT table, sum(bytes) / 1024 / 1024 AS MB
FROM system.parts
WHERE database='cachey'
GROUP BY table
"
```

------------------------------------------------------------------------

# 🧯 9. Worst Case Recovery (Container Corrupted)

Stop container:

``` bash
docker stop clickhouse
```

Backup data folder:

``` bash
cp -r /srv/clickhouse/data /srv/clickhouse/data_backup_$(date +%F)
```

Recreate container:

``` bash
docker compose -f /srv/docker-compose.yml up -d
```

Data remains intact via mounted volume.


# 🧠 Cachey VPS Runbook (3AM Survival Guide)

Author: Krishna Reddy GV Purpose: Full operational recovery + debug
manual Environment: Ubuntu 24.04 VPS (2 vCPU / 8GB RAM / 100GB NVMe)
Database: ClickHouse (Docker, private) Data Source: cdn-telemetry-kit

------------------------------------------------------------------------

# 🚦 0. QUICK HEALTH CHECK (When Something Feels Wrong)

Run these immediately:

``` bash
docker ps
docker stats --no-stream
df -h /
```

If ClickHouse container is NOT running:

``` bash
docker compose -f /srv/docker-compose.yml up -d
```

Check ClickHouse alive:

``` bash
curl -K ~/.ch_curl --get --data-urlencode "query=SELECT 1" http://127.0.0.1:8123/
```

Expected:

    1

------------------------------------------------------------------------

# 🛑 1. How to Stop Everything Safely

Stop ClickHouse:

``` bash
docker stop clickhouse
```

Start again:

``` bash
docker start clickhouse
```

Full restart:

``` bash
docker restart clickhouse
```

Shutdown entire docker stack:

``` bash
docker compose -f /srv/docker-compose.yml down
```

⚠️ Data is safe because volumes are mounted to:

    /srv/clickhouse/data

------------------------------------------------------------------------

# 📊 2. Verify Data Health

Total rows:

``` bash
docker exec -it clickhouse clickhouse-client   --query "SELECT count() FROM cachey.raw_minute"
```

Yesterday row count:

``` bash
docker exec -it clickhouse clickhouse-client   --query "
SELECT count()
FROM cachey.raw_minute
WHERE ts >= toDateTime(toStartOfDay(now() - INTERVAL 1 DAY))
  AND ts <  toDateTime(toStartOfDay(now()))
"
```

Expected ≈ 720000 (based on density).

Min/Max timestamps:

``` bash
docker exec -it clickhouse clickhouse-client   --query "SELECT min(ts), max(ts) FROM cachey.raw_minute"
```

------------------------------------------------------------------------

# 🔄 3. Manually Re-run Yesterday Ingestion

If cron failed:

``` bash
/home/krishna/scripts/seed_yesterday.sh
```

Check logs:

``` bash
tail -n 100 ~/logs/seed_yesterday_$(date -u +%F).log
```

If you see READONLY error → ensure DELETE uses POST. If DateTime parse
fails → ensure format is 'YYYY-MM-DD HH:MM:SS'.

------------------------------------------------------------------------

# 📦 4. Manual JSON Insertion Test

Quick test ingestion:

``` bash
cd ~/cdn-telemetry-kit
source .venv/bin/activate

python3 scripts/emit_json_eachrow.py   --minutes 5   --seed 7   --start 2026-02-20T00:00:00Z | curl -K ~/.ch_curl   "http://127.0.0.1:8123/?query=INSERT%20INTO%20cachey.raw_minute%20FORMAT%20JSONEachRow"   --data-binary @-
```

Then verify row count increased.

------------------------------------------------------------------------

# 💾 5. Disk Emergency Procedure

Check usage:

``` bash
df -h /
```

If \> 80%:

1)  Check ClickHouse size:

``` bash
du -sh /srv/clickhouse/data
```

2)  Manual Docker cleanup:

``` bash
docker system prune -af --volumes
```

3)  Verify TTL:

``` bash
docker exec -it clickhouse clickhouse-client   --query "SHOW CREATE TABLE cachey.raw_minute"
```

Should include:

    TTL ts + toIntervalDay(30)

------------------------------------------------------------------------

# 🧹 6. Cron Jobs Verification

List cron:

``` bash
crontab -l
```

Should contain:

    SHELL=/bin/bash
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

    5 0 * * * /home/krishna/scripts/disk_check.sh
    10 0 * * * /home/krishna/scripts/seed_yesterday.sh
    30 3 * * 0 docker system prune -af --volumes >> /home/krishna/logs/docker_prune.log 2>&1

If cron failed:

``` bash
grep CRON /var/log/syslog
```

------------------------------------------------------------------------

# 🔐 7. Authentication Check

Auth file:

``` bash
ls -la ~/.ch_curl
```

Should be:

    -rw-------

Test:

``` bash
curl -K ~/.ch_curl --get   --data-urlencode "query=SELECT user()"   http://127.0.0.1:8123/
```

Expected:

    cachey_admin

------------------------------------------------------------------------

# 🔎 8. Performance Check

Active queries:

``` bash
docker exec -it clickhouse clickhouse-client   --query "SELECT * FROM system.processes"
```

Table size:

``` bash
docker exec -it clickhouse clickhouse-client   --query "
SELECT table, sum(bytes) / 1024 / 1024 AS MB
FROM system.parts
WHERE database='cachey'
GROUP BY table
"
```

------------------------------------------------------------------------

# 🧯 9. Worst Case Recovery (Container Corrupted)

Stop container:

``` bash
docker stop clickhouse
```

Backup data folder:

``` bash
cp -r /srv/clickhouse/data /srv/clickhouse/data_backup_$(date +%F)
```

Recreate container:

``` bash
docker compose -f /srv/docker-compose.yml up -d
```

Data remains intact via mounted volume.

------------------------------------------------------------------------

# 🚀 10. Rebuild From Scratch (If VPS Reset)

1)  Install Docker
2)  Restore /srv/docker-compose.yml
3)  Start ClickHouse
4)  Recreate raw_minute table
5)  Apply TTL
6)  Clone cdn-telemetry-kit
7)  Install venv + numpy + pandas
8)  Restore \~/.ch_curl
9)  Restore cron jobs
10) Run seed script manually

------------------------------------------------------------------------

# 📌 Important Operational Rules

-   GET = read-only in ClickHouse HTTP
-   DELETE/ALTER must use POST
-   ClickHouse DateTime format must be: YYYY-MM-DD HH:MM:SS
-   Never expose 8123 publicly
-   Never commit \~/.ch_curl to GitHub
-   Always verify row count after ingestion
-   Expect heavy disk writes on first big load (MergeTree merges)

------------------------------------------------------------------------

End of Runbook.
