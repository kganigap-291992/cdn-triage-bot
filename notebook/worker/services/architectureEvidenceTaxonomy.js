'use strict';

/**
 * Cachey Notebook — Architecture Evidence Taxonomy
 *
 * Domain-independent vocabulary for architecture diagrams.
 *
 * Rule:
 * Document says what exists.
 * Public standards explain public terms.
 * LLM connects the two.
 *
 * This file must NOT contain Comcast/CDN/company-specific logic.
 */

const CONFIDENCE = Object.freeze({
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  UNKNOWN: 'unknown',
});

const NODE_TYPES = Object.freeze({
  EXTERNAL_ACTOR: 'external_actor',
  COMPONENT: 'component',
  SERVICE: 'service',
  GATEWAY_OR_ROUTER: 'gateway_or_router',
  PROCESSOR_OR_WORKER: 'processor_or_worker',
  DATA_STORE: 'data_store',
  QUEUE_OR_STREAM: 'queue_or_stream',
  CACHE: 'cache',
  OBSERVABILITY_SYSTEM: 'observability_system',
  CONTROL_OR_CONFIG_SYSTEM: 'control_or_config_system',
  SECURITY_OR_POLICY_SYSTEM: 'security_or_policy_system',
  UNKNOWN: 'unknown',
});

const EDGE_TYPES = Object.freeze({
  PRIMARY_FLOW: 'primary_flow',
  REQUEST_RESPONSE: 'request_response',
  CONTENT_OR_PAYLOAD_DELIVERY: 'content_or_payload_delivery',
  METADATA_REQUEST: 'metadata_request',
  CONTROL_FLOW: 'control_flow',
  CONFIGURATION_FLOW: 'configuration_flow',
  HEALTH_SIGNAL: 'health_signal',
  OBSERVABILITY_SIGNAL: 'observability_signal',
  ASYNC_EVENT: 'async_event',
  DEPENDENCY_LOOKUP: 'dependency_lookup',
  FAILURE_OR_FALLBACK: 'failure_or_fallback',
  REPLICATION_OR_SYNC: 'replication_or_sync',
  UNKNOWN: 'unknown',
});

const EDGE_STYLES = Object.freeze({
  SOLID: 'solid',
  DASHED: 'dashed',
  DOTTED: 'dotted',
  DOUBLE_LINE: 'double_line',
  THICK_LINE: 'thick_line',
  THIN_LINE: 'thin_line',
  COLORED_LINE: 'colored_line',
  BIDIRECTIONAL: 'bidirectional',
  CURVED: 'curved',
  NUMBERED_ARROW: 'numbered_arrow',
  UNKNOWN: 'unknown',
});

const BOUNDARY_TYPES = Object.freeze({
  DEPLOYMENT_BOUNDARY: 'deployment_boundary',
  LOGICAL_GROUP: 'logical_group',
  REGION_GROUP: 'region_group',
  ENVIRONMENT_GROUP: 'environment_group',
  CLUSTER_BOUNDARY: 'cluster_boundary',
  TRUST_BOUNDARY: 'trust_boundary',
  TENANT_BOUNDARY: 'tenant_boundary',
  NETWORK_BOUNDARY: 'network_boundary',
  TEAM_OR_OWNER_BOUNDARY: 'team_or_owner_boundary',
  UNKNOWN: 'unknown',
});

const FLOW_SHAPES = Object.freeze({
  LINEAR_PATH: 'linear_path',
  BRANCH_OR_FANOUT: 'branch_or_fanout',
  MERGE_OR_FANIN: 'merge_or_fanin',
  CYCLE_OR_LOOP: 'cycle_or_loop',
  BIDIRECTIONAL_EXCHANGE: 'bidirectional_exchange',
  REPEATED_REGIONAL_PATTERN: 'repeated_regional_pattern',
  PARALLEL_DUPLICATE_FLOW: 'parallel_duplicate_flow',
  CONTROL_PLANE_SIDE_FLOW: 'control_plane_side_flow',
  OBSERVABILITY_SIDE_FLOW: 'observability_side_flow',
  FAILURE_PATH: 'failure_path',
  ASYNC_PIPELINE: 'async_pipeline',
  UNKNOWN: 'unknown',
});

