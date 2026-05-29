'use strict';

/**
 * BUG-22U — Canonical Traversal Rail Builder
 *
 * Owns:
 * - Stable handoff/edge identity
 * - Canonical hop order
 * - Flow lane grouping
 * - Evidence-carrying traversal records
 *
 * Does NOT own:
 * - narration
 * - pedagogy
 * - camera
 * - rendering
 * - LLM interpretation
 */

const VERSION = 'canonical-traversal-rail-v1';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function uniqueBy(items = [], keyFn) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function getRelationshipId(segment = {}) {
  return (
    segment.rawEdge?.id ||
    segment.sourceRelationshipId ||
    segment.relationshipId ||
    segment.id ||
    null
  );
}

function getEvidenceTypes(segment = {}) {
  const rawEdge = segment.rawEdge || {};
  const out = [];

  if (segment.source === 'explicit_document_sequence') {
    out.push('numbered_step');
  }

  if (rawEdge.source === 'explicit_document_sequence') {
    out.push('numbered_step');
  }

  if (rawEdge.direction === 'arrow_text_order') {
    out.push('arrow_text');
  }

  if (rawEdge.direction === 'verb_text_order') {
    out.push('directional_text');
  }

  if (rawEdge.direction === 'explicit_document_sequence_order') {
    out.push('ordered_sequence');
  }

  if (rawEdge.reason) {
    out.push(rawEdge.reason);
  }

  if (rawEdge.evidenceType) {
    out.push(rawEdge.evidenceType);
  }

  if (!out.length) {
    out.push('architecture_flow_segment');
  }

  return Array.from(new Set(out.filter(Boolean)));
}

function inferLaneType(segment = {}) {
  const rawEdge = segment.rawEdge || {};
  const mode = rawEdge.interactionMode || segment.interactionMode || '';
  const priority = rawEdge.flowPriority || segment.flowPriority || '';

  if (mode === 'auth_validation') return 'auth_validation_flow';
  if (mode === 'configuration_flow') return 'config_control_flow';
  if (mode === 'observability_signal' || mode === 'health_signal') {
    return 'observability_flow';
  }
  if (mode === 'payload_delivery') return 'cache_or_payload_delivery_flow';
  if (mode === 'bidirectional_sync') return 'bidirectional_sync_flow';
  if (mode === 'topology_continuity') return 'topology_continuity_flow';

  if (priority === 'primary') return 'primary_request_flow';
  if (priority === 'supporting') return 'supporting_flow';
  if (priority === 'background') return 'background_flow';

  return 'unknown_supporting_flow';
}

function laneIdForType(laneType) {
  return `lane_${normalizeKey(laneType || 'unknown')}`;
}

function buildHopId({ index, from, to, laneType, relationshipType }) {
  return [
    'hop',
    String(index + 1).padStart(3, '0'),
    normalizeKey(from?.id || from?.name || 'unknown_from'),
    'to',
    normalizeKey(to?.id || to?.name || 'unknown_to'),
    normalizeKey(laneType || relationshipType || 'handoff'),
  ]
    .filter(Boolean)
    .join('_');
}

function buildStepId(segment = {}, index) {
  const evidenceIds = asArray(segment.evidenceIds || segment.rawEdge?.evidenceIds);

  const stepEvidence = evidenceIds.find((id) =>
    /ev_|step|sequence|element|layout/i.test(String(id))
  );

  if (stepEvidence) {
    return `step_${normalizeKey(stepEvidence)}`;
  }

  if (
    segment.source === 'explicit_document_sequence' ||
    segment.rawEdge?.source === 'explicit_document_sequence'
  ) {
    return `step_${String(index + 1).padStart(3, '0')}`;
  }

  return null;
}

function confidenceRank(confidence) {
  const order = {
    deterministic: 4,
    high: 3,
    medium: 2,
    low: 1,
    unknown: 0,
  };

  return order[confidence] ?? 0;
}

function summarizeConfidence(hops = []) {
  if (!hops.length) return 'unknown';

  const min = Math.min(
    ...hops.map((hop) => confidenceRank(hop.confidence))
  );

  if (min >= 4) return 'deterministic';
  if (min >= 3) return 'high';
  if (min >= 2) return 'medium';
  if (min >= 1) return 'low';

  return 'unknown';
}

