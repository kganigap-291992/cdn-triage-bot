const {
  typeArchitectureRelationships,
} = require("./architectureEdgeTyping");

const {
  typeBoundaryEvidenceList,
} = require("./architectureBoundaryTyping");

const {
  classifyArchitectureRelationshipFlows,
} = require("./architectureFlowClassification");

const {
  mapArchitectureRelationshipsEvidence,
} = require("./architectureEvidenceInteractionMapper");

const {
  buildArchitectureGraphPartitions,
} = require("./architectureGraphPartitioner");

const {
  buildArchitectureRegionCollapse,
} = require("./architectureRegionCollapse");

const {
  attachContextualRolesToRelationships,
} = require("./architectureContextualRoleBuilder");

const {
  fuseStepArrowEvidence,
} = require("./architectureStepArrowFusion");

const {
  inferUnknownEnterpriseComponents,
} = require("./architectureUnknownComponentInference");


const RELATIONSHIP_CONFIDENCE = {
  explicit_definition: "high",
  explicit_flow: "high",
  directional_flow_text: "high",
  ordered_sequence: "medium",
  same_sentence_flow_context: "medium",
  same_section_flow_context: "medium",
  same_section_co_mention: "medium",
  continuity_repair: "medium",
  repeated_cross_page_co_mention: "medium",
  diagram_adjacency_only: "low",
};

const GRAPH_ELIGIBLE_ROLES = new Set([
  "system_component",
  "external_actor",
  "interface",
  "data_store",
  "process_step",
]);

const FLOW_VERBS = [
  "sends",
  "send",
  "passes",
  "pass",
  "routes",
  "route",
  "connects",
  "connect",
  "publishes",
  "publish",
  "delivers",
  "deliver",
  "forwards",
  "forward",
  "pushes",
  "push",
  "calls",
  "call",
  "writes",
  "write",
  "reads",
  "read",
  "ingests",
  "ingest",
  "feeds",
  "feed",
  "uses",
  "use",
  "returns",
  "return",
  "receives",
  "receive",
  "validates",
  "validate",
  "authenticates",
  "authenticate",
  "stores",
  "store",
  "persists",
  "persist",
  "hands off",
  "handoff",
  "flows",
  "flow",
];

function normalizeText(value) {
  return String(value || "").trim();
}

