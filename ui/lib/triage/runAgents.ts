import type { AgentResult, EvidenceBundle } from "@/lib/triage/types";
import { cacheAgent } from "@/lib/triage/cacheAgent";
import { errorsAgent } from "@/lib/triage/errorsAgent";
import { latencyAgent } from "@/lib/triage/latencyAgent";
import { scopeAgent } from "@/lib/triage/scopeAgent";
import { trafficAgent } from "@/lib/triage/trafficAgent";

export function runAgents(bundle: EvidenceBundle): AgentResult[] {
  const agents: AgentResult[] = [
    scopeAgent(bundle),
    trafficAgent(bundle),
    latencyAgent(bundle),
    errorsAgent(bundle),
    cacheAgent(bundle),
  ];

  return agents;
}