function extractSelectedSegments(architectureFlow = {}) {
  const selectedGroupId =
    architectureFlow.selectedPrimaryTraversal?.flowGroupId ||
    architectureFlow.traversalWeightDebug?.selectedFlowGroupId ||
    null;

  const groups = asArray(architectureFlow.flowGroups);

  if (selectedGroupId) {
    const selected = groups.find(
      (group) => group.flowGroupId === selectedGroupId
    );

    if (selected && asArray(selected.segments).length) {
      return selected.segments;
    }
  }

  const primary = groups.find((group) => group.isPrimary === true);
  if (primary && asArray(primary.segments).length) {
    return primary.segments;
  }

  return groups.flatMap((group) => asArray(group.segments));
}

function collectAllSegments(architectureFlow = {}) {
  return uniqueBy(
    asArray(architectureFlow.flowGroups).flatMap((group) =>
      asArray(group.segments).map((segment) => ({
        ...segment,
        __flowGroupId: group.flowGroupId,
        __flowType: group.flowType,
        __groupIsPrimary: group.isPrimary === true,
      }))
    ),
    (segment) =>
      `${segment.from?.id}->${segment.to?.id}:${segment.relationshipType}:${segment.id}`
  );
}

function buildHopFromSegment(segment = {}, index, selectedHopKeys = new Set()) {
  const from = segment.from || {};
  const to = segment.to || {};
  const rawEdge = segment.rawEdge || {};

  const laneType = inferLaneType(segment);
  const flowLaneId = laneIdForType(laneType);

  const relationshipType =
    segment.relationshipType ||
    rawEdge.type ||
    rawEdge.relationshipType ||
    'architecture_handoff';

  const hopKey = `${from.id}->${to.id}:${relationshipType}:${segment.id}`;
  const isSelected = selectedHopKeys.has(hopKey);

  const hopId = buildHopId({
    index,
    from,
    to,
    laneType,
    relationshipType,
  });

  return {
    hopId,
    canonicalOrder: index + 1,

    flowLaneId,
    flowLaneType: laneType,
    selectedForPrimaryWalkthrough: isSelected,

    sourceSegmentId: segment.id || null,
    sourceRelationshipId: getRelationshipId(segment),

    from: {
      id: from.id || normalizeKey(from.name),
      name: from.name || from.id || 'Unknown source',
      globalRole: from.role || from.structuralRole || null,
    },

    to: {
      id: to.id || normalizeKey(to.name),
      name: to.name || to.id || 'Unknown target',
      globalRole: to.role || to.structuralRole || null,
    },

    relationshipType,
    interactionMode:
      rawEdge.interactionMode ||
      segment.interactionMode ||
      'unknown',

    flowPriority:
      rawEdge.flowPriority ||
      segment.flowPriority ||
      (isSelected ? 'primary' : 'unknown'),

    directionality:
      rawEdge.directionality ||
      segment.directionality ||
      'directed',

    evidenceTypes: getEvidenceTypes(segment),
    evidenceIds: asArray(segment.evidenceIds || rawEdge.evidenceIds),
    stepId: buildStepId(segment, index),

    confidence:
      segment.confidence ||
      rawEdge.confidence ||
      'unknown',

    scoring: {
      traversalScore:
        segment.traversalScoring?.score ??
        segment.traversalScore ??
        null,
      rawTraversalScoring: segment.traversalScoring || null,
    },

    contextualRoles: {
      fromRoleInHandoff:
        inferContextualRole({
          endpoint: 'from',
          component: from,
          segment,
          laneType,
        }),
      toRoleInHandoff:
        inferContextualRole({
          endpoint: 'to',
          component: to,
          segment,
          laneType,
        }),
    },

    safety: {
      narratableAsFact:
        !segment.rawEdge?.inferred &&
        confidenceRank(segment.confidence || rawEdge.confidence) >= 2,
      topologyOnly: laneType === 'topology_continuity_flow',
      inferred: Boolean(segment.rawEdge?.inferred),
    },
  };
}