function lower(value) {
  return normalizeText(value).toLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeComponentIdentity(value) {
  return lower(
    normalizeText(value)
      .replace(/^[•◦▪‣*-]\s+/, "")
      .trim()
  );
}

function normalizeKey(value) {
  return lower(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const ARTIFACT_NODE_BLOCKLIST = new Set([
  "mp2",
  "mpd",
  "dash",
  "https",
  "http",
  "hls",
  "m3u8",
  "h264",
  "h.264",
  "mp4",
  "cmaf",
  "tcp",
  "udp",
  "nfs",
  "s3",
  "json",
  "xml",
  "yaml",
  "jwt",
]);


function isArtifactOnlyLabel(value) {
  const compact = lower(value).replace(/[^a-z0-9.]/g, "");
  return ARTIFACT_NODE_BLOCKLIST.has(compact);
}

function isVariantFamilySummaryLabel(value) {
  const text = normalizeText(value)
    .replace(/^[•◦▪‣*-]\s+/, "")
    .trim();

  if (!text) {
    return false;
  }

  const slashSeparatedVariants =
    /\b(?:[A-Z0-9-]+)(?:\s*\/\s*[A-Z0-9-]+){1,}\b/i.test(text);

  const commaSeparatedVariants =
    /\b(?:[A-Z0-9-]+)(?:\s*,\s*[A-Z0-9-]+){2,}\b/i.test(text);

  const explicitRangeLanguage =
    /\b(all|each|across|instances?|variants?|replicas?|zones?|regions?)\b/i.test(
      text
    );

  const architectureFamilyTerm =
    /\b(service|controller|gateway|pod|worker|processor|cache|database|replica|origin|cluster|node|client|application|workload|instance)\b/i.test(
      text
    );

  return (
    architectureFamilyTerm &&
    (
      slashSeparatedVariants ||
      commaSeparatedVariants ||
      explicitRangeLanguage
    )
  );
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

function uniqueValues(values = []) {
  return Array.from(
    new Set(
      asArray(values).filter(
        (value) =>
          value !== null &&
          value !== undefined &&
          value !== ""
      )
    )
  );
}


function isLikelyConcatenatedSiblingLabel(value) {
  const name = normalizeText(value);

  if (!name) {
    return false;
  }

  /*
   * Known-valid compound architecture patterns.
   * These represent one component, not adjacent sibling labels.
   */
  const validCompoundPattern =
    /\b(api gateway(?: pod)?|ingress controller|query service|metadata service|origin service|kafka cluster|schema registry|object storage|feature store|identity(?:\s*\/\s*oidc)?|config(?:\s*\/\s*gitops)?|telemetry stack|data catalog|secrets manager|backup vault|batch orchestrator|ml training jobs?)\b/i;

  if (validCompoundPattern.test(name)) {
    /*
     * A valid phrase embedded inside a substantially longer label may
     * still be a concatenation, so only accept close matches.
     */
    const normalizedValidMatch =
      name.match(validCompoundPattern)?.[0] || "";

    const extraWordCount =
      name
        .replace(normalizedValidMatch, "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .length;

    if (extraWordCount <= 1) {
      return false;
    }
  }

  const componentHeadMatches =
    name.match(
      /\b(service|controller|gateway|pod|worker|processor|cache|database|replica|origin|cluster|registry|storage|store|identity|telemetry|stack|catalog|manager|vault|orchestrator|batch|jobs?|gitops)\b/gi
    ) || [];

  if (componentHeadMatches.length < 2) {
    return false;
  }

  const hasRelationshipLanguage =
    /\b(and|to|via|through|uses?|calls?|routes?|sends?|writes?|reads?|feeds?|with|for)\b/i.test(
      name
    );

  const hasStructuralSeparator =
    /[→>;|,]/.test(name);

  return (
    !hasRelationshipLanguage &&
    !hasStructuralSeparator
  );
}

function suppressContainedComponentFragments(components = []) {
  const genericFragmentTerms = new Set([
    "api",
    "app",
    "application",
    "auth",
    "authorization",
    "cache",
    "client",
    "cluster",
    "controller",
    "database",
    "door",
    "gateway",
    "identity",
    "ingress",
    "node",
    "object",
    "oidc",
    "origin",
    "pod",
    "processor",
    "query",
    "registry",
    "service",
    "storage",
    "telemetry",
    "worker",
  ]);

  return asArray(components).filter((candidate) => {
    const candidateName = normalizeText(candidate.name);
    const candidateLower = lower(candidateName);

    if (!candidateLower) {
      return false;
    }

    const candidateEvidenceIds = new Set(
      asArray(candidate.evidenceIds)
    );

    return !asArray(components).some((other) => {
      if (!other || other === candidate) {
        return false;
      }

      const otherName = normalizeText(other.name);
      const otherLower = lower(otherName);

      if (
        !otherLower ||
        otherLower === candidateLower ||
        otherName.length <= candidateName.length
      ) {
        return false;
      }

      if (isLikelyConcatenatedSiblingLabel(otherName)) {
        return false;
      }

      if (isLikelyJunkArchitectureCandidate(other)) {
        return false;
      }

      const escapedCandidate =
        candidateLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      const containedAsWholeSpan =
        new RegExp(
          `(^|[^a-z0-9])${escapedCandidate}([^a-z0-9]|$)`,
          "i"
        ).test(otherLower);

      if (!containedAsWholeSpan) {
        return false;
      }

      const sharedEvidenceCount =
        asArray(other.evidenceIds).filter((evidenceId) =>
          candidateEvidenceIds.has(evidenceId)
        ).length;

      if (sharedEvidenceCount === 0) {
        return false;
      }

      const candidateWordCount =
        candidateName.split(/\s+/).filter(Boolean).length;

      const genericOrShort =
        candidateWordCount === 1 ||
        genericFragmentTerms.has(candidateLower);

      return genericOrShort;
    });
  });
}


function getEvidenceText(evidence) {
  return normalizeText(
    evidence?.text ||
    evidence?.content ||
    evidence?.label ||
    ""
  );
}

function collectEvidenceContext({
  evidenceIds = [],
  evidence = [],
} = {}) {
  const evidenceIdSet =
    new Set(
      asArray(evidenceIds)
    );

  const matchedEvidence =
    asArray(evidence).filter(
      (item) =>
        item?.id &&
        evidenceIdSet.has(item.id)
    );

  return {
    pages:
      uniqueValues(
        matchedEvidence.map(
          (item) => item.page
        )
      ),

    sectionIds:
      uniqueValues(
        matchedEvidence.map(
          (item) => item.sectionId
        )
      ),

    parentSectionIds:
      uniqueValues(
        matchedEvidence.map(
          (item) =>
            item.parentSectionId
        )
      ),

    sectionOrders:
      uniqueValues(
        matchedEvidence.map(
          (item) =>
            item.sectionOrder
        )
      ),

    sectionDepths:
      uniqueValues(
        matchedEvidence.map(
          (item) =>
            item.sectionDepth
        )
      ),

    headingKinds:
      uniqueValues(
        matchedEvidence.map(
          (item) =>
            item.headingKind
        )
      ),

    structureBackedEvidenceIds:
      uniqueValues(
        matchedEvidence
          .filter(
            (item) =>
              Boolean(item.sectionId)
          )
          .map(
            (item) => item.id
          )
      ),
  };
}

function attachDocumentContextToComponents(
  components = [],
  evidence = []
) {
  return asArray(components).map(
    (component) => {
      const evidenceContext =
        collectEvidenceContext({
          evidenceIds:
            component.evidenceIds,
          evidence,
        });

      return {
        ...component,

        pages:
          uniqueValues([
            ...asArray(component.pages),
            ...evidenceContext.pages,
          ]),

        sectionIds:
          uniqueValues([
            ...asArray(component.sectionIds),
            ...evidenceContext.sectionIds,
          ]),

        parentSectionIds:
          uniqueValues([
            ...asArray(component.parentSectionIds),
            ...evidenceContext.parentSectionIds,
          ]),

        sectionOrders:
          uniqueValues([
            ...asArray(component.sectionOrders),
            ...evidenceContext.sectionOrders,
          ]),

        sectionDepths:
          uniqueValues([
            ...asArray(component.sectionDepths),
            ...evidenceContext.sectionDepths,
          ]),

        headingKinds:
          uniqueValues([
            ...asArray(component.headingKinds),
            ...evidenceContext.headingKinds,
          ]),

        structureBackedEvidenceIds:
          uniqueValues([
            ...asArray(
              component.structureBackedEvidenceIds
            ),
            ...evidenceContext.structureBackedEvidenceIds,
          ]),
      };
    }
  );
}


function getEvidenceForComponent(
  component,
  evidence = []
) {
  const ids = new Set(component.evidenceIds || []);
  const name = lower(component.name);

  return evidence.filter((item) => {
    if (ids.has(item.id)) return true;
    return lower(getEvidenceText(item)).includes(name);
  });
}

function getEvidenceStructuralWeight(item = {}) {
  const type = lower(item.type);
  const source = lower(item.source);
  const text = lower(getEvidenceText(item));

  if (source.includes("diagram") || type.includes("diagram")) return 1.0;
  if (type.includes("figure") || text.includes("diagram")) return 0.9;
  if (type.includes("caption")) return 0.8;
  if (type.includes("heading") || type.includes("section")) return 0.35;
  if (
    type.includes("table_header") ||
    text === "type" ||
    text === "value" ||
    text === "format"
  ) {
    return 0.15;
  }
  if (type.includes("metadata")) return 0.1;

  return 0.5;
}

function computeComponentStructuralScore(component, evidenceItems = []) {
  const weights = evidenceItems.map(getEvidenceStructuralWeight);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);

  const labelPenalty =
    /^(type|value|format|architecture|overview|production|notes|source|content)$/i.test(
      component.name
    )
      ? 0.75
      : 0;

  const longValuePenalty =
    component.name.length > 48 || /[0-9]{8,}/.test(component.name) ? 0.5 : 0;

  return Math.max(0, Number((totalWeight - labelPenalty - longValuePenalty).toFixed(2)));
}

const DOCUMENT_ONLY_COMPONENT_LABELS = new Set([
  "all",
  "architecture",
  "brown",
  "component",
  "content delivery",
  "control",
  "cross-region",
  "dashed",
  "deployment",
  "designed",
  "explicit",
  "expected",
  "fan-in",
  "fan-out",
  "instance",
  "journey",
  "learning",
  "membership",
  "mirrored",
  "observability",
  "pattern",
  "primary",
  "recommendation",
  "region",
  "regional",
  "rendering",
  "replica detection",
  "shared",
  "solid",
  "state",
  "synchronization",
  "validation",
]);


function evaluateComponentCandidate({
  component = {},
  evidenceItems = [],
} = {}) {
  const name = normalizeText(component.name);
  const wordCount = name.split(/\s+/).filter(Boolean).length;
  const sourceType = lower(component.type);
  const source = lower(component.source);

  let score = 0;
  const signals = [];

  if (!name) {
    return {
      eligible: false,
      score: 0,
      signals: ["missing_name"],
    };
  }

  /*
   * Strong structural signals.
   */
  if (
    source.includes("diagram") ||
    sourceType.includes("diagram") ||
    sourceType.includes("figure") ||
    sourceType.includes("node")
  ) {
    score += 3;
    signals.push("diagram_or_visual_structure");
  }

  if (
    sourceType.includes("component") ||
    sourceType.includes("service") ||
    sourceType.includes("system")
  ) {
    score += 2;
    signals.push("component_source_type");
  }

  /*
   * Enterprise/cloud/video architecture vocabulary.
   * This is a positive signal, not an allowlist.
   */
  if (
    /\b(service|gateway|api|load balancer|waf|firewall|cdn|edge|origin|cache|redis|database|db|storage|bucket|queue|broker|kafka|event bus|stream|worker|processor|controller|cluster|node|pod|container|function|lambda|router|mesh|proxy|identity|auth|policy|metrics|logging|telemetry|alerting|packager|transcoder|manifest|playback|session|client|player)\b/i.test(
      name
    )
  ) {
    score += 2;
    signals.push("enterprise_architecture_term");
  }

  /*
   * Explicit deployment identity.
   */
  if (
    /\b(region|zone|availability zone|az|site|cell|data center|datacenter)\s+[a-z0-9-]+\b/i.test(
      name
    )
  ) {
    score += 2;
    signals.push("explicit_deployment_identity");
  }

  /*
   * Relationship/flow evidence.
   */
  if (
    evidenceItems.some((item) =>
      /→|->|=>|⇒|⟶/.test(getEvidenceText(item))
    )
  ) {
    score += 2;
    signals.push("directional_flow_evidence");
  }

  if (
    evidenceItems.some((item) =>
      /\b(sends?|routes?|calls?|writes?|reads?|publishes?|connects?|forwards?|delivers?|receives?)\b/i.test(
        getEvidenceText(item)
      )
    )
  ) {
    score += 1;
    signals.push("flow_language_evidence");
  }

  if (evidenceItems.length >= 2) {
    score += 1;
    signals.push("repeated_evidence");
  }

  if (wordCount <= 6 && !/[.!?]$/.test(name)) {
    score += 1;
    signals.push("compact_label");
  }

  /*
   * Negative document signals.
   */
  if (
    sourceType === "section" ||
    sourceType === "heading" ||
    sourceType === "line" ||
    sourceType === "fallback_text"
  ) {
    score -= 1;
    signals.push("document_text_penalty");
  }

  if (/[.!?]$/.test(name) && wordCount >= 3) {
    score -= 3;
    signals.push("sentence_penalty");
  }

  if (
    /^(solid|dashed|dotted|colored|brown|blue|red|green)\s+(arrows?|lines?|connectors?)\b/i.test(
      name
    )
  ) {
    score -= 4;
    signals.push("diagram_legend_penalty");
  }

  if (
    sourceType === "line" &&
    /^[a-z][a-z _-]*\s*\/\s*[a-z][a-z _-]*$/.test(name)
  ) {
    score -= 4;
    signals.push("lowercase_role_label_penalty");
  }

  if (
    /^(why|expected|purpose|overview|notes?|legend|rules?|goals?|example|examples|component pattern|design goals?)\b/i.test(
      name
    )
  ) {
    score -= 2;
    signals.push("document_heading_penalty");
  }

  if (
    /\b(conformance|regression|candidate-only|health\.valid|traversal|rendering|narration|learning engine|synthetic and generic)\b/i.test(
      name
    )
  ) {
    score -= 2;
    signals.push("test_or_documentation_penalty");
  }

  if (
    /^(fan[_ -]?in|fan[_ -]?out|mirrored_topology|shared_infrastructure_topology|cross_unit_connected_topology|external_interface)$/i.test(
      name
    )
  ) {
    score -= 3;
    signals.push("topology_classification_not_component");
  }

  
  if (
    /^(pdf|document|page|slide|figure|diagram|chapter|section)$/i.test(
      name
    )
  ) {
    score -= 6;
    signals.push("document_artifact_identifier_penalty");
  }

  
  if (
    /^bug[-_ ]?\d+(?:[a-z0-9._-]*)?$/i.test(
      name
    )
  ) {
    score -= 6;
    signals.push("roadmap_bug_identifier_penalty");
  }

  return {
    eligible: score >= 2,
    score,
    signals,
  };
}

function isLikelyJunkArchitectureCandidate(component) {
  const name = normalizeText(component.name);
  const normalizedName = lower(name);
  const wordCount = name.split(/\s+/).filter(Boolean).length;

  if (!name) return true;

  if (isVariantFamilySummaryLabel(name)) {
    return true;
  }

  if (isLikelyConcatenatedSiblingLabel(name)) {
    return true;
  }

  if (DOCUMENT_ONLY_COMPONENT_LABELS.has(normalizedName)) {
    return true;
  }

  if (
    /^(item|type|value|values|format|source|content|application|only|team|production|qa|fqdn|id)$/i.test(
      name
    )
  ) {
    return true;
  }

  if (
    /^(applies|builds|chooses|controls|creates|distributes|indexes|performs|produces|receives|runs|selects|stores|aggregates)$/i.test(
      name
    )
  ) {
    return true;
  }

  if (
    /\b(expected|regression targets?|safety expectations?|design goals?|demo safety rules?|instance rule)\b/i.test(
      name
    )
  ) {
    return true;
  }

  if (
    /\b(candidate-only|high-severity|health\.valid|traversal unchanged|do not claim)\b/i.test(
      name
    )
  ) {
    return true;
  }

  if (
    /[.!?]$/.test(name) &&
    wordCount > 3
  ) {
    return true;
  }

  if (
    wordCount > 7 &&
    !/\b(service|gateway|cluster|database|cache|store|storage|queue|broker|worker|processor|controller|engine|client|server)\b/i.test(
      name
    )
  ) {
    return true;
  }

  if (/\/issues\/\d+/i.test(name)) return true;
  if (/https?:\/\//i.test(name)) return true;

  if (
    /^(new|old)\s+/i.test(name) &&
    wordCount <= 5
  ) {
    return true;
  }

  if (
    name.length > 42 &&
    /[0-9_-]{6,}/.test(name)
  ) {
    return true;
  }

  return false;
}

function looksLikeArchitectureCandidate(value) {
  const text = normalizeText(value);
  if (!text || text.length < 2 || text.length > 160) return false;
  if (/^\d+$/.test(text)) return false;
  if (/^(page|section|figure|table)\s+\d+$/i.test(text)) return false;
  if (!/[a-zA-Z]/.test(text)) return false;

  const namedLabel =
    /^[A-Z][A-Za-z0-9_ ()/#.-]{2,}$/.test(text) ||
    /^[A-Z0-9]{2,16}$/.test(text) ||
    /^[a-zA-Z0-9]+[-_/#][a-zA-Z0-9_/#.-]+$/.test(text);

  const genericDocumentWords =
    /\b(system|service|client|server|gateway|proxy|api|database|store|queue|worker|processor|controller|engine|platform|module|component|cluster|node|layer|pipeline|router|broker|adapter|connector|provider|consumer|source|sink|endpoint|application|app|interface|workflow|process|job|task|step|stage|phase|procedure|protocol|policy|control|check|validation|review|approval|diagnosis|treatment|medication|symptom|condition|risk|mitigation|impact|cause|incident|timeline|handoff|owner|team|role|record|document|case|event|action|operation)\b/i;

  return namedLabel || genericDocumentWords.test(text);
}

function classifyArchitectureRole(component, evidenceItems = []) {
  const name = normalizeText(component.name);
  const text = lower(name);
  const sourceType = lower(component.type);
  const evidenceText = lower(
    evidenceItems.map(getEvidenceText).join(" ")
  );

  const architectureComponentName =
    /\b(service|server|gateway|proxy|controller|worker|processor|engine|component|module|platform|application|app|cluster|node|pod|layer|system|storage|store|database|cache|registry|telemetry|origin|ingress|queue|broker|catalog|manager|vault|orchestrator)\b/i.test(
      name
    );

  const explicitPersonOrTeamSource =
    /\b(person|people|team|owner|organization|group|role)\b/i.test(
      sourceType
    );

  const explicitPersonOrTeamEvidence =
    /\b(owned by|maintained by|operated by|team responsible|engineering team|platform team|support team|owner)\b/i.test(
      evidenceText
    );

  if (
    !architectureComponentName &&
    (
      explicitPersonOrTeamSource ||
      explicitPersonOrTeamEvidence
    )
  ) {
    return "person_or_team";
  }

  const documentSectionSignals =
    /\b(overview|notes|possible|future|resource|wiki|ownership|configuration|details|expectations|table of contents|agenda|introduction|summary|examples|appendix|version|history)\b/i;

  if (sourceType === "section" && documentSectionSignals.test(name)) {
    return "document_section";
  }

  if (
    name.length > 48 ||
    /[0-9]{8,}/.test(name) ||
    /https?:\/\//i.test(name) ||
    /[?&=]/.test(name)
  ) {
    return "configuration_or_value";
  }

  if (/\b(api|endpoint|request|response|interface|contract|url|uri|path)\b/i.test(`${name} ${evidenceText}`)) {
    return "interface";
  }

  if (/\b(store|stored|persist|database|table|bucket|blob|volume|repository)\b/i.test(evidenceText)) {
    return "data_store";
  }

  if (/\b(input|output|payload|message|event|file|manifest|object|record|sample|asset|token|id)\b/i.test(`${name} ${evidenceText}`)) {
    return "data_object";
  }

  if (/\b(protocol|standard|format|codec|transport|over|via)\b/i.test(evidenceText)) {
    return "protocol_or_standard";
  }

  if (/\b(step|stage|workflow|process|job|task|operation|action|generate|create|ingest|publish|deploy|validate)\b/i.test(`${name} ${evidenceText}`)) {
    return "process_step";
  }

  if (/\b(client|consumer|user|provider|external|source|sink|upstream|downstream)\b/i.test(`${name} ${evidenceText}`)) {
    return "external_actor";
  }

  if (/\b(service|server|gateway|proxy|controller|worker|processor|engine|component|module|platform|application|app|cluster|node|layer|system)\b/i.test(`${name} ${evidenceText}`)) {
    return "system_component";
  }

  if (/^[A-Z0-9]{2,12}$/.test(name)) return "system_component";
  if (/^[A-Za-z0-9]+[-_/#][A-Za-z0-9_/#.-]+$/.test(name)) return "system_component";

  return "unknown";
}

function isGraphEligibleRole(role) {
  return GRAPH_ELIGIBLE_ROLES.has(role);
}


function extractCanonicalRegistryComponents(
  documentUnderstanding = {}
) {
  return asArray(
    documentUnderstanding.canonicalComponents
  ).map((component) => ({
    id: component.id,
    name: component.title,
    type: component.kind,
    role: classifyArchitectureRole(
      {
        name: component.title,
        type: component.kind,
      },
      []
    ),
    graphEligible: true,
    structuralScore: 1,
    componentAdmission: {
      score: 4,
      signals: [
        "canonical_component_registry",
      ],
    },
    source:
      "canonical_component_registry",

    sourceEntityId:
      component.entityId,

    evidenceIds:
      component.evidenceIds || [],

    pages:
      component.pages || [],

    sectionIds:
      component.sectionIds || [],

    parentSectionIds:
      component.parentSectionIds || [],

    headingKinds:
      component.headingKinds || [],

    confidence:
      component.confidence,
  }));
}

function extractComponents(documentUnderstanding = {}) {
  const entities = documentUnderstanding.entities || [];
  const evidence = documentUnderstanding.evidence || [];

  const fromEntities = entities
    .map((entity) => ({
      id:
        entity.id,

      name:
        normalizeText(
          entity.name ||
          entity.label ||
          entity.text
        ),

      source:
        "entity",

      type:
        entity.type ||
        "component",

      evidenceIds:
        entity.evidenceIds ||
        [entity.evidenceId].filter(Boolean),

      pages:
        asArray(entity.pages),

      sectionIds:
        asArray(entity.sectionIds),

      parentSectionIds:
        asArray(
          entity.parentSectionIds
        ),

      headingKinds:
        asArray(entity.headingKinds),

      confidence:
        entity.confidence ||
        "medium",
    }))
  .filter(
    (component) =>
      looksLikeArchitectureCandidate(component.name) &&
      !isArtifactOnlyLabel(component.name)
  );

const fromEvidence = evidence
  .flatMap((item) => {
    const text = getEvidenceText(item);

    const qualified =
      extractDeploymentQualifiedPhrases(text);

    if (qualified.length > 0) {
      return qualified.map((name) => ({
        id:
          null,

        name,

        source:
          "deployment_qualified_evidence",

        type:
          item.type ||
          "component",

        evidenceIds:
          [item.id].filter(Boolean),

        pages:
          uniqueValues([
            item.page,
          ]),

        sectionIds:
          uniqueValues([
            item.sectionId,
          ]),

        parentSectionIds:
          uniqueValues([
            item.parentSectionId,
          ]),

        headingKinds:
          uniqueValues([
            item.headingKind,
          ]),

        confidence:
          item.confidence ||
          "medium",
      }));
    }

    return [
      {
        id:
          null,

        name:
          text,

        source:
          "evidence",

        type:
          item.type ||
          "component",

        evidenceIds:
          [item.id].filter(Boolean),

        pages:
          uniqueValues([
            item.page,
          ]),

        sectionIds:
          uniqueValues([
            item.sectionId,
          ]),

        parentSectionIds:
          uniqueValues([
            item.parentSectionId,
          ]),

        headingKinds:
          uniqueValues([
            item.headingKind,
          ]),

        confidence:
          item.confidence ||
          "medium",
      },
    ];
  })
  .filter(
    (component) =>
      looksLikeArchitectureCandidate(component.name) &&
      !isArtifactOnlyLabel(component.name)
  );

  const uniqueCandidates = uniqueBy(
    [...fromEntities, ...fromEvidence],
    (component) =>
      normalizeComponentIdentity(
        component.name
      )
  );

  /*
  * Remove documentation summaries and malformed candidates before
  * longest-span resolution. Junk candidates must never suppress
  * valid canonical entities.
  */
  const eligibleCandidates =
    uniqueCandidates.filter(
      (component) =>
        !isLikelyJunkArchitectureCandidate(component)
    );

  const resolvedCandidates =
    suppressContainedComponentFragments(
      eligibleCandidates
    );

  return resolvedCandidates
    .map((component, index) => {
      const componentEvidence =
        getEvidenceForComponent(
          component,
          evidence
        );

      const evidenceContext =
        collectEvidenceContext({
          evidenceIds:
            component.evidenceIds,

          evidence,
        });

      const role =
        classifyArchitectureRole(
          component,
          componentEvidence
        );

      const structuralScore =
        computeComponentStructuralScore(
          component,
          componentEvidence
        );

      const componentAdmission =
        evaluateComponentCandidate({
          component,
          evidenceItems: componentEvidence,
        });

      return {
        id: component.id || `arch_component_${index + 1}`,
        name: component.name,
        type: component.type || "component",
        role,
        graphEligible:
          isGraphEligibleRole(role) &&
          structuralScore >= 0.5 &&
          componentAdmission.eligible &&
          !isLikelyJunkArchitectureCandidate(component),
        structuralScore,
        componentAdmission: {
          score: componentAdmission.score,
          signals: componentAdmission.signals,
        },
        source:
          component.source,

        evidenceIds:
          uniqueValues(
            component.evidenceIds
          ),

        pages:
          uniqueValues([
            ...asArray(component.pages),
            ...evidenceContext.pages,
          ]),

        sectionIds:
          uniqueValues([
            ...asArray(
              component.sectionIds
            ),
            ...evidenceContext.sectionIds,
          ]),

        parentSectionIds:
          uniqueValues([
            ...asArray(
              component.parentSectionIds
            ),
            ...evidenceContext.parentSectionIds,
          ]),

        sectionOrders:
          evidenceContext.sectionOrders,

        sectionDepths:
          evidenceContext.sectionDepths,

        headingKinds:
          uniqueValues([
            ...asArray(
              component.headingKinds
            ),
            ...evidenceContext.headingKinds,
          ]),

        structureBackedEvidenceIds:
          evidenceContext
            .structureBackedEvidenceIds,

        confidence:
          component.confidence ||
          "medium",
      };
    })
    .filter((component) => component.graphEligible);
}

function evidenceMentionsComponent(evidence, component) {
  return lower(getEvidenceText(evidence)).includes(lower(component.name));
}

function findMentionedComponents(text, components = []) {
  const textLower = lower(text);

  return components
    .map((component) => ({
      component,
      index: textLower.indexOf(lower(component.name)),
      length: lower(component.name).length,
    }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => {
      if (a.index !== b.index) return a.index - b.index;
      return b.length - a.length;
    })
    .filter((entry, index, entries) => {
      return !entries.some((other, otherIndex) => {
        if (otherIndex === index) return false;

        const entryStart = entry.index;
        const entryEnd = entry.index + entry.length;
        const otherStart = other.index;
        const otherEnd = other.index + other.length;

        const isInsideOther =
          entryStart >= otherStart &&
          entryEnd <= otherEnd &&
          other.length > entry.length;

        return isInsideOther;
      });
    });
}

function hasFlowLanguage(text) {
  const textLower = lower(text);
  return FLOW_VERBS.some((verb) => textLower.includes(verb));
}

function hasArrowSyntax(text) {
  return /→|->|=>|⇒|⟶/.test(text);
}

function hasSequenceMarker(text) {
  return /^\s*(step\s*)?\d+[\).:-]/i.test(text) || /^\s*[-*]\s+/i.test(text);
}

function splitIntoClauses(text) {
  return normalizeText(text)
    .split(/(?<=[.!?])\s+|;|\n+/)
    .map(normalizeText)
    .filter(Boolean);
}

function inferSequenceSource(text) {
  if (/^\s*(step\s*)?\d+[\).:-]/i.test(text)) return "numbered_list";
  if (/^\s*[-*]\s+/i.test(text)) return "bulleted_list";
  return "ordered_text";
}

function cleanSequenceText(text) {
  return normalizeText(text)
    .replace(/^\s*(step\s*)?\d+[\).:-]\s*/i, "")
    .replace(/^\s*[-*]\s+/, "")
    .trim();
}

function extractTitleCasePhrases(text) {
  const matches = normalizeText(text).match(
    /\b[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*){1,5}\b/g
  );

  return uniqueBy(matches || [], (item) => lower(item))
    .filter((phrase) => {
      const wordCount = phrase.split(/\s+/).length;

      if (wordCount < 2) return false;
      if (phrase.length > 80) return false;

      return true;
    });
}

function extractDeploymentQualifiedPhrases(text = "") {
  const value = normalizeText(text);

  const matches =
    value.match(
      /\b[A-Z][A-Za-z0-9/+.-]*(?:\s+[A-Z][A-Za-z0-9/+.-]*){0,2}\s+(?:A|B|C|D|East|West|North|South|Primary|Secondary)\b/g
    ) || [];

  return uniqueBy(matches, lower)
    .filter((phrase) => {
      if (/^region\s+/i.test(phrase)) return false;
      if (/^engine\s+/i.test(phrase)) return false;

      const words = phrase.split(/\s+/);
      if (words.length > 4) return false;

      return true;
    });
}

function extractExternalActorFromSequenceText(text) {
  const value = normalizeText(text);

  const match = value.match(
    /\b([A-Z][A-Za-z0-9]*(?:\s+(?:User|Client|Browser|Consumer|App|Application|System|Service|Operator|Device|Viewer|Customer)){0,3}\s+(?:User|Client|Browser|Consumer|App|Application|System|Service|Operator|Device|Viewer|Customer)|(?:User|Client|Browser|Consumer|App|Application|System|Service|Operator|Device|Viewer|Customer)(?:\s+[A-Z][A-Za-z0-9]*){0,3})\b(?=\s+(?:sends|send|calls|call|requests|request|forwards|forward|routes|route|connects|connects to|hits|accesses|enters|initiates))/i
  );

  if (!match) return null;

  const name = normalizeText(match[1]);

  if (!name || name.length < 3) return null;

  return {
    id: `external_actor_${normalizeKey(name).slice(0, 40)}`,
    name,
    role: "external_actor",
    source: "explicit_sequence_external_actor",
  };
}

function buildFallbackSequenceEntities(text) {
  const phrases =
    extractTitleCasePhrases(text)
      .filter((phrase) =>
        looksLikeArchitectureCandidate(phrase)
      )
      .filter((phrase) =>
        !isLikelyJunkArchitectureCandidate({
          name: phrase,
        })
      );

  if (phrases.length > 0) {
    return phrases.map((phrase) => ({
      component: {
        id: `sequence_entity_${normalizeKey(phrase).slice(0, 40)}`,
        name: phrase,
        role: "document_sequence_entity",
      },
    }));
  }

  return [
    {
      component: {
        id: `sequence_reference_${normalizeKey(text).slice(0, 40)}`,
        name: text,
        role: "document_sequence_reference",
      },
    },
  ];
}

function extractSequencePromotedComponents(
  explicitSequences = [],
  existingComponents = []
) {
  const existingIds = new Set(
    existingComponents.map((component) => component.id)
  );

  const promoted = [];

  for (const sequence of explicitSequences) {
    for (const item of sequence.items || []) {
      for (const entity of item.entities || []) {
        if (!entity?.id || !entity?.name) continue;
        if (existingIds.has(entity.id)) continue;

        if (
          entity.role !== "document_sequence_entity" &&
          entity.role !== "external_actor"
        ) {
          continue;
        }

        if (
          entity.role === "document_sequence_entity" &&
          (
            !looksLikeArchitectureCandidate(entity.name) ||
            isLikelyJunkArchitectureCandidate({
              name: entity.name,
            })
          )
        ) {
          continue;
        }

        const componentAdmission =
          evaluateComponentCandidate({
            component: {
              name: entity.name,
              type:
                entity.role === "external_actor"
                  ? "external_actor"
                  : "sequence_entity",
              source: "explicit_sequence",
            },
            evidenceItems: [],
          });

        if (
          entity.role === "document_sequence_entity" &&
          !componentAdmission.eligible
        ) {
          continue;
        }

        promoted.push({
          id: entity.id,
          name: entity.name,
          type:
            entity.role === "external_actor"
              ? "external_actor"
              : "sequence_entity",
          role:
            entity.role === "external_actor"
              ? "external_actor"
              : "process_step",
          graphEligible: true,
          structuralScore: 1,
          componentAdmission: {
            score: componentAdmission.score,
            signals: componentAdmission.signals,
          },
          source: "explicit_sequence",
          evidenceIds: [item.evidenceId].filter(Boolean),
          confidence:
            sequence.confidence || "deterministic",
        });

        existingIds.add(entity.id);
      }
    }
  }

  return promoted;
}

function recoverLeadingSequenceEntity(text, components = []) {
  const normalized = normalizeText(text);

  for (const component of components) {
    const name = normalizeText(component.name);
    if (!name) continue;

    if (normalized.startsWith(name) || normalized.startsWith(`${name} `)) {
      return { component };
    }
  }

  return null;
}

function extractExplicitSequences(documentUnderstanding = {}, components = []) {
  const evidence = documentUnderstanding.evidence || [];
  const bySection = groupEvidenceBySection(evidence);
  const sequences = [];

  let sequenceIndex = 1;

  for (const [sectionKey, sectionItems] of bySection.entries()) {
    const orderedItems = sectionItems
        .filter((item) => hasSequenceMarker(getEvidenceText(item)))
        .map((item, index) => {
            const rawText = getEvidenceText(item);
            const text = cleanSequenceText(rawText);
            let mentioned = findMentionedComponents(text, components);

            const recoveredLeading =
              recoverLeadingSequenceEntity(text, components);

            if (recoveredLeading) {
              const alreadyPresent = mentioned.some(
                (entry) => entry.component.id === recoveredLeading.component.id
              );

              if (!alreadyPresent) {
                mentioned = [recoveredLeading, ...mentioned];
              }
            }

            const externalActor = extractExternalActorFromSequenceText(text);

            if (externalActor) {
            const alreadyMentioned = mentioned.some(
                (entry) => entry?.component?.id === externalActor.id ||
                lower(entry?.component?.name) === lower(externalActor.name)
            );

            if (!alreadyMentioned) {
                mentioned = [
                {
                    component: externalActor,
                },
                ...mentioned,
                ];
            }
            }

            if (mentioned.length === 0) {
            mentioned = buildFallbackSequenceEntities(text);
            }

            return {
              order:
                index + 1,

              text,
              rawText,

              source:
                inferSequenceSource(rawText),

              sequenceSource:
                inferSequenceSource(rawText),

              evidenceId:
                item.id ||
                null,

              page:
                item.page ||
                null,

              sectionId:
                item.sectionId ||
                null,

              parentSectionId:
                item.parentSectionId ||
                null,

              sectionOrder:
                item.sectionOrder ??
                null,

              orderWithinSection:
                item.orderWithinSection ??
                null,

              sectionDepth:
                item.sectionDepth ??
                null,

              headingKind:
                item.headingKind ||
                null,

              entities:
                mentioned.map((entry) => ({
                  id:
                    entry.component.id,

                  name:
                    entry.component.name,

                  role:
                    entry.component.role,
                })),
            };
        })
        .filter((item) => item.text && item.entities.length > 0);

        if (orderedItems.length < 2) continue;

        const groupsBySource = orderedItems.reduce((acc, item) => {
        const key = item.sequenceSource || item.source || "ordered_text";

        if (!acc.has(key)) {
            acc.set(key, []);
        }

        acc.get(key).push(item);

        return acc;
        }, new Map());

        for (const [source, sourceItems] of groupsBySource.entries()) {
        if (sourceItems.length < 2) continue;

        sequences.push({
            id: `explicit_sequence_${sequenceIndex}`,
            title: normalizeText(sectionKey),
            type: "ordered_sequence",
            source,
            confidence: "deterministic",
            itemCount: sourceItems.length,
            items: sourceItems.map((item, itemIndex) => ({
            ...item,
            order: itemIndex + 1,
            })),
        });

        sequenceIndex += 1;
        }
  }

  return sequences;
}

function makeRelationship({
  source,
  target,
  type,
  reason,
  evidenceIds,
  evidenceText,
  inferred,
  direction = "unknown",
  semanticFlowMetadata = null,
}) {
    return {
    id: `arch_rel_${source.id}_${target.id}_${reason}`.replace(/[^a-zA-Z0-9_]/g, "_"),
    sourceId: source.id,
    sourceName: source.name,
    sourceRole: source.role,
    targetId: target.id,
    targetName: target.name,
    targetRole: target.role,
    type,
    direction,
    inferred: Boolean(inferred),
    confidence: RELATIONSHIP_CONFIDENCE[reason] || "low",
    reason,
    evidenceIds: uniqueBy(evidenceIds || [], (id) => id),
    evidenceText: normalizeText(evidenceText),

    semanticFlowType:
      semanticFlowMetadata?.semanticFlowType || null,

    operationalIntent:
      semanticFlowMetadata?.operationalIntent || null,

    interactionMode:
      semanticFlowMetadata?.interactionMode || undefined,

    flowPriority:
      semanticFlowMetadata?.flowPriority || undefined,
  };
}

function attachDocumentContextToRelationships(
  relationships = [],
  evidence = []
) {
  return asArray(relationships).map(
    (relationship) => {
      const evidenceContext =
        collectEvidenceContext({
          evidenceIds:
            relationship.evidenceIds,

          evidence,
        });

      return {
        ...relationship,

        pages:
          uniqueValues([
            ...asArray(
              relationship.pages
            ),
            ...evidenceContext.pages,
          ]),

        sectionIds:
          uniqueValues([
            ...asArray(
              relationship.sectionIds
            ),
            ...evidenceContext.sectionIds,
          ]),

        parentSectionIds:
          uniqueValues([
            ...asArray(
              relationship.parentSectionIds
            ),
            ...evidenceContext.parentSectionIds,
          ]),

        sectionOrders:
          uniqueValues([
            ...asArray(
              relationship.sectionOrders
            ),
            ...evidenceContext.sectionOrders,
          ]),

        sectionDepths:
          uniqueValues([
            ...asArray(
              relationship.sectionDepths
            ),
            ...evidenceContext.sectionDepths,
          ]),

        headingKinds:
          uniqueValues([
            ...asArray(
              relationship.headingKinds
            ),
            ...evidenceContext.headingKinds,
          ]),

        structureBackedEvidenceIds:
          uniqueValues([
            ...asArray(
              relationship
                .structureBackedEvidenceIds
            ),
            ...evidenceContext
              .structureBackedEvidenceIds,
          ]),
      };
    }
  );
}


function extractExplicitRelationships(documentUnderstanding = {}, components = []) {
  const relationships = [];
  const sourceRelationships = documentUnderstanding.relationships || [];

  for (const relationship of sourceRelationships) {
    const sourceName = normalizeText(
      relationship.sourceName ||
        relationship.source ||
        relationship.from ||
        relationship.subject
    );

    const targetName = normalizeText(
      relationship.targetName ||
        relationship.target ||
        relationship.to ||
        relationship.object
    );

    if (!sourceName || !targetName) continue;

    const source = components.find((component) => lower(component.name) === lower(sourceName));
    const target = components.find((component) => lower(component.name) === lower(targetName));

    if (!source || !target) continue;

    const relationshipType = lower(relationship.type || relationship.relationship || "");
    const evidenceText = normalizeText(
      relationship.evidenceText || relationship.text || relationship.reason || ""
    );

    const isFlow =
      relationshipType.includes("flow") ||
      relationshipType.includes("connect") ||
      relationshipType.includes("route") ||
      relationshipType.includes("send") ||
      relationshipType.includes("arrow") ||
      hasArrowSyntax(evidenceText) ||
      hasFlowLanguage(evidenceText);

    const isOnlyCoMention = relationshipType.includes("co_mentions");

    const semanticFlowMetadata =
      inferSemanticFlowMetadata(evidenceText);

    relationships.push(
      makeRelationship({
        source,
        target,
        type: isFlow ? "explicit_flow" : "architecture_association",
        reason: isFlow
          ? "explicit_flow"
          : isOnlyCoMention
            ? "same_section_co_mention"
            : "explicit_definition",
        evidenceIds: relationship.evidenceIds || [relationship.evidenceId].filter(Boolean),
        evidenceText,
        inferred: !isFlow && isOnlyCoMention,
        direction: isFlow ? "directed_or_implied" : "defined_association",
        semanticFlowMetadata,
      })
    );
  }

  return relationships;
}

function inferDirectionalConnectorType(text = "") {
  const normalized = lower(text);

  if (
    /\b(validates?|authenticates?|checks?|verifies?|filters?)\b/.test(normalized)
  ) {
    return "checkpoint";
  }

  if (
    /\b(through|via)\b/.test(normalized)
  ) {
    return "middleware";
  }

  if (
    /\b(sends?|routes?|forwards?|passes?|delivers?|pushes?|calls?)\b/.test(normalized)
  ) {
    return "request_flow";
  }

  return "association";
}

function inferSemanticFlowMetadata(text = "") {
  const normalized = lower(text);

  if (/\b(metrics?|telemetry|observability|logs?|monitoring|health|reports?|emits?|collects?)\b/.test(normalized)) {
    return {
      semanticFlowType: "observability_signal",
      operationalIntent: "report_or_collect_operational_signals",
      interactionMode: "observability_signal",
      flowPriority: "background",
    };
  }

  if (/\b(config|configuration|control plane|policy|rules?|settings?|pushes? config|manages? config|controls?)\b/.test(normalized)) {
    return {
      semanticFlowType: "configuration_flow",
      operationalIntent: "apply_or_distribute_control_configuration",
      interactionMode: "configuration_flow",
      flowPriority: "supporting",
    };
  }

  if (/\b(auth|authentication|authorization|authorize|validates?|verifies?|access check|policy check|token|credential)\b/.test(normalized)) {
    return {
      semanticFlowType: "auth_validation",
      operationalIntent: "validate_identity_access_or_policy",
      interactionMode: "auth_validation",
      flowPriority: "supporting",
    };
  }

  if (/\b(cache|cdn|edge cache|payload|content|object|asset|manifest|deliver|delivery)\b/.test(normalized)) {
    return {
      semanticFlowType: "payload_delivery",
      operationalIntent: "deliver_content_or_payload",
      interactionMode: "payload_delivery",
      flowPriority: "primary",
    };
  }

  if (/\b(async|event|queue|publish|subscribe|stream|message|notification)\b/.test(normalized)) {
    return {
      semanticFlowType: "async_event",
      operationalIntent: "publish_or_process_async_event",
      interactionMode: "async_event",
      flowPriority: "supporting",
    };
  }

  return {
    semanticFlowType: "request_response",
    operationalIntent: "move_request_or_handoff_forward",
    interactionMode: "request_response",
    flowPriority: "primary",
  };
}

function extractDirectionalFlowRelationships(documentUnderstanding = {}, components = []) {
  const evidence = documentUnderstanding.evidence || [];
  const relationships = [];

  for (const item of evidence) {
    const text = getEvidenceText(item);
    if (!text) continue;

    const isDirectional = hasArrowSyntax(text) || hasFlowLanguage(text);
    if (!isDirectional) continue;

    const mentioned = findMentionedComponents(text, components);
    if (mentioned.length < 2 || mentioned.length > 8) continue;

    const connectorType = inferDirectionalConnectorType(text);
    const semanticFlowMetadata =
      inferSemanticFlowMetadata(text);

    if (connectorType === "request_flow" || hasArrowSyntax(text)) {
      for (let i = 0; i < mentioned.length - 1; i += 1) {
        relationships.push(
          makeRelationship({
            source: mentioned[i].component,
            target: mentioned[i + 1].component,
            type: "explicit_flow",
            reason: hasArrowSyntax(text) ? "explicit_flow" : "directional_flow_text",
            evidenceIds: [item.id].filter(Boolean),
            evidenceText: text,
            inferred: false,
            direction: hasArrowSyntax(text) ? "arrow_text_order" : "verb_text_order",
            semanticFlowMetadata,
          })
        );
      }

      continue;
    }

    if (connectorType === "checkpoint" || connectorType === "middleware") {
      relationships.push(
        makeRelationship({
          source: mentioned[0].component,
          target: mentioned[1].component,
          type: "explicit_flow",
          reason: "directional_flow_text",
          evidenceIds: [item.id].filter(Boolean),
          evidenceText: text,
          inferred: false,
          direction: "checkpoint_or_middleware",
          semanticFlowMetadata,
        })
      );
    }
  }

  return relationships;
}

function extractSameSentenceFlowRelationships(documentUnderstanding = {}, components = []) {
  const evidence = documentUnderstanding.evidence || [];
  const relationships = [];

  for (const item of evidence) {
    const text = getEvidenceText(item);
    if (!text || !hasFlowLanguage(text)) continue;

    for (const clause of splitIntoClauses(text)) {
      if (!hasFlowLanguage(clause)) continue;
      const semanticFlowMetadata =
        inferSemanticFlowMetadata(clause);

      const mentioned = findMentionedComponents(clause, components);
      if (mentioned.length < 2 || mentioned.length > 5) continue;

      for (let i = 0; i < mentioned.length - 1; i += 1) {
        relationships.push(
          makeRelationship({
            source: mentioned[i].component,
            target: mentioned[i + 1].component,
            type: "explicit_flow",
            reason: "same_sentence_flow_context",
            evidenceIds: [item.id].filter(Boolean),
            evidenceText: clause,
            inferred: false,
            direction: "clause_order_with_flow_language",
            semanticFlowMetadata,
          })
        );
      }
    }
  }

  return relationships;
}

function groupEvidenceBySection(evidence = []) {
  const bySection = new Map();

  for (const item of evidence) {
    const sectionKey =
      item.sectionId ||
      item.sectionTitle ||
      item.heading ||
      `page_${item.page || "unknown"}`;

    if (!bySection.has(sectionKey)) bySection.set(sectionKey, []);
    bySection.get(sectionKey).push(item);
  }

  return bySection;
}

function extractOrderedSequenceRelationships(
    documentUnderstanding = {},
    components = [],
    knownRelationships = []
    ) {
  const relationships = [];
  const explicitSequences = extractExplicitSequences(documentUnderstanding, components);

  const reverseFlowTerms =
    /\b(return|returns|response|responds|back|rollback|fallback|revert|cleanup|tear down|teardown)\b/i;

  for (const sequence of explicitSequences) {
    const ordered = sequence.items || [];

    for (let i = 0; i < ordered.length - 1; i += 1) {
      const current = ordered[i];
      const next = ordered[i + 1];

      if (reverseFlowTerms.test(current.text) || reverseFlowTerms.test(next.text)) continue;

      const sourceEntity = current.entities[current.entities.length - 1];
      const targetEntity = next.entities[0];

      if (!sourceEntity || !targetEntity) continue;
      if (sourceEntity.id === targetEntity.id) continue;

      const source = components.find((component) => component.id === sourceEntity.id);
      const target = components.find((component) => component.id === targetEntity.id);

      if (!source || !target) continue;

      const semanticFlowMetadata =
        inferSemanticFlowMetadata(`${current.text} ${next.text}`);


      const intermediateComponents = recoverIntermediateFlowComponents(
        source,
        target,
        components,
        [...relationships, ...knownRelationships]
        );

        if (intermediateComponents.length > 0) {
        for (const middle of intermediateComponents) {
            relationships.push(
            makeRelationship({
                source,
                target: middle,
                type: "explicit_flow",
                reason: "ordered_sequence",
                evidenceIds: [current.evidenceId].filter(Boolean),
                evidenceText: current.text,
                inferred: true,
                direction: "recovered_intermediate_processing_tier",
                semanticFlowMetadata,
            })
            );

            relationships.push(
            makeRelationship({
                source: middle,
                target,
                type: "explicit_flow",
                reason: "ordered_sequence",
                evidenceIds: [next.evidenceId].filter(Boolean),
                evidenceText: next.text,
                inferred: true,
                direction: "recovered_intermediate_processing_tier",
                semanticFlowMetadata,
            })
            );
        }

        continue;
        }

        relationships.push(
        makeRelationship({
            source,
            target,
            type: "explicit_flow",
            reason: "ordered_sequence",
            evidenceIds: [current.evidenceId, next.evidenceId].filter(Boolean),
            evidenceText: `${current.text} ${next.text}`.slice(0, 700),
            inferred: false,
            direction: "explicit_document_sequence_order",
            semanticFlowMetadata,
        })
        );
    }
  }

  return relationships;
}

function recoverIntermediateFlowComponents(
  source,
  target,
  components = [],
  relationships = []
) {
  if (!source || !target) return [];


  const candidates = components.filter((component) => {
    if (!component?.id) return false;

    if (
      component.id === source.id ||
      component.id === target.id
    ) {
      return false;
    }

    const role = lower(component.role);
    const name = lower(component.name);

    const isProcessingLike =
      role === "system_component" ||
      role === "process_step";

    if (!isProcessingLike) return false;

    const looksLikeMiddleTier =
      /\b(app|application|service|processor|worker|execution|cluster|engine|runtime)\b/i.test(
        name
      );

    if (!looksLikeMiddleTier) return false;

    return true;
  });

  const bridgingCandidates = candidates.filter((candidate) => {
    const inbound = relationships.some(
      (rel) =>
        rel.targetId === candidate.id &&
        rel.sourceId === source.id
    );

    const outbound = relationships.some(
      (rel) =>
        rel.sourceId === candidate.id &&
        rel.targetId === target.id
    );

    return inbound || outbound;
  });

  return bridgingCandidates;
}

function extractSameSectionRelationships(documentUnderstanding = {}, components = []) {
  const relationships = [];
  const evidence = documentUnderstanding.evidence || [];
  const bySection = groupEvidenceBySection(evidence);
  const WINDOW_SIZE = 1;
  const MAX_DISTANCE = 250;

  for (const sectionItems of bySection.values()) {
    const sectionText = sectionItems.map(getEvidenceText).join(" ");
    const sectionTextLower = lower(sectionText);

    const mentioned = components
      .map((component) => {
        const firstMentionIndex = sectionTextLower.indexOf(lower(component.name));

        return {
          component,
          index: firstMentionIndex,
        };
      })
      .filter((entry) => entry.index >= 0)
      .sort((a, b) => a.index - b.index);

    if (mentioned.length < 2 || mentioned.length > 8) continue;

    const evidenceIds = sectionItems.map((item) => item.id).filter(Boolean);
    const reason = hasFlowLanguage(sectionText)
      ? "same_section_flow_context"
      : "same_section_co_mention";

    for (let i = 0; i < mentioned.length; i += 1) {
      for (
        let offset = 1;
        offset <= WINDOW_SIZE && i + offset < mentioned.length;
        offset += 1
      ) {
        const sourceEntry = mentioned[i];
        const targetEntry = mentioned[i + offset];

        const source = sourceEntry.component;
        const target = targetEntry.component;

        if (!source || !target) continue;
        if (source.id === target.id) continue;

        const distance = Math.abs(targetEntry.index - sourceEntry.index);
        if (distance > MAX_DISTANCE) continue;

        const localTextStart = Math.max(0, sourceEntry.index - 80);
        const localTextEnd = Math.min(
          sectionText.length,
          targetEntry.index + target.name.length + 80
        );
        const localText = sectionText.slice(localTextStart, localTextEnd);

        const localHasFlowLanguage = hasFlowLanguage(localText) || hasArrowSyntax(localText);

        if (reason === "same_section_flow_context" && !localHasFlowLanguage) {
          continue;
        }

        const semanticFlowMetadata =
          inferSemanticFlowMetadata(localText);

        relationships.push(
          makeRelationship({
            source,
            target,
            type:
              reason === "same_section_flow_context"
                ? "explicit_flow"
                : "architecture_association",
            reason,
            evidenceIds,
            evidenceText: localText.slice(0, 500),
            inferred: true,
            direction:
              reason === "same_section_flow_context"
                ? "local_section_order_implied"
                : "undirected",
              semanticFlowMetadata,
          })
        );
      }
    }
  }

  return relationships;
}

function extractCrossPageRelationships(documentUnderstanding = {}, components = []) {
  const evidence = documentUnderstanding.evidence || [];
  const pairMap = new Map();

  for (const item of evidence) {
    const mentioned = components.filter((component) => evidenceMentionsComponent(item, component));
    if (mentioned.length < 2 || mentioned.length > 8) continue;

    for (let i = 0; i < mentioned.length; i += 1) {
      for (let j = i + 1; j < mentioned.length; j += 1) {
        const names = [lower(mentioned[i].name), lower(mentioned[j].name)].sort();
        const key = `${names[0]}::${names[1]}`;

        if (!pairMap.has(key)) {
          pairMap.set(key, {
            source: mentioned[i],
            target: mentioned[j],
            pages: new Set(),
            evidenceIds: [],
            evidenceText: [],
          });
        }

        const pair = pairMap.get(key);
        pair.pages.add(item.page || "unknown");
        if (item.id) pair.evidenceIds.push(item.id);
        pair.evidenceText.push(getEvidenceText(item));
      }
    }
  }

  return [...pairMap.values()]
    .filter((pair) => pair.pages.size >= 2)
    .map((pair) =>
      makeRelationship({
        source: pair.source,
        target: pair.target,
        type: "architecture_association",
        reason: "repeated_cross_page_co_mention",
        evidenceIds: pair.evidenceIds,
        evidenceText: pair.evidenceText.join(" ").slice(0, 500),
        inferred: true,
        direction: "undirected",
      })
    );
}

function extractContinuityRepairRelationships(relationships = [], components = []) {
  const existingDirected = new Set(
    relationships.map((rel) => `${rel.sourceId}->${rel.targetId}`)
  );

  const incoming = new Map();
  const outgoing = new Map();

  for (const rel of relationships.filter((item) => item.type === "explicit_flow")) {
    if (!outgoing.has(rel.sourceId)) outgoing.set(rel.sourceId, []);
    if (!incoming.has(rel.targetId)) incoming.set(rel.targetId, []);

    outgoing.get(rel.sourceId).push(rel);
    incoming.get(rel.targetId).push(rel);
  }

  const repaired = [];

  for (const component of components) {
    const inEdges = incoming.get(component.id) || [];
    const outEdges = outgoing.get(component.id) || [];

    if (inEdges.length !== 1 || outEdges.length !== 1) continue;

    const prev = inEdges[0];
    const next = outEdges[0];

    const hasExplicitInbound = prev.type === "explicit_flow" && !prev.inferred;
    const hasExplicitOutbound = next.type === "explicit_flow" && !next.inferred;

    const meaningfulBridgeSignals =
      /\b(app|application|service|processor|worker|execution|cluster|engine|runtime)\b/i.test(
        lower(component.name)
      );

    const shouldPreserveBridgeNode =
      hasExplicitInbound && hasExplicitOutbound && meaningfulBridgeSignals;

    if (shouldPreserveBridgeNode) continue;

    if (prev.sourceId === next.targetId) continue;
    if (existingDirected.has(`${prev.sourceId}->${next.targetId}`)) continue;

    const semanticFlowMetadata =
      inferSemanticFlowMetadata(
        `${prev.evidenceText || ""} ${next.evidenceText || ""}`
      );

    repaired.push(
      makeRelationship({
        source: {
          id: prev.sourceId,
          name: prev.sourceName,
          role: prev.sourceRole,
        },
        target: {
          id: next.targetId,
          name: next.targetName,
          role: next.targetRole,
        },
        type: "explicit_flow",
        reason: "continuity_repair",
        evidenceIds: [...(prev.evidenceIds || []), ...(next.evidenceIds || [])],
        evidenceText: `${prev.evidenceText || ""} ${next.evidenceText || ""}`.trim(),
        inferred: true,
        direction: "repaired_from_adjacent_flow_edges",
        semanticFlowMetadata,
      })
    );
  }

  return repaired;
}

function confidenceWeight(confidence) {
  switch (confidence) {
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

function dedupeRelationships(relationships = []) {
  const priority = {
    explicit_flow: 7,
    directional_flow_text: 6,
    explicit_definition: 5,
    same_sentence_flow_context: 5,
    ordered_sequence: 4,
    same_section_flow_context: 3,
    same_section_co_mention: 2,
    repeated_cross_page_co_mention: 1,
    continuity_repair: 1,
    diagram_adjacency_only: 1,
  };

  const byPair = new Map();

  for (const relationship of relationships) {
    const directed =
      relationship.type === "explicit_flow" ||
      relationship.direction !== "undirected";

    const key = directed
      ? `${relationship.sourceId}->${relationship.targetId}`
      : [relationship.sourceId, relationship.targetId].sort().join("::");

    const existing = byPair.get(key);

    if (
      !existing ||
      (priority[relationship.reason] || 0) > (priority[existing.reason] || 0)
    ) {
      byPair.set(key, relationship);
    } else {
      byPair.set(key, {
        ...existing,
        evidenceIds: uniqueBy(
          [...(existing.evidenceIds || []), ...(relationship.evidenceIds || [])],
          (id) => id
        ),
        evidenceText: normalizeText(
          `${existing.evidenceText || ""} ${relationship.evidenceText || ""}`
        ).slice(0, 700),
      });
    }
  }

  const finalRelationships = [];

  for (const relationship of byPair.values()) {
    const reverseKey = `${relationship.targetId}->${relationship.sourceId}`;
    const reverse = byPair.get(reverseKey);

    if (!reverse) {
      finalRelationships.push(relationship);
      continue;
    }

    const currentScore =
      (priority[relationship.reason] || 0) +
      confidenceWeight(relationship.confidence);

    const reverseScore =
      (priority[reverse.reason] || 0) +
      confidenceWeight(reverse.confidence);

    if (currentScore >= reverseScore) {
      finalRelationships.push(relationship);
    }
  }

  return uniqueBy(
    finalRelationships,
    (relationship) =>
      `${relationship.sourceId}->${relationship.targetId}:${relationship.reason}`
  );
}

function buildNarrationHints(relationships = []) {
  const highConfidenceCount = relationships.filter((item) => item.confidence === "high").length;
  const lowConfidenceCount = relationships.filter((item) => item.confidence === "low").length;

  return {
    cautiousLanguageRequired: lowConfidenceCount > 0,
    allowedAnalogies:
      highConfidenceCount > 0
        ? [
            {
              rule: "Analogies and real-world examples are allowed only for high-confidence explicit relationships.",
              minConfidence: "high",
            },
          ]
        : [],
    forbiddenBehavior: [
      "Do not invent component responsibilities.",
      "Do not turn low-confidence inferred edges into facts.",
      "Do not use real-world analogies for low-confidence relationships.",
    ],
  };
}

function collectSpatialRelationshipCandidates(spatialUnderstanding) {
  if (!spatialUnderstanding || !Array.isArray(spatialUnderstanding.pages)) return [];

  return spatialUnderstanding.pages.flatMap((page) => {
    return (page.relationships || []).map((relationship) => ({
      id: relationship.id,
      page: relationship.page,
      regionId: relationship.regionId,
      connectorId: relationship.connectorId,
      type: relationship.type,
      source: relationship.source,
      confidence: relationship.confidence,
      signalCount: relationship.signalCount,
      signals: relationship.signals,
      evidenceText: relationship.evidenceText,
      bounds: relationship.bounds,
      derivedFrom: relationship.derivedFrom || [],
      architectureUse: "candidate_only",
    }));
  });
}

function buildArchitectureUnderstanding(
  documentUnderstanding = {},
  spatialUnderstanding = {},
  options = {}
) {
  const registryComponents =
    extractCanonicalRegistryComponents(
      documentUnderstanding
    );

  const baseComponents =
    registryComponents.length > 0
      ? registryComponents
      : extractComponents(
          documentUnderstanding
        );
  const explicitSequences = extractExplicitSequences(documentUnderstanding, baseComponents);
  const promotedComponents = extractSequencePromotedComponents(
    explicitSequences,
    baseComponents
  );
  const rawComponents = uniqueBy(
    [...baseComponents, ...promotedComponents],
    (component) => component.id
  );

  const contextEnrichedComponents =
    attachDocumentContextToComponents(
      rawComponents,
      documentUnderstanding.evidence || []
    );

  const components =
  attachBoundariesToComponents(
    contextEnrichedComponents,
    options.architectureEvidence || {},
    documentUnderstanding
  );

  const spatialRelationshipCandidates =
    collectSpatialRelationshipCandidates(spatialUnderstanding);

  const knownFlowContext = [
    ...extractExplicitRelationships(documentUnderstanding, components),
    ...extractDirectionalFlowRelationships(documentUnderstanding, components),
    ...extractSameSentenceFlowRelationships(documentUnderstanding, components),
    ...extractSameSectionRelationships(documentUnderstanding, components),
    ];

    const initialRelationships = dedupeRelationships([
    ...knownFlowContext,
    ...extractOrderedSequenceRelationships(
        documentUnderstanding,
        components,
        knownFlowContext
    ),
    ...extractCrossPageRelationships(documentUnderstanding, components),
    ]);

  const rawRelationships = dedupeRelationships([
    ...initialRelationships,
    ...extractContinuityRepairRelationships(initialRelationships, components),
    ]);

    const typedRelationships = typeArchitectureRelationships(
      rawRelationships,
      options.architectureEvidence || {}
    );

    const evidenceMappedRelationships =
      mapArchitectureRelationshipsEvidence(
        typedRelationships,
        options.architectureEvidence || {}
      );

    const classifiedRelationships = classifyArchitectureRelationshipFlows(
      evidenceMappedRelationships
    );

    const stepArrowFusion = fuseStepArrowEvidence({
      relationships: classifiedRelationships,
      explicitSequences,
    });

    const contextualRelationships =
      attachContextualRolesToRelationships(
        stepArrowFusion.relationships ||
        classifiedRelationships
      );

    const relationships =
      attachDocumentContextToRelationships(
        contextualRelationships,
        documentUnderstanding.evidence || []
      );

    const unknownComponentInference =
      inferUnknownEnterpriseComponents({
        components,
        relationships,
      });

    const flows = relationships.filter(
      (relationship) => relationship.type === "explicit_flow"
    );

    
    const graphPartitions = buildArchitectureGraphPartitions(relationships);

    const architectureRegionCollapse =
    buildArchitectureRegionCollapse({
        components,
        relationships,
    });

    const contextEligibleComponents =
  components.filter(
    (component) =>
      asArray(
        component.structureBackedEvidenceIds
      ).length > 0
  );

const contextEligibleRelationships =
  relationships.filter(
    (relationship) =>
      asArray(
        relationship.structureBackedEvidenceIds
      ).length > 0
  );

const componentContextMissingCount =
  contextEligibleComponents.filter(
    (component) =>
      asArray(
        component.sectionIds
      ).length === 0
  ).length;

const relationshipContextMissingCount =
  contextEligibleRelationships.filter(
    (relationship) =>
      asArray(
        relationship.sectionIds
      ).length === 0
  ).length;

const explicitSequenceItemCount =
  explicitSequences.reduce(
    (sum, sequence) =>
      sum +
      asArray(sequence.items).length,
    0
  );

const explicitSequenceItemWithSectionCount =
  explicitSequences.reduce(
    (sum, sequence) =>
      sum +
      asArray(sequence.items).filter(
        (item) =>
          Boolean(item.sectionId)
      ).length,
    0
  );

const architectureContextPropagationHealth = {
  version:
    "architecture-context-propagation-health-v1",

  valid:
    componentContextMissingCount === 0 &&
    relationshipContextMissingCount === 0,

  componentCount:
    components.length,

  contextEligibleComponentCount:
    contextEligibleComponents.length,

  componentContextMissingCount,

  relationshipCount:
    relationships.length,

  contextEligibleRelationshipCount:
    contextEligibleRelationships.length,

  relationshipContextMissingCount,

  explicitSequenceItemCount,

  explicitSequenceItemWithSectionCount,
};

  return {
    version:
      "architecture-understanding-v5-context-propagation",

    sourceVersion:
      documentUnderstanding.version ||
      null,

    health: {
      contextPropagation:
        architectureContextPropagationHealth,
    },

    explicitSequences,

    deterministicGraph: {
    components,
    relationships,
    flows,
    partitions: graphPartitions,
    },

    spatialRelationshipCandidates,
    architectureRegionCollapse,

    stepArrowFusion: {
      version: stepArrowFusion.version,
      stats: stepArrowFusion.stats,
    },

    unknownComponentInference,

    semanticEnrichment: {
      hypotheses: [],
      note: "Future LLM hypotheses live here. They must never overwrite deterministicGraph.",
    },

    traversalInputs: {
        explicitSequences,
        trafficFlow: flows,
        primaryTrafficFlow: graphPartitions.primary,
        supportingTrafficFlow: graphPartitions.supporting,
        backgroundTrafficFlow: graphPartitions.background,
        unknownTrafficFlow: graphPartitions.unknown,

        graphTopology: relationships.map((relationship) => ({
        sourceId: relationship.sourceId,
        targetId: relationship.targetId,
        sourceRole: relationship.sourceRole,
        targetRole: relationship.targetRole,
        confidence: relationship.confidence,
        inferred: relationship.inferred,
        reason: relationship.reason,
      })),
      readingOrder: components.map((component) => component.id),
      importance: components.map((component) => ({
        componentId: component.id,
        role: component.role,
        score: component.evidenceIds?.length || 1,
      })),
      confidence: relationships.map((relationship) => ({
        relationshipId: relationship.id,
        confidence: relationship.confidence,
        reason: relationship.reason,
      })),
      owner: "lessonGraphBuilder",
    },

    narrationHints: buildNarrationHints(relationships),

    stats: {
      componentCount: components.length,
      explicitSequenceCount: explicitSequences.length,
      explicitSequenceItemCount: explicitSequences.reduce(
        (sum, sequence) => sum + (sequence.items?.length || 0),
        0
      ),
      relationshipCount: relationships.length,
      flowCount: flows.length,

      contextPropagationValid:
        architectureContextPropagationHealth.valid,

      contextEligibleComponentCount:
        architectureContextPropagationHealth
          .contextEligibleComponentCount,

      componentContextMissingCount:
        architectureContextPropagationHealth
          .componentContextMissingCount,

      contextEligibleRelationshipCount:
        architectureContextPropagationHealth
          .contextEligibleRelationshipCount,

      relationshipContextMissingCount:
        architectureContextPropagationHealth
          .relationshipContextMissingCount,

      explicitSequenceItemWithSectionCount:
        architectureContextPropagationHealth
          .explicitSequenceItemWithSectionCount,

      stepArrowFusedRelationshipCount:
        stepArrowFusion.stats.fusedRelationshipCount,

      stepArrowFusionStepCount:
          stepArrowFusion.stats.stepCount,

        contextualRoleRelationshipCount:
          relationships.filter((item) => item.contextualRoles).length,

        unknownComponentCount:
          unknownComponentInference.stats.unknownComponentCount,

        inferredUnknownComponentCount:
          unknownComponentInference.stats.inferredUnknownComponentCount,

        primaryFlowRelationshipCount: graphPartitions.stats.primaryCount,
        supportingFlowRelationshipCount: graphPartitions.stats.supportingCount,
        backgroundFlowRelationshipCount: graphPartitions.stats.backgroundCount,
        unknownFlowRelationshipCount: graphPartitions.stats.unknownCount,
        primaryTraversalInputCount: graphPartitions.primary.length,
        supportingTraversalInputCount: graphPartitions.supporting.length,
        backgroundTraversalInputCount: graphPartitions.background.length,
        spatialRelationshipCandidateCount: spatialRelationshipCandidates.length,

        collapsedRegionGroupCount:
        architectureRegionCollapse.stats.collapsedGroupCount,

        collapsedComponentCount:
        architectureRegionCollapse.stats.collapsedComponentCount,

        componentBoundaryAttachmentCount: components.reduce(
        (sum, component) => sum + (component.boundaries?.length || 0),
        0
        ),
        componentWithBoundaryCount: components.filter(
        (component) => component.boundaries?.length
        ).length,
      inferredRelationshipCount: relationships.filter((item) => item.inferred).length,
      explicitRelationshipCount: relationships.filter((item) => !item.inferred).length,
      roleBreakdown: components.reduce((acc, item) => {
        acc[item.role] = (acc[item.role] || 0) + 1;
        return acc;
      }, {}),
      confidenceBreakdown: relationships.reduce((acc, item) => {
        acc[item.confidence] = (acc[item.confidence] || 0) + 1;
        return acc;
      }, {}),
      reasonBreakdown: relationships.reduce((acc, item) => {
        acc[item.reason] = (acc[item.reason] || 0) + 1;
        return acc;
      }, {}),
    },
  };
}


function boundaryMentionsComponent(boundary = {}, component = {}) {
  const boundaryText = lower(boundary.rawText || boundary.label || boundary.text || "");
  const componentName = lower(component.name || "");

  if (!boundaryText || !componentName) return false;

  return boundaryText.includes(componentName);
}

function componentEvidenceMentionsBoundary(component = {}, boundary = {}, evidence = []) {
  const boundaryText = lower(boundary.rawText || "");
  const componentName = lower(component.name || "");

  if (!boundaryText || !componentName) return false;

  const componentEvidence = getEvidenceForComponent(component, evidence);

  for (const item of componentEvidence) {
    const text = lower(getEvidenceText(item));

    if (!text) continue;

    const mentionsComponent = text.includes(componentName);
    const mentionsBoundary = text.includes(boundaryText);

    if (mentionsComponent && mentionsBoundary) {
      return true;
    }

    const localWindowPattern = new RegExp(
      `${componentName}.{0,120}${boundaryText}|${boundaryText}.{0,120}${componentName}`,
      'i'
    );

    if (localWindowPattern.test(text)) {
      return true;
    }
  }

  return false;
}


function extractExplicitDeploymentIdentityBoundary(component = {}) {
  const name = normalizeText(component.name);

  if (!name) return null;

  const match = name.match(
    /\b(region|availability zone|az|zone|site|cell|data center|datacenter)\s+([a-z0-9-]+)\b/i
  );

  if (!match) return null;

  const deploymentScope = lower(match[1]);
  const deploymentDifferentiator =
    normalizeText(match[2]);

  return {
    rawText: name,
    rawBoundaryLabel: name,
    canonicalBoundaryType: "region_group",
    boundaryType: "region_group",
    deploymentScope,
    deploymentDifferentiator,
    confidence: "high",
    source: "explicit_component_deployment_identity",
    evidenceIds: asArray(component.evidenceIds),
  };
}

function attachBoundariesToComponents(
  components = [],
  architectureEvidence = {},
  documentUnderstanding = {}
) {
  const evidence = documentUnderstanding.evidence || [];
  const boundaries = typeBoundaryEvidenceList(
    architectureEvidence.boundaryEvidence || []
  );

  return components.map((component) => {
    const matchedBoundaries = boundaries
      .filter((boundary) => {
        return (
          boundaryMentionsComponent(boundary, component) ||
          componentEvidenceMentionsBoundary(
            component,
            boundary,
            evidence
          )
        );
      })
      .map((boundary) => ({
        rawText: boundary.rawText,

        rawBoundaryLabel:
          boundary.rawBoundaryLabel ||
          boundary.rawText,

        canonicalBoundaryType:
          boundary.canonicalBoundaryType ||
          boundary.boundaryType,

        deploymentDifferentiator:
          boundary.deploymentDifferentiator ||
          null,

        boundaryType: boundary.boundaryType,
        confidence: boundary.confidence,
        source: boundary.source,
        evidenceIds: boundary.evidenceIds || [],
      }));

    const explicitDeploymentIdentity =
      extractExplicitDeploymentIdentityBoundary(component);

    const combinedBoundaries = [
      ...matchedBoundaries,
      ...(explicitDeploymentIdentity
        ? [explicitDeploymentIdentity]
        : []),
    ];

    return {
      ...component,
      boundaries: uniqueBy(
        combinedBoundaries,
        (item) =>
          `${item.boundaryType}:${lower(
            item.rawBoundaryLabel || item.rawText
          )}`
      ),
    };
  });
}

module.exports = {
  buildArchitectureUnderstanding,
  RELATIONSHIP_CONFIDENCE,
};