const EVIDENCE_SOURCES = Object.freeze({
  GLOSSARY: 'glossary',
  LEGEND: 'legend',
  CAPTION: 'caption',
  ARROW_LABEL: 'arrow_label',
  ARROW_STYLE: 'arrow_style',
  GROUP_BOX_LABEL: 'group_box_label',
  DOTTED_BOX_LABEL: 'dotted_box_label',
  SWIMLANE_LABEL: 'swimlane_label',
  NEARBY_NOTE: 'nearby_note',
  WIKI_REFERENCE: 'wiki_reference',
  NUMBERED_STEP: 'numbered_step',
  TABLE_ROW: 'table_row',
  SECTION_HEADING: 'section_heading',
  EXPLICIT_TEXT: 'explicit_text',
  LAYOUT_PROXIMITY: 'layout_proximity',
  REPEATED_PATTERN: 'repeated_pattern',
  UNKNOWN: 'unknown',
});

/**
 * Public standards are allowed to use external/public enrichment later.
 * Internal/private names must stay document-evidence only.
 */
const PUBLIC_STANDARD_TERMS = Object.freeze([
  'mpd',
  'mpeg-dash',
  'dash',
  'm3u8',
  'hls',
  '.ts',
  'ts',
  'mpeg-ts',
  'kubernetes',
  'k8s',
  'docker',
  'redis',
  'kafka',
  'prometheus',
  'grafana',
  'dns',
  'http',
  'https',
  'grpc',
  'tcp',
  'udp',
  'tls',
  'mtls',
  'jwt',
  'oauth',
  'saml',
  's3',
  'cdn',
  'api',
]);

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ');
}

function compactToken(value) {
  return normalizeText(value)
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9.+#-]/g, '');
}

function isPublicStandardTerm(term) {
  const raw = normalizeText(term);
  const compact = compactToken(term);

  if (!raw && !compact) return false;

  return PUBLIC_STANDARD_TERMS.some((known) => {
    const k = normalizeText(known);
    return raw === k || compact === compactToken(k);
  });
}

function isLikelyInternalTerm(term) {
  const raw = String(term || '').trim();

  if (!raw) return false;
  if (isPublicStandardTerm(raw)) return false;

  const compact = raw.replace(/[^A-Za-z0-9]/g, '');

  
  if (/^[A-Z]{2,12}$/.test(raw)) return true;

  if (/^[A-Z][A-Za-z0-9_-]{2,20}$/.test(raw)) {
    return !isPublicStandardTerm(raw);
 }

  if (/^[A-Z][a-z]+[0-9]+$/.test(compact)) return true;

  if (/^[A-Z]{2,}[A-Za-z0-9]*$/.test(compact)) return true;

  return false;
}

