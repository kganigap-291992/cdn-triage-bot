# Cachey — Intent Parsing & Normalization Design

## Overview
This document defines the deterministic intent parsing and normalization layer for Cachey.

Goal:
- Accept natural chat input
- Convert to structured triage queries
- Keep backend contract strict and unchanged

This layer runs BEFORE `/api/triage`.

---

## High-Level Flow
User Input
→ Intent Parser
→ Normalizer
→ Scope Resolution
→ API Call (/api/triage)

---

## Core Design Principles

### 1. Canonical API Contract (STRICT)
Only canonical values are allowed beyond parsing.

Examples:
- partner_01
- live
- us-east
- pop_003

Aliases must never reach:
- API
- Proxy (Caddy)
- ClickHouse

---

### 2. Alias Handling at UI Edge Only
Aliases are accepted only in:
- Chat input
- UI parsing layer

They are resolved before API execution.

---

### 3. Schema-Driven Normalization
All aliases are defined centrally in:

lib/schema/canonical.ts

No alias logic in:
- UI components
- API routes
- runners

---

### 4. Deterministic Parsing (No LLM)
Intent detection is rule-based.

No LLM used for:
- trigger detection
- scope extraction
- normalization

---

### 5. Separation of Concerns

canonical.ts → vocab + alias metadata  
normalize.ts → alias → canonical resolution  
intent.ts → intent detection + parsing  
page.tsx → UI + prompting + execution  
route.ts → validation + triage execution  

---

## Schema Design

### Canonical Values (UNCHANGED)

CANON = {
  partners: ["partner_01", "partner_02", "partner_03"],
  services: ["live", "vod", "dvr", "eas", "live_ott", "app_backend"],
  regions: ["us-east", "us-west", "eu-west"],
  pops: ["pop_001", "pop_002", "pop_003"]
}

These remain unchanged for compatibility.

---

### Metadata (NEW — Parallel)

Each entry contains:
- value (canonical)
- label (display)
- aliases (safe inputs)

---

## Service Aliases (Phase 1)

live:
- live
- linear
- live tv
- live-tv

vod:
- vod
- on demand
- ondemand

dvr:
- dvr
- cdvr
- recording
- recordings

eas:
- eas

live_ott:
- tve
- ott

app_backend:
- app_backend

---

## Alias Policy

Allowed:
- explicit
- low ambiguity
- domain-safe

Not allowed:
- streaming
- app
- tv
- video
- generic terms

---

## Normalization Rules

Before matching:
- lowercase input
- replace '_' with space
- trim whitespace
- collapse multiple spaces

Examples:
- Live_TV → live tv
- OnDemand → ondemand

---

## Intent Detection

### MUST TRIGGER
Examples:
- how was live last night
- check errors
- investigate vod latency
- partner 1 live

Signals:
- investigation verbs
- health-check phrasing
- metric keywords
- time + scope

---

### CONDITIONAL TRIGGER
Requires prior context:
- what about vod
- check it again
- only us-east
- compare with previous

---

### NEVER TRIGGER
Examples:
- hi
- thanks
- hello live team
- partner 1 meeting

---

## Scope Extraction

Parser extracts:
- partner
- service
- region (optional)
- pop (optional)
- metric hint
- time hint

---

## Missing Scope Handling

If intent is valid but incomplete:

Missing service → ask for service  
Missing partner → ask for partner  
Missing both → ask for service first  

---

### Sticky Behavior

If value exists in UI state:
- use silently
- do not prompt

---

## Example Behavior

Input: how was live last night  
→ service=live  
→ partner missing  
→ prompt for partner  

Input: check partner 1  
→ partner=partner_01  
→ service missing  
→ prompt for service  

Input: live in partner 1  
→ run triage  

Input: hello live team  
→ do not trigger  

---

## Follow-Up Handling

Requires prior context:
- check it again
- what about vod
- only us-east

Without context → reject or prompt

---

## Non-Goals (Phase 1)

- No LLM parsing
- No fuzzy matching
- No probabilistic scoring
- No backend contract changes

---

## Future Extensions

- LLM layer on top of parser
- Context memory (Redis)
- Region / POP alias expansion
- Multi-turn refinement
- Intent confidence scoring

---

## Summary

This system:
- Accepts natural input
- Resolves aliases safely
- Maintains strict API contracts
- Improves UX without infra changes

This forms the foundation for future LLM enhancements.