function inferContextualRole({ endpoint, component = {}, segment = {}, laneType }) {
  const name = normalizeKey(component.name || component.id);
  const role = normalizeKey(component.role || component.structuralRole);
  const haystack = `${name} ${role} ${laneType}`;

  if (endpoint === 'from') {
    if (/client|user|external|source/.test(haystack)) return 'request_originator';
    if (/config|control/.test(haystack)) return 'control_source';
    if (/metrics|telemetry|monitor/.test(haystack)) return 'signal_emitter';
    return 'upstream_participant';
  }

  if (/auth|validation|policy/.test(haystack)) return 'validation_receiver';
  if (/gateway|edge|ingress|boundary/.test(haystack)) return 'ingress_receiver';
  if (/router|routing|control|orchestrat/.test(haystack)) return 'routing_receiver';
  if (/database|db|storage|state|store/.test(haystack)) return 'state_receiver';
  if (/metrics|telemetry|monitor/.test(haystack)) return 'observability_receiver';

  return 'downstream_participant';
}

function buildFlowLanes(hops = []) {
  const byLane = new Map();

  for (const hop of hops) {
    if (!byLane.has(hop.flowLaneId)) {
      byLane.set(hop.flowLaneId, {
        flowLaneId: hop.flowLaneId,
        flowLaneType: hop.flowLaneType,
        selectedForPrimaryWalkthrough: false,
        hopIds: [],
        confidence: 'unknown',
      });
    }

    const lane = byLane.get(hop.flowLaneId);
    lane.hopIds.push(hop.hopId);

    if (
        hop.selectedForPrimaryWalkthrough &&
        hop.flowLaneType === 'primary_request_flow'
        ) {
        lane.selectedForPrimaryWalkthrough = true;
        }
  }

  return Array.from(byLane.values()).map((lane) => {
    const laneHops = hops.filter((hop) => lane.hopIds.includes(hop.hopId));

    return {
        ...lane,

        selectedForPrimaryWalkthrough:
            lane.flowLaneType === 'primary_request_flow' &&
            lane.selectedForPrimaryWalkthrough === true,

        confidence: summarizeConfidence(laneHops),
        hopCount: lane.hopIds.length,
        };
  });
}

function buildNodeMemberships(hops = []) {
  const byNode = new Map();

  for (const hop of hops) {
    for (const endpoint of ['from', 'to']) {
      const node = hop[endpoint];
      if (!node?.id) continue;

      if (!byNode.has(node.id)) {
        byNode.set(node.id, {
          nodeId: node.id,
          nodeName: node.name,
          globalRole: node.globalRole || null,
          flowLaneMemberships: [],
        });
      }

      byNode.get(node.id).flowLaneMemberships.push({
        hopId: hop.hopId,
        flowLaneId: hop.flowLaneId,
        flowLaneType: hop.flowLaneType,
        endpoint,
        contextualRole:
          endpoint === 'from'
            ? hop.contextualRoles.fromRoleInHandoff
            : hop.contextualRoles.toRoleInHandoff,
      });
    }
  }

  return Array.from(byNode.values()).map((node) => ({
    ...node,
    flowLaneMemberships: uniqueBy(
      node.flowLaneMemberships,
      (item) => `${item.hopId}:${item.endpoint}`
    ),
  }));
}

function buildPathText(hops = []) {
  if (!hops.length) return "";

  return hops
    .map((hop, index) => {
      const from = hop?.from?.name || "Upstream";
      const to = hop?.to?.name || "Downstream";
      return index === 0 ? `${from} → ${to}` : `→ ${to}`;
    })
    .join(" ");
}

function buildSelectedWalkthrough(hops = [], selectedLane = null) {
  const selectedHops = hops
    .filter((hop) => hop.selectedForPrimaryWalkthrough === true)
    .sort((a, b) => Number(a.canonicalOrder || 0) - Number(b.canonicalOrder || 0));

  if (!selectedHops.length) return null;

  const laneTypes = Array.from(
    new Set(selectedHops.map((hop) => hop.flowLaneType).filter(Boolean))
  );

  return {
    version: "selected-walkthrough-v1",
    type:
      laneTypes.length > 1
        ? "cross_lane_primary_walkthrough"
        : "single_lane_primary_walkthrough",
    primaryFlowLaneId:
      selectedLane?.flowLaneId ||
      selectedHops.find((hop) => hop.flowLaneType === "primary_request_flow")?.flowLaneId ||
      selectedHops[0]?.flowLaneId ||
      null,
    includesSupportingLaneHops: selectedHops.some(
      (hop) => hop.flowLaneType !== "primary_request_flow"
    ),
    selectedHopIds: selectedHops.map((hop) => hop.hopId),
    hopCount: selectedHops.length,
    firstHopId: selectedHops[0]?.hopId || null,
    lastHopId: selectedHops[selectedHops.length - 1]?.hopId || null,
    pathText: buildPathText(selectedHops),
    laneTypes,
  };
}


