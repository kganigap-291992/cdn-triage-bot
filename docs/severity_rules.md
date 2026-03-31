## 📊 Cachey — Signal Severity Thresholds (v1)

Defines how Cachey classifies system health based on **video delivery performance signals**.

---

### 🟢 Severity Levels

| Level | Meaning |
|------|--------|
| **healthy** | System operating normally |
| **early_warning** | Slight degradation, monitor closely |
| **performance_issue** | Noticeable user impact |
| **major_incident** | Severe impact, immediate action required |

---

## ⚡ Latency (p95)

> Primary indicator of playback experience

| Severity | Threshold |
|----------|----------|
| healthy | < 800 ms |
| early_warning | ≥ 800 ms |
| performance_issue | ≥ 1000 ms (1s) |
| major_incident | ≥ 2000 ms (2s) |

✔ Based on video QoE expectations (startup + buffering sensitivity)

---

## ❌ Errors (5xx Rate)

> Measures backend/origin/CDN failure rate

| Severity | Threshold |
|----------|----------|
| healthy | < 1% |
| early_warning | ≥ 1% |
| performance_issue | ≥ 5% |
| major_incident | ≥ 10% |

✔ Even small increases matter at scale  
✔ 5%+ typically user-visible

---

## 🧊 Cache Hit Rate

> Core CDN efficiency + origin pressure signal

| Severity | Threshold |
|----------|----------|
| healthy | ≥ 90% |
| early_warning | < 90% |
| performance_issue | < 85% |
| major_incident | < 75% |

✔ Lower cache hit rate → higher origin load → cascading failures  
✔ <75% is usually **systemic issue**, not noise

---

## 🧠 Important Notes

- Cachey normalizes cache hit rate:
  - `0.73` → `73%`
- Thresholds are evaluated on:
  - **current window metrics**
- Previous window is used for:
  - context in explanations (not threshold decisions)

---

## 🎯 Severity Calculation Logic

- Each signal (latency, errors, cache) is evaluated independently  
- Final severity = **worst signal**  
- Cache is often the dominant signal in CDN systems  

---

## 🧩 Example

```json
{
  "severity": "major_incident",
  "primarySignal": "cache",
  "reason": "cache hit rate is 73.39% (< 75%) vs previous 74.18%"
}