function inferEdgeTypeFromText(text) {
  const value = normalizeText(text);

  if (!value) return EDGE_TYPES.UNKNOWN;

  // BUG-22D.7
  // Action-first semantic classification.
  // More specific interaction semantics must outrank generic keywords.

  const semanticActionChecks = [
    {
      pattern: /\b(forwards? cache misses?)\b/,
      type: EDGE_TYPES.CONTENT_OR_PAYLOAD_DELIVERY,
    },
    {
      pattern: /\b(sends? requests?)\b/,
      type: EDGE_TYPES.REQUEST_RESPONSE,
    },
    {
      pattern: /\b(reads? and writes? operational data)\b/,
      type: EDGE_TYPES.REPLICATION_OR_SYNC,
    },
    {
      pattern: /\b(validates? authentication)\b/,
      type: EDGE_TYPES.CONTROL_FLOW,
    },
    {
      pattern: /\b(manages? internal service distribution)\b/,
      type: EDGE_TYPES.REQUEST_RESPONSE,
    },
    {
      pattern: /\b(distributes? traffic)\b/,
      type: EDGE_TYPES.REQUEST_RESPONSE,
    },
    {
      pattern: /\b(push(?:es)? config(?:uration)?)\b/,
      type: EDGE_TYPES.CONFIGURATION_FLOW,
    },
    {
      pattern: /\b(sends? metrics?)\b/,
      type: EDGE_TYPES.OBSERVABILITY_SIGNAL,
    },
    {
      pattern: /\b(publishes? manifest[s]?)\b/,
      type: EDGE_TYPES.METADATA_REQUEST,
    },
  ];

  for (const check of semanticActionChecks) {
    if (check.pattern.test(value)) {
      return check.type;
    }
  }

  const checks = [
    {
      type: EDGE_TYPES.OBSERVABILITY_SIGNAL,
      pattern:
        /\b(metric|metrics|log|logs|trace|telemetry|observability|monitor|monitoring|alert|dashboard|grafana|prometheus|splunk|datadog|elastic)\b/,
    },
    {
      type: EDGE_TYPES.HEALTH_SIGNAL,
      pattern:
        /\b(health|heartbeat|keepalive|liveness|readiness|probe|status check|healthcheck)\b/,
    },
    {
      type: EDGE_TYPES.FAILURE_OR_FALLBACK,
      pattern:
        /\b(fail|failure|fallback|retry|backup|secondary|error|exception|rollback|degraded)\b/,
    },
    {
      type: EDGE_TYPES.ASYNC_EVENT,
      pattern:
        /\b(queue|event|async|message|stream|topic|publish|subscribe|pubsub|producer|consumer)\b/,
    },
    {
      type: EDGE_TYPES.REPLICATION_OR_SYNC,
      pattern:
        /\b(sync|synchronize|replicate|replication|mirror|copy|backup copy)\b/,
    },
    {
      type: EDGE_TYPES.DEPENDENCY_LOOKUP,
      pattern:
        /\b(dns|lookup|resolve|resolution|discover|discovery|locator|registry)\b/,
    },
    {
      type: EDGE_TYPES.METADATA_REQUEST,
      pattern:
        /\b(manifest|playlist|mpd|m3u8|metadata|profile|index|schema|descriptor)\b/,
    },
    {
      type: EDGE_TYPES.CONTENT_OR_PAYLOAD_DELIVERY,
      pattern:
        /\b(segment|payload|content|media|video|audio|file|object|asset|\.ts|transport stream|cache miss|cache hit)\b/,
    },
    {
      type: EDGE_TYPES.CONTROL_FLOW,
      pattern:
        /\b(auth|authenticate|authentication|authorization|authorize|token|jwt|oauth|saml|rbac|policy|validate|validation|waf|firewall)\b/,
    },
    {
      type: EDGE_TYPES.CONFIGURATION_FLOW,
      pattern:
        /\b(config|configuration|control plane|orchestration|provision|deploy|deployment|settings|rules)\b/,
    },
    {
      type: EDGE_TYPES.REQUEST_RESPONSE,
      pattern:
        /\b(request|response|traffic|flow|call|handoff|sends|send|forwards|forward|routes|route|delivers|deliver|reads|writes|read|write)\b/,
    },
  ];

  for (const check of checks) {
    if (check.pattern.test(value)) {
      return check.type;
    }
  }

  return EDGE_TYPES.UNKNOWN;
}

function inferBoundaryTypeFromText(text) {
  const value = normalizeText(text);

  if (!value) return BOUNDARY_TYPES.UNKNOWN;

  if (/\b(kubernetes|k8s|cluster|pod|namespace|deployment)\b/.test(value)) {
    return BOUNDARY_TYPES.DEPLOYMENT_BOUNDARY;
  }

  if (/\b(region|zone|az|availability zone|datacenter|data center|dc)\b/.test(value)) {
    return BOUNDARY_TYPES.REGION_GROUP;
  }

  if (/\b(prod|production|stage|staging|dev|development|qa|test|environment)\b/.test(value)) {
    return BOUNDARY_TYPES.ENVIRONMENT_GROUP;
  }

  if (/\b(tenant|partner|customer|account)\b/.test(value)) {
    return BOUNDARY_TYPES.TENANT_BOUNDARY;
  }

  if (/\b(trust|security|dmz|firewall|private|public|vpc|subnet|network)\b/.test(value)) {
    return BOUNDARY_TYPES.NETWORK_BOUNDARY;
  }

  if (/\b(team|owner|ownership|domain)\b/.test(value)) {
    return BOUNDARY_TYPES.TEAM_OR_OWNER_BOUNDARY;
  }

  if (/\b(group|layer|tier|plane|boundary|box)\b/.test(value)) {
    return BOUNDARY_TYPES.LOGICAL_GROUP;
  }

  return BOUNDARY_TYPES.UNKNOWN;
}