function buildSharedNodeSummary(nodeMemberships = []) {
  return nodeMemberships
    .map((node) => {
      const memberships = asArray(node.flowLaneMemberships);
      const laneTypes = Array.from(
        new Set(memberships.map((item) => item.flowLaneType).filter(Boolean))
      );

      const primaryWalkthroughHopIds = memberships
        .filter((item) => item.flowLaneType === 'primary_request_flow')
        .map((item) => item.hopId);

      const supportingHopIds = memberships
        .filter((item) => item.flowLaneType !== 'primary_request_flow')
        .map((item) => item.hopId);

      return {
        nodeId: node.nodeId,
        nodeName: node.nodeName,
        globalRole: node.globalRole || null,
        sharedAcrossLaneCount: laneTypes.length,
        participatingLaneTypes: laneTypes,
        primaryWalkthroughHopIds,
        supportingHopIds,
        contextualRoles: Array.from(
          new Set(memberships.map((item) => item.contextualRole).filter(Boolean))
        ),
        membershipCount: memberships.length,
      };
    })
    .filter(
      (node) =>
        node.membershipCount > 1 ||
        node.participatingLaneTypes.length > 1
    );
}

function buildCanonicalTraversalRail({
  architectureUnderstanding = {},
  architectureFlow = {},
  architectureEvidence = {},
  architectureTermResolutions = {},
} = {}) {
  const selectedSegments = extractSelectedSegments(architectureFlow);

  const selectedHopKeys = new Set(
    selectedSegments.map(
      (segment) =>
        `${segment.from?.id}->${segment.to?.id}:${segment.relationshipType}:${segment.id}`
    )
  );

  const allSegments = collectAllSegments(architectureFlow);

  const orderedSegments = uniqueBy(
    [
      ...selectedSegments.map((segment) => ({
        ...segment,
        __selectedFirst: true,
      })),
      ...allSegments,
    ],
    (segment) =>
      `${segment.from?.id}->${segment.to?.id}:${segment.relationshipType}:${segment.id}`
  );

  const hops = orderedSegments.map((segment, index) =>
    buildHopFromSegment(segment, index, selectedHopKeys)
  );

  const flowLanes = buildFlowLanes(hops);

  const selectedLane =
    flowLanes.find((lane) => lane.selectedForPrimaryWalkthrough) ||
    flowLanes[0] ||
    null;

    const selectedWalkthrough = buildSelectedWalkthrough(hops, selectedLane);

    const nodeMemberships = buildNodeMemberships(hops);
    const sharedNodeSummary = buildSharedNodeSummary(nodeMemberships);

  const warnings = [];

  if (!hops.length) {
    warnings.push({
      code: 'NO_HOPS',
      severity: 'warning',
      message: 'No canonical traversal hops were created.',
    });
  }

  if (!selectedLane) {
    warnings.push({
      code: 'NO_SELECTED_FLOW_LANE',
      severity: 'warning',
      message: 'No selected flow lane was found.',
    });
  }

  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    source: 'architectureCanonicalTraversalRailBuilder',

    identityType: 'handoff_edge',
    selectedFlowLaneId: selectedLane?.flowLaneId || null,
    selectedWalkthrough,

    strategy: {
      traversalIdentity: 'edge_or_handoff_based_not_node_based',
      flowModel:
        'one_selected_walkthrough_lane_plus_supporting_parallel_lanes',
      evidencePolicy:
        'document_steps_arrows_relationships_and_spatial_candidates_before_llm',
      internalTermPolicy:
        'unknown_internal_components_keep_document_only_meaning',
      downstreamRule:
        'downstream_layers_should_reference_hopId_flowLaneId_and_canonicalOrder',
    },

    hops,
    flowLanes,
    nodeMemberships,
    sharedNodeSummary,

    stats: {
      hopCount: hops.length,
      selectedHopCount: hops.filter((hop) => hop.selectedForPrimaryWalkthrough).length,
      flowLaneCount: flowLanes.length,
      sharedNodeCount: sharedNodeSummary.length,
      evidenceBackedHopCount: hops.filter((hop) => hop.evidenceIds.length > 0).length,
    },

    warnings,
  };
}

module.exports = {
  VERSION,
  buildCanonicalTraversalRail,
};