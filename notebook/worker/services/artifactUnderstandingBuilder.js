'use strict';

/**
 * BUG-1E — Artifact / Arrow Label Understanding Builder
 *
 * Borrowed ideas:
 * - Mermaid: edge labels can carry payload/protocol/format meaning
 * - OpenTelemetry semantic attributes: separate protocol, payload, format, metadata
 * - RAGFlow: every artifact claim must stay evidence-bounded
 * - LlamaIndex: enrich artifact metadata without changing document truth
 *
 * Owns:
 * - detecting public and custom artifact/protocol/format labels
 * - attaching artifact candidates to handoffs
 * - safety boundaries for custom enterprise labels
 *
 * Does NOT own:
 * - traversal selection
 * - narration wording
 * - LLM calls
 * - implementation guessing
 */

const fs = require('fs');
const path = require('path');

const {
  resolveTermMeaning,
} = require('./architectureEvidenceResolver');

const VERSION = 'artifact-understanding-v1';

const PUBLIC_ARTIFACT_HINTS = new Map([
  ['mpd', { artifactClass: 'manifest', teaching: 'MPD is commonly associated with DASH manifest metadata.' }],
  ['dash', { artifactClass: 'format', teaching: 'DASH is commonly used for adaptive media delivery.' }],
  ['hls', { artifactClass: 'format', teaching: 'HLS is commonly used for adaptive media delivery.' }],
  ['m3u8', { artifactClass: 'manifest', teaching: 'M3U8 is commonly used as HLS playlist metadata.' }],
  ['mp2', { artifactClass: 'format', teaching: 'MP2 commonly refers to MPEG-2 media or transport-related content depending on context.' }],
  ['mp4', { artifactClass: 'format', teaching: 'MP4 is commonly used as a media container format.' }],
  ['cmaf', { artifactClass: 'format', teaching: 'CMAF is commonly used as a fragmented media format for streaming workflows.' }],
  ['https', { artifactClass: 'protocol', teaching: 'HTTPS is commonly used as an encrypted web transport protocol.' }],
  ['http', { artifactClass: 'protocol', teaching: 'HTTP is commonly used as a web transport protocol.' }],
  ['tcp', { artifactClass: 'protocol', teaching: 'TCP is commonly used as a reliable transport protocol.' }],
  ['udp', { artifactClass: 'protocol', teaching: 'UDP is commonly used as a datagram transport protocol.' }],
  ['nfs', { artifactClass: 'storage_path', teaching: 'NFS is commonly used for network file-system access.' }],
  ['s3', { artifactClass: 'storage_path', teaching: 'S3 commonly refers to object-storage style access.' }],
  ['json', { artifactClass: 'format', teaching: 'JSON is commonly used as structured data format.' }],
  ['xml', { artifactClass: 'format', teaching: 'XML is commonly used as structured markup/data format.' }],
  ['yaml', { artifactClass: 'format', teaching: 'YAML is commonly used as configuration/data format.' }],
  ['jwt', { artifactClass: 'token', teaching: 'JWT is commonly used as token-shaped identity or claims metadata.' }],
]);

const ARTIFACT_CLASS_PATTERNS = [
  {
    artifactClass: 'manifest',
    pattern: /\b(manifest|playlist|mpd|m3u8)\b/i,
  },
  {
    artifactClass: 'segment',
    pattern: /\b(segment|chunk|fragment|frag|part)\b/i,
  },
  {
    artifactClass: 'payload',
    pattern: /\b(payload|body|object|asset|content|file|blob)\b/i,
  },
  {
    artifactClass: 'metadata',
    pattern: /\b(metadata|meta|descriptor|index|catalog)\b/i,
  },
  {
    artifactClass: 'config',
    pattern: /\b(config|configuration|policy|rules|settings)\b/i,
  },
  {
    artifactClass: 'token',
    pattern: /\b(token|credential|jwt|key|secret|claim)\b/i,
  },
  {
    artifactClass: 'storage_path',
    pattern: /\b(nfs|s3|bucket|volume|path|filesystem|file system|share)\b/i,
  },
  {
    artifactClass: 'protocol',
    pattern: /\b(https?|tcp|udp|grpc|dns|tls|ssh|sftp|ftp)\b/i,
  },
  {
    artifactClass: 'format',
    pattern: /\b(mp2|mp4|dash|hls|cmaf|json|xml|yaml|csv|parquet|avro|protobuf|proto)\b/i,
  },
];

