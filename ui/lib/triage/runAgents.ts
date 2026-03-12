import type { AgentResult, EvidenceBundle } from "@/lib/triage/types";
import { scopeAgent } from "@/lib/triage/scopeAgent";
import { trafficAgent } from "@/lib/triage/trafficAgent";
import { latencyAgent } from "@/lib/triage/latencyAgent";
import { errorsAgent } from "@/lib/triage/errorsAgent";
import { cacheAgent } from "@/lib/triage/cacheAgent";

export function runAgents(bundle: EvidenceBundle): AgentResult[] {
  return [
    scopeAgent(bundle),
    trafficAgent(bundle),
    latencyAgent(bundle),
    errorsAgent(bundle),
    cacheAgent(bundle),
  ];
}