function inferNodeTypeFromText(text) {
  const value = normalizeText(text);

  if (!value) return NODE_TYPES.UNKNOWN;

  if (/\b(client|user|browser|player|device|external|partner|consumer)\b/.test(value)) {
    return NODE_TYPES.EXTERNAL_ACTOR;
  }

  if (/\b(gateway|router|route|routing|load balancer|lb|proxy|ingress|edge)\b/.test(value)) {
    return NODE_TYPES.GATEWAY_OR_ROUTER;
  }

  if (/\b(worker|processor|job|compute|executor|transcoder|packager|pipeline)\b/.test(value)) {
    return NODE_TYPES.PROCESSOR_OR_WORKER;
  }

  if (/\b(db|database|store|storage|sql|postgres|mysql|dynamo|s3|bucket)\b/.test(value)) {
    return NODE_TYPES.DATA_STORE;
  }

  if (/\b(queue|kafka|topic|stream|bus|pubsub|rabbit|sqs)\b/.test(value)) {
    return NODE_TYPES.QUEUE_OR_STREAM;
  }

  if (/\b(cache|redis|memcache|cdn)\b/.test(value)) {
    return NODE_TYPES.CACHE;
  }

  if (/\b(metric|metrics|log|logs|trace|grafana|prometheus|splunk|elastic|datadog|observability)\b/.test(value)) {
    return NODE_TYPES.OBSERVABILITY_SYSTEM;
  }

  if (/\b(config|configuration|control|orchestrator|controller|scheduler|manager)\b/.test(value)) {
    return NODE_TYPES.CONTROL_OR_CONFIG_SYSTEM;
  }

  if (/\b(auth|policy|security|waf|firewall|rbac|iam|token)\b/.test(value)) {
    return NODE_TYPES.SECURITY_OR_POLICY_SYSTEM;
  }

  if (/\b(api|service|svc|app|application|component|module)\b/.test(value)) {
    return NODE_TYPES.SERVICE;
  }

  return NODE_TYPES.COMPONENT;
}

function makeEvidenceRecord({
  rawText = '',
  normalizedType = 'unknown',
  source = EVIDENCE_SOURCES.UNKNOWN,
  confidence = CONFIDENCE.UNKNOWN,
  evidenceIds = [],
  notes = '',
} = {}) {
  return {
    rawText: String(rawText || '').trim(),
    normalizedType,
    source,
    confidence,
    evidenceIds: Array.isArray(evidenceIds) ? evidenceIds : [],
    notes: String(notes || '').trim(),
  };
}

function shouldAllowPublicEnrichment(term) {
  return isPublicStandardTerm(term);
}

function shouldUseDocumentOnly(term) {
  if (!term) return true;
  return !shouldAllowPublicEnrichment(term);
}

module.exports = {
  CONFIDENCE,
  NODE_TYPES,
  EDGE_TYPES,
  EDGE_STYLES,
  BOUNDARY_TYPES,
  FLOW_SHAPES,
  EVIDENCE_SOURCES,
  PUBLIC_STANDARD_TERMS,

  normalizeText,
  compactToken,
  isPublicStandardTerm,
  isLikelyInternalTerm,
  inferEdgeTypeFromText,
  inferBoundaryTypeFromText,
  inferNodeTypeFromText,
  makeEvidenceRecord,
  shouldAllowPublicEnrichment,
  shouldUseDocumentOnly,
};