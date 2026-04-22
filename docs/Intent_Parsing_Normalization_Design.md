# Cachey — Intent Parsing & Normalization Design (Enhanced)

## Overview
This document defines the deterministic intent parsing and normalization layer for Cachey,
extended with language normalization and future LLM integration.

Text → Clean → Understand → Validate → Execute → Explain

Messy Input → Structured Intent → Deterministic Truth → LLM Explanation

---

## 🏗️ Full System Flow (Updated)

User Input  
→ Language Normalization  
→ Intent Parser  
→ Scope Resolution  
→ Deterministic Engine (/api/triage)  
→ Canonical Result  
→ UI + (Optional LLM Layer)  

---

## 🔒 Core Principle

Deterministic engine = source of truth  
LLM = assistant layer (never replaces deterministic logic)

---

## 🧩 Existing System (Preserved)

- Canonical contract enforcement  
- Alias handling only at UI edge  
- Schema-driven normalization  
- Deterministic parsing  
- Strict backend inputs  

---

## 🆕 Language Normalization Layer (NEW)

### Purpose
Handle messy human input before parsing.

### Responsibilities
- Fix typos
- Normalize shorthand
- Map synonyms
- Standardize time

---

### Example

Input:
ats over 24hts  

Normalized:
ats over 24 hours  

---

## 🔁 Repair-Then-Retry Flow

Input → Normalize → Parse  
→ Low confidence?  
→ Repair input  
→ Re-parse  
→ Success OR clarification  

---

### Example Flow

ats over 24hts  
→ normalize  
→ repair → 24 hours  
→ parse → exploration timeseries  

---

## 🧠 Intent Parsing (Existing + Extended)

### Stage 1 — Lane

- triage  
- exploration  
- drill  
- compare  
- explain  
- clarification  
- guardrail  

---

### Stage 2 — Shape

- timeseries  
- breakdown  
- compare  
- summary  

---

## 📦 Parsed Intent Object

rawText  
normalizedText  
repairedText  

lane  
metric  
view  
dimension  

timeOverride  
scopeChanges  

confidence  

---

## ⚙️ Deterministic Engine

Handles:
- triage
- exploration
- drill
- compare

Produces:
- metricsJson
- evidence
- structured outputs

---

## 📊 Canonical Result Contract

Each result includes:

- normalizedScope  
- overallState  
- primarySignal  
- summary  
- keyFindings  
- nextActions  
- graphs  
- ATS summary  
- evidence  

---

## 🤖 LLM Integration (Future Layer)

### Where LLM is used

1. Parser fallback (low confidence only)  
2. Clarification prompts  
3. Explanation layer  
4. Follow-up suggestions  

---

## 🚫 LLM Guardrails

LLM must NOT:
- Generate metrics  
- Invent data  
- Change scope  
- Override deterministic results  

---

## 🔍 End-to-End Example

Input:
ats over 24hts  

Step 1: Normalize  
ats over 24hts  

Step 2: Repair  
ats over 24 hours  

Step 3: Parse  
exploration → ATS → timeseries → 24h  

Step 4: Execute  
Run deterministic query  

Step 5: Render  
Graph + summary  

Step 6: LLM (optional)  
Explain results  

---


User Input
   ↓
[Normalization Layer]
   ↓
[Intent Parser]
   ↓
[Confidence Check]
   ↓
 ┌───────────────┬────────────────────┐
 │ High Confidence │ Low Confidence    │
 │                │                    │
 ↓                ↓
Execute        Repair Layer
                ↓
             Re-Parse
                ↓
        ┌───────────────┬──────────────┐
        │ Success        │ Still Weak   │
        ↓                ↓
     Execute        Clarification
                        ↓
                    (User reply)


---

User Input
   ↓
────────────────────────────
🧩 Language Normalization
────────────────────────────
- lowercase
- clean text
- fix shorthand (hrs → hours)
- map synonyms (cache → ats)

   ↓

────────────────────────────
🧠 Intent Parsing
────────────────────────────
Stage 1 → Lane
  - triage
  - exploration
  - drill
  - compare
  - explain

Stage 2 → Shape
  - timeseries
  - breakdown
  - compare

   ↓

────────────────────────────
📊 Parsed Intent Object
────────────────────────────
- metric (ats / latency / errors / requests)
- time (24h / absolute)
- dimension (pop / region / ua)
- scope overrides
- confidence score

   ↓

────────────────────────────
⚠️ Confidence Gate
────────────────────────────
IF confidence ≥ threshold → Execute  
IF confidence < threshold → Repair  

   ↓

────────────────────────────
🔁 Repair Layer
────────────────────────────
- fix typos (24hts → 24 hours)
- retry parse

   ↓

────────────────────────────
🧠 Deterministic Engine
────────────────────────────
- triage
- exploration
- drill
- compare

   ↓

────────────────────────────
📦 Evidence Bundle
────────────────────────────
- metricsJson
- summaries
- breakdowns
- graphs
- ATS stats

   ↓

────────────────────────────
🎨 UI Rendering
────────────────────────────
- triage card
- exploration card
- graphs
- tables

   ↓

────────────────────────────
🤖 LLM Layer (Optional)
────────────────────────────
- explain results
- suggest follow-ups
- ask clarification

(LLM NEVER changes data)

## 🧠 Exploration Mode Rules

- Uses locked partner + service  
- Read-only  
- Does not change investigation  

---

## 🚀 Implementation Phases

Phase 1 — Normalization layer  
Phase 2 — Parser upgrade  
Phase 3 — Agent output hardening  
Phase 4 — LLM integration  

---

## 🎯 Final Goal

Understand messy language  
→ Convert to structured intent  
→ Execute deterministically  
→ Explain clearly using LLM  

