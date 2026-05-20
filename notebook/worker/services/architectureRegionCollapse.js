/**
 * architectureRegionCollapse.js
 *
 * BUG-22G — Repeated Region Collapse
 *
 * Domain-independent repeated-node grouping for enterprise architecture graphs.
 *
 * Borrowed ideas:
 * - Kubernetes ReplicaSet: many instances represent one logical workload.
 * - Cytoscape compound nodes: grouped nodes can behave as one parent.
 * - C4 model containers: teach group/responsibility, not every replica.
 * - Observability topology maps: same role + same relationship pattern implies same service group.
 * - Generic graph clustering: collapse by structural similarity, not product names.
 *
 * Hard rules:
 * - No vendor/product/company-specific assumptions.
 * - Do not delete graph truth.
 * - Do not rewrite relationships in V1.
 * - Emit grouping metadata only; traversal/render layers can consume later.
 */

function normalizeText(value) {
  return String(value || "").trim();
}

function lower(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeKey(value) {
  return lower(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];

  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function stripOrdinalNoise(name) {
  return normalizeText(name)
    .replace(/\b(instance|node|replica|pod|server|host|worker)\s*[-_#:]?\s*\d+\b/gi, "$1")
    .replace(/\b(az|zone|region|rack|shard|partition)\s*[-_#:]?\s*[a-z0-9]+\b/gi, "$1")
    .replace(/\b\d+\b/g, "")
    .replace(/[-_#:.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getBoundarySignature(component = {}) {
  const boundaries = asArray(component.boundaries);

  if (!boundaries.length) return "no_boundary";

  return boundaries
    .map((boundary) =>
      normalizeKey(
        [
          boundary.boundaryType,
          boundary.rawText || boundary.label || boundary.text,
        ]
          .filter(Boolean)
          .join(":")
      )
    )
    .sort()
    .join("|");
}

function buildRelationshipPatterns(relationships = []) {
  const incoming = new Map();
  const outgoing = new Map();

  for (const rel of relationships || []) {
    if (!incoming.has(rel.targetId)) incoming.set(rel.targetId, []);
    if (!outgoing.has(rel.sourceId)) outgoing.set(rel.sourceId, []);

    incoming.get(rel.targetId).push(rel);
    outgoing.get(rel.sourceId).push(rel);
  }

  return { incoming, outgoing };
}

function relationshipMode(rel = {}) {
  return normalizeKey(
    rel.interactionMode ||
      rel.flowPriority ||
      rel.type ||
      rel.reason ||
      "unknown"
  );
}

function getRelationshipSignature(component = {}, relationshipPatterns = {}) {
  const incoming = asArray(relationshipPatterns.incoming?.get(component.id));
  const outgoing = asArray(relationshipPatterns.outgoing?.get(component.id));

  const incomingModes = incoming.map(relationshipMode).sort().join(",");
  const outgoingModes = outgoing.map(relationshipMode).sort().join(",");

  return `in:${incomingModes || "none"}|out:${outgoingModes || "none"}`;
}

function getComponentCollapseBaseName(component = {}) {
  const name = normalizeText(component.name);
  const stripped = stripOrdinalNoise(name);
  return normalizeKey(stripped || name);
}

function getCollapseKey(component = {}, relationshipPatterns = {}) {
  const baseName = getComponentCollapseBaseName(component);
  const role = normalizeKey(component.role || component.type || "unknown");
  const boundary = getBoundarySignature(component);
  const relPattern = getRelationshipSignature(component, relationshipPatterns);

  return [baseName, role, boundary, relPattern].join("::");
}

function confidenceRank(confidence) {
  switch (confidence) {
    case "deterministic":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function chooseRepresentativeComponent(group = []) {
  if (!group.length) return null;

  return group
    .slice()
    .sort((a, b) => {
      const confidenceDelta =
        confidenceRank(b.confidence) - confidenceRank(a.confidence);
      if (confidenceDelta !== 0) return confidenceDelta;

      const evidenceDelta =
        asArray(b.evidenceIds).length - asArray(a.evidenceIds).length;
      if (evidenceDelta !== 0) return evidenceDelta;

      return normalizeText(a.name).localeCompare(normalizeText(b.name));
    })[0];
}

function shouldCollapseGroup(group = []) {
  if (group.length < 2) return false;

  const baseNames = new Set(group.map(getComponentCollapseBaseName));
  const roles = new Set(group.map((item) => normalizeKey(item.role || item.type)));

  return baseNames.size === 1 && roles.size === 1;
}

function summarizeGroupConfidence(components = []) {
  const ranks = components.map((component) => confidenceRank(component.confidence));
  const minRank = ranks.length ? Math.min(...ranks) : 0;

  if (minRank >= 3) return "high";
  if (minRank >= 2) return "medium";
  if (minRank >= 1) return "low";
  return "unknown";
}

function buildCollapsedGroup(groupId, components = []) {
  const representative = chooseRepresentativeComponent(components);

  return {
    groupId,
    groupType: "repeated_architecture_region",
    collapseReason:
      "same_base_name_role_boundary_and_relationship_pattern",
    representativeComponentId: representative?.id || null,
    representativeName: representative?.name || null,
    componentIds: components.map((component) => component.id),
    componentNames: components.map((component) => component.name),
    role: representative?.role || null,
    boundarySignature: getBoundarySignature(representative || {}),
    evidenceIds: uniqueBy(
      components.flatMap((component) => asArray(component.evidenceIds)),
      (id) => id
    ),
    confidence: summarizeGroupConfidence(components),
  };
}

function buildArchitectureRegionCollapse({
  components = [],
  relationships = [],
} = {}) {
  const relationshipPatterns = buildRelationshipPatterns(relationships);
  const buckets = new Map();

  for (const component of components || []) {
    const key = getCollapseKey(component, relationshipPatterns);

    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(component);
  }

  const collapsedGroups = [];
  const componentToGroup = {};

  for (const [key, group] of buckets.entries()) {
    if (!shouldCollapseGroup(group)) continue;

    const groupId = `collapsed_region_${normalizeKey(key).slice(0, 80)}`;
    const collapsedGroup = buildCollapsedGroup(groupId, group);

    collapsedGroups.push(collapsedGroup);

    for (const componentId of collapsedGroup.componentIds) {
      componentToGroup[componentId] = groupId;
    }
  }

  const representativeComponents = collapsedGroups
    .map((group) =>
      components.find((component) => component.id === group.representativeComponentId)
    )
    .filter(Boolean);

  return {
    version: "architecture-region-collapse-v1",
    strategy:
      "domain_independent_same_base_role_boundary_relationship_pattern",
    collapsedGroups,
    representativeComponents,
    componentToGroup,
    stats: {
      componentCount: components.length,
      relationshipCount: relationships.length,
      collapsedGroupCount: collapsedGroups.length,
      collapsedComponentCount: Object.keys(componentToGroup).length,
      representativeComponentCount: representativeComponents.length,
    },
  };
}

module.exports = {
  buildArchitectureRegionCollapse,
  getComponentCollapseBaseName,
  getRelationshipSignature,
};