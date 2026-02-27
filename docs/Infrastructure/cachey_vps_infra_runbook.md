# Cachey VPS Infrastructure Runbook (Redacted)

## Overview

This document describes the secure, production-style VPS setup for
Cachey: - Caddy (TLS termination + Basic Auth) - cachey-proxy (localhost
gatekeeper with token + rate limiting) - ClickHouse (localhost-only
database) - Vercel → VPS → ClickHouse end-to-end wiring

All secrets are redacted. This document is safe for public GitHub.

------------------------------------------------------------------------

# High-Level Architecture

Internet\
→ Caddy (HTTPS + Basic Auth)\
→ cachey-proxy (127.0.0.1:8787, token validation + rate limit)\
→ ClickHouse (127.0.0.1:8123, private)

Security principle: Only ports 22, 80, 443 exposed publicly.

------------------------------------------------------------------------

# Phase 1 --- Baseline Host Security

-   OS updated
-   UFW enabled with default deny inbound
-   Only SSH allowed initially

Commands:

    sudo apt update && sudo apt -y upgrade
    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw allow 22/tcp
    sudo ufw enable
    sudo ufw status verbose

------------------------------------------------------------------------

# Phase 2 --- SSH Hardening + Fail2ban

-   Root login disabled
-   Only specific user allowed
-   Fail2ban enabled

Verify:

    sudo fail2ban-client status sshd
    grep -E "PermitRootLogin|AllowUsers" /etc/ssh/sshd_config

------------------------------------------------------------------------

# Phase 3 --- ClickHouse Local-Only Binding

ClickHouse must bind only to localhost.

Verify:

    ss -lntp | egrep '8123|9000'

Expected: 127.0.0.1 only.

------------------------------------------------------------------------

# Phase 4 --- DNS + Domain

-   api.cachey.cloud A record → VPS IPv4

Verify from local machine:

    dig +short api.cachey.cloud

------------------------------------------------------------------------

# Phase 5 --- Caddy (TLS + Edge Auth)

Caddy handles: - HTTPS certificates (auto) - Basic Auth - Reverse proxy
to localhost proxy

Template (example):

    api.cachey.cloud {
        basicauth /* {
            <USER> <BCRYPT_HASH>
        }

        reverse_proxy 127.0.0.1:8787
    }

Verify:

    sudo systemctl status caddy
    sudo ss -lntp | egrep ':80|:443'

------------------------------------------------------------------------

# Phase 6 --- cachey-proxy Gatekeeper

Node proxy running on 127.0.0.1:8787

Responsibilities: - Validate x-cachey-token - Optional rate limit per
minute - Execute ClickHouse HTTP queries - Anchor to max(ts) when
debug=true

Verify:

    sudo systemctl status cachey-proxy
    curl http://127.0.0.1:8787/health

------------------------------------------------------------------------

# Phase 7 --- systemd Hardening

Template:

    [Unit]
    Description=Cachey Proxy (localhost gatekeeper)
    After=network-online.target

    [Service]
    Type=simple
    WorkingDirectory=/opt/cachey-proxy
    EnvironmentFile=/etc/cachey/proxy.env
    ExecStart=/usr/bin/node /opt/cachey-proxy/server.js
    Restart=always
    User=cachey
    Group=cachey

    NoNewPrivileges=true
    PrivateTmp=true
    ProtectSystem=strict
    ProtectHome=true

    [Install]
    WantedBy=multi-user.target

Verify:

    sudo systemctl status cachey-proxy

------------------------------------------------------------------------

# Phase 8 --- End-to-End Verification

## 1. Health (Basic Auth required)

    curl -u <USER>:<PASS> https://api.cachey.cloud/health

## 2. Token Required

    curl -u <USER>:<PASS> -X POST https://api.cachey.cloud/triage -d '{}'

Expected: unauthorized

## 3. Full Triage Test

    TOKEN=$(sudo grep '^CACHEY_TOKEN=' /etc/cachey/proxy.env | cut -d= -f2)

    curl -u <USER>:<PASS> -X POST https://api.cachey.cloud/triage   -H "x-cachey-token: $TOKEN"   -H "content-type: application/json"   -d '{"partner":"partner_01","service":"all","region":"all","pop":"all","windowMinutes":60,"debug":true}' | jq '{ok, reqs:.metricsJson.totalRequests, anchor:.metricsJson.debug.anchorMode}'

Expected: - ok: true - reqs: \> 0 - anchor: "max(ts)"

------------------------------------------------------------------------

# Security Layers Summary

1.  UFW Firewall
2.  SSH Hardening
3.  Fail2ban
4.  ClickHouse localhost-only
5.  Caddy HTTPS
6.  Basic Auth at edge
7.  Token validation at proxy
8.  Rate limiting
9.  systemd sandboxing

------------------------------------------------------------------------

# Secret Rotation Procedure

If any credential is suspected exposed:

Rotate: - CACHEY_TOKEN - CLICKHOUSE_PASSWORD - Basic Auth password

Then:

    sudo systemctl restart cachey-proxy
    sudo systemctl reload caddy

------------------------------------------------------------------------

# Verification Checklist (Quick Audit)

    sudo ufw status verbose
    sudo fail2ban-client status sshd
    sudo systemctl status caddy
    sudo systemctl status cachey-proxy
    ss -lntp | egrep ':80|:443|8123|8787'

------------------------------------------------------------------------

End of Document