const GENERIC_ARTIFACT_WORDS = new Set([
  'manifest',
  'playlist',
  'segment',
  'chunk',
  'fragment',
  'payload',
  'metadata',
  'config',
  'configuration',
  'token',
  'bundle',
  'asset',
  'object',
  'file',
  'format',
  'protocol',
  'path',
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isKnownPublicArtifact(value) {
  const lowerName = cleanText(value).toLowerCase();
  const normalized = normalizeKey(value).replace(/_/g, "");

  return (
    PUBLIC_ARTIFACT_HINTS.has(lowerName) ||
    PUBLIC_ARTIFACT_HINTS.has(normalized)
  );
}

function normalizeKey(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
}

function compactList(items = [], limit = 8) {
  return Array.from(
    new Set(items.map(cleanText).filter(Boolean))
  ).slice(0, limit);
}

function evidenceTextFromRecord(record = {}) {
  return cleanText(
    record.rawText ||
      record.text ||
      record.content ||
      record.summary ||
      record.value ||
      record.label ||
      ''
  );
}

function collectEvidenceRecords({
  architectureEvidence = {},
  documentUnderstanding = {},
  canonicalTraversalRail = {},
} = {}) {
  const records = [];

  function push(rawText, meta = {}) {
    const text = cleanText(rawText);
    if (!text) return;

    records.push({
      id:
        meta.id ||
        meta.evidenceId ||
        `${meta.source || 'artifact_evidence'}:${records.length + 1}`,
      rawText: text,
      source: meta.source || 'unknown',
      page: meta.page ?? null,
      hopId: meta.hopId || null,
      flowLaneId: meta.flowLaneId || null,
      flowLaneType: meta.flowLaneType || null,
      confidence: meta.confidence || 'medium',
    });
  }

  for (const item of asArray(architectureEvidence.publicTerms)) {
    push(item.term, {
      id: item.evidenceIds?.[0],
      source: item.source || 'public_term',
      confidence: item.confidence || 'medium',
    });
  }

  for (const item of asArray(architectureEvidence.glossaryTerms)) {
    push(`${item.term}: ${item.meaning}`, {
      id: item.evidenceIds?.[0],
      source: item.source || 'glossary',
      confidence: item.confidence || 'high',
      page: item.page ?? null,
    });
  }

  for (const item of asArray(architectureEvidence.legendItems)) {
    push(item.rawText, {
      id: item.evidenceIds?.[0],
      source: item.source || 'legend',
      confidence: item.confidence || 'medium',
      page: item.page ?? null,
    });
  }

  for (const item of asArray(architectureEvidence.evidenceRecords)) {
    push(item.rawText, {
      id: item.evidenceIds?.[0] || item.id,
      source: item.source || 'architecture_evidence_record',
      confidence: item.confidence || 'medium',
    });
  }

  for (const item of asArray(documentUnderstanding.evidence)) {
    push(evidenceTextFromRecord(item), {
      id: item.id || item.evidenceId,
      source: item.source || 'document_evidence',
      confidence: item.confidence || 'medium',
      page: item.page ?? null,
    });
  }

  for (const rel of asArray(documentUnderstanding.relationships)) {
    push(
      [
        rel.rawText,
        rel.text,
        rel.label,
        rel.edgeLabel,
        rel.description,
        rel.evidence,
        rel.from,
        rel.to,
        rel.type,
      ]
        .filter(Boolean)
        .join(' '),
      {
        id: rel.id || rel.evidenceId,
        source: 'document_relationship',
        confidence: rel.confidence || 'medium',
        page: rel.page ?? null,
      }
    );
  }

  for (const seq of asArray(documentUnderstanding.sequences)) {
    for (const step of asArray(seq.steps || seq.items)) {
      push(step.text || step.label || step.description || step.rawText, {
        id: step.id || step.evidenceId,
        source: 'sequence_step',
        confidence: step.confidence || seq.confidence || 'high',
        page: step.page ?? seq.page ?? null,
      });
    }
  }

  for (const hop of asArray(canonicalTraversalRail.hops)) {
    push(
      [
        hop.edgeLabel,
        hop.label,
        hop.evidenceText,
        hop.relationshipType,
        hop.interactionMode,
        hop.flowLaneType,
        hop.from?.name,
        hop.to?.name,
      ]
        .filter(Boolean)
        .join(' '),
      {
        id: hop.sourceRelationshipId || hop.stepId || hop.hopId,
        source: 'canonical_hop',
        hopId: hop.hopId,
        flowLaneId: hop.flowLaneId,
        flowLaneType: hop.flowLaneType,
        confidence: hop.confidence || 'medium',
      }
    );
  }

  return records;
}

function tokenizeArtifactCandidates(text = '') {
  const value = cleanText(text);
  if (!value) return [];

  const candidates = new Set();

  const tokenMatches =
    value.match(/\b[A-Za-z][A-Za-z0-9_.+#/-]{1,40}\b/g) || [];

  for (const token of tokenMatches) {
    const clean = cleanText(token);

    if (!clean || clean.length < 2 || clean.length > 40) continue;

    const normalized = clean.toLowerCase();

    if (PUBLIC_ARTIFACT_HINTS.has(normalized)) {
      candidates.add(clean);
      continue;
    }

    if (GENERIC_ARTIFACT_WORDS.has(normalized)) {
      candidates.add(clean);
      continue;
    }

    if (/[A-Z]{2,}/.test(clean) && /(?:payload|manifest|meta|config|token|bundle|segment|asset|object|format|protocol|file)$/i.test(clean)) {
      candidates.add(clean);
      continue;
    }

    if (/^[A-Z0-9]{2,12}$/.test(clean) && /[A-Z]/.test(clean)) {
      candidates.add(clean);
      continue;
    }

    if (/^[A-Za-z0-9]+(?:Payload|Manifest|Metadata|Meta|Config|Token|Bundle|Segment|Asset|Object|File|Format|Protocol)$/.test(clean)) {
      candidates.add(clean);
      continue;
    }
  }

  return Array.from(candidates);
}

function inferArtifactClass(name, evidenceTexts = []) {
  const normalized = normalizeKey(name).replace(/_/g, '');
  const lowerName = cleanText(name).toLowerCase();
  const combined = `${name} ${evidenceTexts.join(' ')}`;

  const publicHint =
    PUBLIC_ARTIFACT_HINTS.get(lowerName) ||
    PUBLIC_ARTIFACT_HINTS.get(normalized);

  if (publicHint?.artifactClass) {
    return publicHint.artifactClass;
  }

  for (const item of ARTIFACT_CLASS_PATTERNS) {
    if (item.pattern.test(combined)) {
      return item.artifactClass;
    }
  }

  return 'unknown_artifact';
}

function buildSafeIndustryTeaching(name, artifactClass, publicStandard) {
  const lowerName = cleanText(name).toLowerCase();
  const normalized = normalizeKey(name).replace(/_/g, '');
  const hint =
    PUBLIC_ARTIFACT_HINTS.get(lowerName) ||
    PUBLIC_ARTIFACT_HINTS.get(normalized);

  if (hint?.teaching) return [hint.teaching];

  if (!publicStandard) return [];

  const templates = {
    protocol:
      `${name} can be taught as a public protocol or transport label, but only generally unless the document defines its exact use.`,
    format:
      `${name} can be taught as a public data or media format label, but not as a system-specific implementation detail.`,
    manifest:
      `${name} can be taught as manifest-style metadata, but the exact fields and generation behavior require document evidence.`,
    segment:
      `${name} can be taught as a segment/chunk-style artifact, but exact packaging behavior requires document evidence.`,
    storage_path:
      `${name} can be taught as a storage/path access label, but exact mount, bucket, or filesystem behavior requires document evidence.`,
  };

  return compactList([templates[artifactClass]], 2);
}

function buildBlockedImplementationDetails(name, artifactClass) {
  const base = [
    `Do not claim how ${name} is generated, stored, cached, validated, encrypted, replicated, or expired unless the document states it.`,
    `Do not claim vendor-specific or company-specific behavior for ${name} from the label alone.`,
  ];

  if (artifactClass === 'manifest') {
    base.push(
      `Do not claim ${name} fields, manifest generation tools, packaging algorithms, or update cadence unless documented.`
    );
  }

  if (artifactClass === 'protocol') {
    base.push(
      `Do not claim ports, TLS versions, headers, auth scheme, retries, timeouts, or connection behavior for ${name} unless documented.`
    );
  }

  if (artifactClass === 'storage_path') {
    base.push(
      `Do not claim mount paths, permissions, consistency, replication, or storage topology for ${name} unless documented.`
    );
  }

  if (artifactClass === 'token') {
    base.push(
      `Do not claim token issuer, claims, expiration, signing method, or validation rules for ${name} unless documented.`
    );
  }

  return compactList(base, 6);
}

function resolveArtifact({
  artifactName,
  evidenceRecords = [],
  architectureEvidence = {},
} = {}) {
  const evidenceTexts = compactList(
    evidenceRecords.map((record) => record.rawText),
    8
  );

  const termResolution = resolveTermMeaning(
    artifactName,
    architectureEvidence
  );

  const lowerName = cleanText(artifactName).toLowerCase();
  const normalized = normalizeKey(artifactName).replace(/_/g, '');

  const publicHint =
    PUBLIC_ARTIFACT_HINTS.has(lowerName) ||
    PUBLIC_ARTIFACT_HINTS.has(normalized);

  const publicStandard =
    publicHint ||
    termResolution.publicStandard === true ||
    termResolution.allowPublicEnrichment === true;

  const artifactClass = inferArtifactClass(
    artifactName,
    evidenceTexts
  );

  const documentOnly =
    !publicStandard ||
    (!publicHint && termResolution.documentOnly === true) ||
    (!publicHint && termResolution.internalTerm === true);

  return {
    id: `artifact_${normalizeKey(artifactName)}`,
    artifactName,
    artifactClass,
    source:
      termResolution.source ||
      (publicStandard ? 'public_standard_candidate' : 'document_artifact_candidate'),

    resolved:
      termResolution.resolved === true || publicStandard,

    meaning:
    publicHint
        ? `${artifactName} is recognized as a public artifact/protocol/format label.`
        : termResolution.meaning ||
        (publicStandard
            ? `${artifactName} is recognized as a public artifact/protocol/format label.`
            : ''),

    documentTruth: evidenceTexts,

    industryTeaching: buildSafeIndustryTeaching(
      artifactName,
      artifactClass,
      publicStandard
    ),

    evidenceIds: compactList(
      evidenceRecords.map((record) => record.id),
      10
    ),

    confidence:
      termResolution.confidence ||
      (publicStandard ? 'medium' : 'low'),

    safety: {
      publicStandard,
      documentOnly,
      canUseIndustryTeaching: publicStandard,
      canInferTransformation: false,
      canInferInternalBehavior: false,
      implementationDetailsBlocked: true,
      unsupportedImplementationDetailsBlocked: true,
    },

    blockedImplementationDetails:
      buildBlockedImplementationDetails(
        artifactName,
        artifactClass
      ),

    notes: compactList([
      ...asArray(termResolution.notes),
      publicStandard
        ? 'safe_public_artifact_teaching_allowed'
        : 'custom_or_unknown_artifact_document_only',
    ]),
  };
}

function buildArtifactEvidenceIndex(records = []) {
  const index = new Map();

  for (const record of records) {
    const candidates = tokenizeArtifactCandidates(record.rawText);

    for (const artifactName of candidates) {
      const key = normalizeKey(artifactName);

      if (!index.has(key)) {
        index.set(key, {
          artifactName,
          evidenceRecords: [],
        });
      }

      index.get(key).evidenceRecords.push(record);
    }
  }

  return index;
}

function buildHandoffArtifacts({
  artifacts = [],
  canonicalTraversalRail = {},
} = {}) {
  const out = [];

  for (const hop of asArray(canonicalTraversalRail.hops)) {
    const hopText = cleanText(
      [
        hop.edgeLabel,
        hop.label,
        hop.evidenceText,
        hop.relationshipType,
        hop.interactionMode,
        hop.flowLaneType,
        hop.stepText,
        hop.sourceEvidenceText,
        hop.from?.name,
        hop.to?.name,
      ]
        .filter(Boolean)
        .join(' ')
    );

    const candidates = artifacts.filter((artifact) => {
        const artifactName = cleanText(artifact.artifactName).toLowerCase();
        const from = cleanText(hop.from?.name).toLowerCase();
        const to = cleanText(hop.to?.name).toLowerCase();

        return asArray(artifact.documentTruth).some((truth) => {
        const text = cleanText(truth).toLowerCase();
        const wordCount = text.split(/\s+/).filter(Boolean).length;

        if (wordCount > 18) return false;

        const looksLikeArrowOrStep =
            text.includes('↓') ||
            /^\d+\./.test(text) ||
            text.includes('->') ||
            text.includes('→');

        if (!looksLikeArrowOrStep) return false;

        const mentionsArtifact = text.includes(artifactName);

        const mentionsHop =
            (from && text.includes(from)) ||
            (to && text.includes(to));

        return mentionsArtifact && mentionsHop;
        });
        });

    const uniqueCandidates = Array.from(
      new Map(
        candidates.map((artifact) => [
          normalizeKey(artifact.artifactName),
          artifact,
        ])
      ).values()
    );

    if (!uniqueCandidates.length) continue;

    out.push({
      hopId: hop.hopId,
      subjectName: `${hop.from?.name || 'Upstream'} → ${hop.to?.name || 'Downstream'}`,
      artifacts: uniqueCandidates.map((artifact) => ({
        artifactName: artifact.artifactName,
        artifactClass: artifact.artifactClass,
        publicStandard: artifact.safety.publicStandard,
        documentOnly: artifact.safety.documentOnly,
        meaning: artifact.meaning || null,
      })),
      documentTruth: compactList(
        uniqueCandidates.flatMap((artifact) =>
          asArray(artifact.documentTruth)
        ),
        6
      ),
      safety: {
        canInferTransformation: false,
        implementationDetailsBlocked: true,
      },
    });
  }

  return out;
}

function buildArtifactUnderstanding({
  architectureEvidence = {},
  documentUnderstanding = {},
  canonicalTraversalRail = {},
  outputDir = null,
} = {}) {
  const componentNameKeys = new Set();

  for (const entity of asArray(documentUnderstanding.entities)) {
    const name = cleanText(entity.name || entity.label || entity.text);
    if (name) componentNameKeys.add(normalizeKey(name));
  }

  for (const hop of asArray(canonicalTraversalRail.hops)) {
    if (hop.from?.name) componentNameKeys.add(normalizeKey(hop.from.name));
    if (hop.to?.name) componentNameKeys.add(normalizeKey(hop.to.name));
  }

  const evidenceRecords = collectEvidenceRecords({
    architectureEvidence,
    documentUnderstanding,
    canonicalTraversalRail,
  });

  const artifactEvidenceIndex =
    buildArtifactEvidenceIndex(evidenceRecords);

  const artifacts = Array.from(artifactEvidenceIndex.values())
    .filter((entry) => {
        const key = normalizeKey(entry.artifactName);

        if (isKnownPublicArtifact(entry.artifactName)) {
        return true;
        }

        return !componentNameKeys.has(key);
    })
    .map((entry) =>
        resolveArtifact({
        artifactName: entry.artifactName,
        evidenceRecords: entry.evidenceRecords,
        architectureEvidence,
        })
    )
    .sort((a, b) => {
      if (a.safety.publicStandard !== b.safety.publicStandard) {
        return a.safety.publicStandard ? -1 : 1;
      }

      return a.artifactName.localeCompare(b.artifactName);
    });

  const handoffArtifacts = buildHandoffArtifacts({
    artifacts,
    canonicalTraversalRail,
  });

  const payload = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    source: 'artifactUnderstandingBuilder',
    purpose:
      'Detect and safely classify public and custom artifact/protocol/format labels from document evidence and canonical handoffs.',
    borrowedIdeas: [
      'Mermaid edge labels as relationship metadata',
      'OpenTelemetry-style protocol/payload/format attributes',
      'RAGFlow evidence-bounded artifact claims',
      'LlamaIndex metadata enrichment without overriding source truth',
    ],
    strategy: {
      publicArtifactPolicy:
        'public labels may receive safe general teaching',
      customArtifactPolicy:
        'custom or unknown enterprise labels remain document-only unless glossary/evidence defines them',
      transformationPolicy:
        'format transitions are not inferred from labels alone',
      implementationDetailPolicy:
        'generation, storage, caching, validation, encryption, replication, and expiry behavior require explicit document evidence',
    },
    artifacts,
    handoffArtifacts,
    stats: {
      artifactCount: artifacts.length,
      publicStandardCount: artifacts.filter(
        (x) => x.safety.publicStandard
      ).length,
      documentOnlyCount: artifacts.filter(
        (x) => x.safety.documentOnly
      ).length,
      customArtifactCount: artifacts.filter(
        (x) => !x.safety.publicStandard
      ).length,
      handoffArtifactCount: handoffArtifacts.length,
      classBreakdown: artifacts.reduce((acc, artifact) => {
        acc[artifact.artifactClass] =
          (acc[artifact.artifactClass] || 0) + 1;
        return acc;
      }, {}),
    },
    inputs: {
      architectureEvidenceVersion: architectureEvidence.version || null,
      documentUnderstandingVersion: documentUnderstanding.version || null,
      canonicalTraversalRailVersion: canonicalTraversalRail.version || null,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, 'artifact-understanding.json'),
      JSON.stringify(payload, null, 2),
      'utf8'
    );
  }

  return payload;
}

module.exports = {
  VERSION,
  buildArtifactUnderstanding,
  collectEvidenceRecords,
  tokenizeArtifactCandidates,
  inferArtifactClass,
  resolveArtifact,
  buildHandoffArtifacts,
};