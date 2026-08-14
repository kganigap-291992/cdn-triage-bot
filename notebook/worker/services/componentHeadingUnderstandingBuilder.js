'use strict';

/**
 * componentHeadingUnderstandingBuilder.js
 *
 * BUG-1A — Deterministic Heading Role Understanding
 *
 * Goal:
 * - classify document headings by structural / architecture role
 * - preserve heading -> owned-content relationships
 * - promote only component_identity headings into canonical components
 * - keep runtime instances, operations, document metadata and
 *   containers separate
 *
 * Borrowed ideas:
 * - Unstructured:
 *     title starts / owns a section
 *
 * - LlamaIndex:
 *     parent -> child hierarchy
 *     ancestor traversal
 *
 * - Existing Notebook:
 *     headingKind
 *     architectureContainer
 *     sectionDepth
 *     parentSectionId
 *     owned elements
 *     evidence provenance
 *
 * Important:
 * - deterministic only
 * - no LLM
 * - no embeddings
 * - no fuzzy identity matching
 * - no graph mutation
 * - no traversal mutation
 */

const fs = require('fs');
const path = require('path');

const BUILDER_VERSION =
  'component-heading-understanding-v3-ownership-aware-role-resolution';

const HEADING_ROLES = Object.freeze({
  COMPONENT_IDENTITY:
    'component_identity',

  RUNTIME_INSTANCE:
    'runtime_instance',

  OPERATION_OR_ANNOTATION:
    'operation_or_annotation',

  DEPLOYMENT_BOUNDARY:
    'deployment_boundary',

  JOURNEY_HEADING:
    'journey_heading',

  DOCUMENT_METADATA:
    'document_metadata',

  STRUCTURAL_CONTAINER:
    'structural_container',

  UNKNOWN:
    'unknown',
});

const ARCHITECTURE_OBJECT_PATTERN =
  /\b(api|service|application|app|worker|processor|indexer|cache|database|db|store|storage|vault|queue|broker|gateway|router|proxy|edge|origin|cluster|hub|console|client|provider|scheduler|orchestrator|engine|server|repository|telemetry|authentication|identity)\b/i;

const RESPONSIBILITY_OR_COMPONENT_PATTERN =
  /\b(service|gateway|api|store|storage|cache|queue|bus|broker|worker|processor|indexer|cluster|platform|proxy|routing|router|console|client|provider|repository|database|db|telemetry|authentication|identity|ingest|intake|serves?|reads?|writes?|routes?|publishes?|consumes?|validates?|normalizes?|enriches?|persists?|stores?|indexes?|caches?|authenticates?|distributes?)\b/i;

const RUNTIME_CONTENT_PATTERN =
  /\b(zone[- ]local runtime|deployment[- ]local|runtime instance|runtime workload|replica instance|pod instance|instance in|runs? in (?:zone|region|az)|availability zone|local replica)\b/i;

const RUNTIME_NAME_PATTERN =
  /\b(worker|api|service|indexer|cache|replica|instance|pod|node|process|processor)\s+[a-z]*\d+\b/i;

const DEPLOYMENT_CONTEXT_PATTERN =
  /\b(deployment topology|deployment|availability zone|availability-zone|\baz\b|region|data center|datacenter|site|cluster topology)\b/i;

const DEPLOYMENT_BOUNDARY_PATTERN =
  /^(availability\s+zone|zone|region|az|data\s*center|datacenter|site|cluster)\b/i;

const JOURNEY_HEADING_PATTERN =
  /^(journey\s*\d+|journey\b|flow\b|request flow\b|data flow\b|system journey\b)/i;

const OPERATION_PREFIX_PATTERN =
  /^(get|post|put|patch|delete|head|options|connect|trace|http|https|sftp|ftp|grpc|graphql|sql|select|insert|update|publish|consume|route|replay|validate|validation|read|write|fetch|lookup|cache lookup|token validation)\b/i;

const OPERATION_OR_ANNOTATION_PATTERN =
  /\b(request|response|payload|command|lookup|validation|canonical|query|indexing|replay|accepted|failed records?|program data|schedule data|token validation|provider rules?|publish schedule|route request)\b/i;

const DOCUMENT_META_KINDS =
  new Set([
    'validation',
    'documentation',
    'legend',
    'architecture',
  ]);

const DOCUMENT_META_PATTERN =
  /^(overview|introduction|purpose|background|summary|recap|notes?|appendix|recommendations?|regression(?:\s+fixture|\s+objective)?|expected evidence|safety expectations?|synthetic only|document scope|system scope|design notes?|architecture overview|deployment overview|runtime overview|api overview)$/i;

function asArray(value) {
  return Array.isArray(value)
    ? value
    : [];
}

function safeString(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeLower(value) {
  return safeString(value)
    .toLowerCase();
}

function slugify(value) {
  return safeLower(value)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
}

function uniq(values = []) {
  return Array.from(
    new Set(
      asArray(values)
        .filter(
          (value) =>
            value !== null &&
            value !== undefined &&
            value !== ''
        )
    )
  );
}

function escapeRegExp(value) {
  return String(value || '')
    .replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    );
}

/*
 * Preserve the existing Notebook structural firewall.
 */
function isArchitectureContainer(
  section = {}
) {
  return (
    section.architectureContainer ===
      true ||

    section.structuralRole ===
      'architecture_container'
  );
}

/*
 * Document / organizational headings.
 *
 * Heading text alone is not sufficient, so we also
 * consume headingKind produced upstream.
 */
function isDocumentMetaHeading({
  section = {},
  headingText = '',
} = {}) {
  const text =
    safeString(
      headingText
    );

  const headingKind =
    safeLower(
      section.headingKind
    );

  if (!text) {
    return true;
  }

  if (
    DOCUMENT_META_KINDS.has(
      headingKind
    )
  ) {
    return true;
  }

  return DOCUMENT_META_PATTERN.test(
    text
  );
}

function headingHasArchitectureObjectSignal(
  title = ''
) {
  return ARCHITECTURE_OBJECT_PATTERN.test(
    safeString(title)
  );
}

function isComponentCollectionContext(
  section = {}
) {
  const title =
    safeString(
      section.title ||
      section.sourceTitle
    );

  const headingKind =
    safeLower(
      section.headingKind
    );

  if (
    headingKind ===
      'component_definitions'
  ) {
    return true;
  }

  return Boolean(
    /^(component|service|system|application)s?\s+definitions?$/i.test(
      title
    ) ||

    /^(components|services|systems|applications)$/i.test(
      title
    )
  );
}

function buildSectionIndex(
  documentStructure = {}
) {
  return new Map(
    asArray(
      documentStructure.sections
    )
      .filter(
        (section) =>
          safeString(section.id)
      )
      .map(
        (section) => [
          section.id,
          section,
        ]
      )
  );
}

/*
 * LlamaIndex-inspired ancestor walking.
 *
 * Existing Notebook parentSectionId remains
 * the source of truth.
 */
function collectAncestorSections({
  section = {},
  sectionIndex = new Map(),
  maxDepth = 12,
} = {}) {
  const ancestors = [];
  const seen =
    new Set();

  let parentId =
    section.parentSectionId ||
    null;

  while (
    parentId &&
    ancestors.length < maxDepth &&
    !seen.has(parentId)
  ) {
    seen.add(
      parentId
    );

    const parent =
      sectionIndex.get(
        parentId
      );

    if (!parent) {
      break;
    }

    ancestors.push(
      parent
    );

    parentId =
      parent.parentSectionId ||
      null;
  }

  return ancestors;
}

function deriveHeadingLevel(
  section = {}
) {
  const rawText =
    safeString(
      section
        ?.headingElement
        ?.rawText
    );

  const markdownMatch =
    rawText.match(
      /^(#{1,6})\s+/
    );

  if (markdownMatch) {
    return markdownMatch[1].length;
  }

  return null;
}

function collectOwnedContent(
  section = {}
) {
  return asArray(
    section.elements
  )
    .map(
      (element, index) => {
        const text =
          safeString(
            element.text
          );

        if (!text) {
          return null;
        }

        const orderWithinSection =
          element
            .orderWithinSection ??
          index + 1;

        return {
          ownedContentId:
            `${section.id}_element_${orderWithinSection}`,

          sectionId:
            section.id ||
            null,

          parentSectionId:
            section.parentSectionId ||
            null,

          type:
            element.type ||
            'unknown',

          text,

          page:
            element.page ||
            section.page ||
            null,

          orderWithinSection,
        };
      }
    )
    .filter(Boolean);
}

function hasMeaningfulOwnedContent(
  ownedContent = []
) {
  return asArray(
    ownedContent
  ).some(
    (item) => {
      const text =
        safeString(
          item.text
        );

      if (!text) {
        return false;
      }

      return (
        item.type ===
          'narrative_text' ||

        item.type ===
          'list_item' ||

        item.type ===
          'table_row' ||

        item.type ===
          'diagram_caption'
      );
    }
  );
}

/*
 * Determine whether content owned by the heading
 * describes an architecture object or responsibility.
 *
 * Unlike general meaningfulOwnedContent, this is
 * stronger semantic-shape evidence.
 *
 * No LLM is used. This is deterministic vocabulary
 * and document ownership.
 */
function collectOwnedArchitectureDescriptions(
  ownedContent = []
) {
  return asArray(
    ownedContent
  )
    .filter(
      (item) => {
        const text =
          safeString(
            item.text
          );

        if (!text) {
          return false;
        }

        return (
          RESPONSIBILITY_OR_COMPONENT_PATTERN
            .test(
              text
            )
        );
      }
    );
}


function collectSectionEvidence({
  section = {},
  evidence = [],
} = {}) {
  return asArray(
    evidence
  )
    .filter(
      (item) =>
        item.sectionId ===
        section.id
    );
}

function collectExternalHeadingReferences({
  headingText = '',
  sectionId = null,
  evidence = [],
} = {}) {
  const text =
    safeString(
      headingText
    );

  if (
    !text ||
    text.length < 2
  ) {
    return [];
  }

  const pattern =
    new RegExp(
      `(^|[^a-z0-9])${escapeRegExp(
        text
      )}(?=$|[^a-z0-9])`,
      'i'
    );

  return asArray(
    evidence
  )
    .filter(
      (item) => {
        const evidenceText =
          safeString(
            item.text
          );

        if (!evidenceText) {
          return false;
        }

        /*
         * Same owned section is not external
         * corroboration.
         */
        if (
          sectionId &&
          item.sectionId ===
            sectionId
        ) {
          return false;
        }

        return pattern.test(
          evidenceText
        );
      }
    );
}

/*
 * Find external evidence that explicitly describes
 * the heading itself as an architecture object.
 *
 * The evidence must:
 *
 * 1. begin with the heading identity
 * 2. come from outside the heading's own section
 * 3. contain architecture responsibility/object language
 *
 * This deliberately does NOT require a section named
 * "Component Definitions".
 *
 * Examples:
 *
 * Atlas Validation and canonical normalization service...
 *
 * Super8 Shared reverse-proxy and request-routing layer...
 *
 * Nimbus Canonical metadata store...
 *
 * This is resilient to PDF / Confluence document layout.
 */
function collectSubjectAnchoredArchitectureReferences({
  headingText = '',
  sectionId = null,
  evidence = [],
} = {}) {
  const text =
    safeString(
      headingText
    );

  if (!text) {
    return [];
  }

  const startPattern =
    new RegExp(
      `^${escapeRegExp(
        text
      )}(?:\\b|\\s|[-–—:])`,
      'i'
    );

  return asArray(
    evidence
  )
    .filter(
      (item) => {
        const evidenceText =
          safeString(
            item.text
          );

        if (!evidenceText) {
          return false;
        }

        /*
         * The heading's own section is already
         * represented by ownedContent.
         *
         * Here we want independent corroboration.
         */
        if (
          sectionId &&
          item.sectionId ===
            sectionId
        ) {
          return false;
        }

        /*
         * The evidence must explicitly begin with
         * the candidate identity.
         */
        if (
          !startPattern.test(
            evidenceText
          )
        ) {
          return false;
        }

        /*
         * Merely repeating the heading is not enough.
         *
         * The remaining text must contain architecture
         * object / responsibility language.
         */
        return (
          RESPONSIBILITY_OR_COMPONENT_PATTERN
            .test(
              evidenceText
            )
        );
      }
    );
}

function hasDeploymentContext({
  section = {},
  ancestors = [],
} = {}) {
  const candidates = [
    section,
    ...asArray(
      ancestors
    ),
  ];

  return candidates.some(
    (candidate) => {
      const headingKind =
        safeLower(
          candidate
            ?.headingKind
        );

      const title =
        safeString(
          candidate?.title ||
          candidate?.sourceTitle
        );

      return (
        headingKind ===
          'deployment' ||

        DEPLOYMENT_CONTEXT_PATTERN
          .test(
            title
          )
      );
    }
  );
}

/*
 * Recursive component-definition / component-list
 * context.
 *
 * Supports:
 *
 * Component Definitions
 *   Backend
 *     Guide API
 *
 * not only direct parent matches.
 */
function hasComponentCollectionContext(
  ancestors = []
) {
  return asArray(
    ancestors
  )
    .some(
      (ancestor) =>
        isComponentCollectionContext(
          ancestor
        )
    );
}

function hasRuntimeInstanceSignal({
  headingText = '',
  ownedContent = [],
  deploymentContext = false,
} = {}) {
  const ownedText =
    asArray(
      ownedContent
    )
      .map(
        (item) =>
          safeString(
            item.text
          )
      )
      .join(' ');

  const runtimeContentSignal =
    RUNTIME_CONTENT_PATTERN
      .test(
        ownedText
      );

  const runtimeNameSignal =
    RUNTIME_NAME_PATTERN
      .test(
        safeString(
          headingText
        )
      );

  const numberedSuffixSignal =
    /\b\d+\s*$/i.test(
      safeString(
        headingText
      )
    );

  return {
    runtimeContentSignal,

    runtimeNameSignal,

    numberedSuffixSignal,

    runtimeInstanceSignal:
      runtimeContentSignal ||

      (
        deploymentContext &&
        runtimeNameSignal &&
        numberedSuffixSignal
      ),
  };
}

function hasOperationOrAnnotationSignal({
  headingText = '',
  architectureObjectSignal = false,
} = {}) {
  const text =
    safeString(
      headingText
    );

  if (!text) {
    return false;
  }

  /*
   * Strong operation forms always win.
   *
   * GET guide
   * POST order
   * publish schedule
   * cache lookup
   */
  if (
    OPERATION_PREFIX_PATTERN.test(
      text
    )
  ) {
    return true;
  }

  /*
   * Description / edge / operation phrases that
   * do not themselves look like architecture objects.
   */
  if (
    !architectureObjectSignal &&
    OPERATION_OR_ANNOTATION_PATTERN
      .test(
        text
      )
  ) {
    return true;
  }

  return false;
}

function hasDeploymentBoundarySignal({
  section = {},
  headingText = '',
} = {}) {
  const headingKind =
    safeLower(
      section.headingKind
    );

  return (
    headingKind ===
      'deployment' &&

    DEPLOYMENT_BOUNDARY_PATTERN
      .test(
        safeString(
          headingText
        )
      )
  );
}

function hasJourneyHeadingSignal({
  section = {},
  headingText = '',
} = {}) {
  const headingKind =
    safeLower(
      section.headingKind
    );

  return (
    headingKind ===
      'journey' ||

    JOURNEY_HEADING_PATTERN
      .test(
        safeString(
          headingText
        )
      )
  );
}

/*
 * Deterministic role resolver.
 *
 * IMPORTANT:
 *
 * External references are supporting evidence only.
 * They cannot create component identity by themselves.
 */
function resolveHeadingRole({
  headingText = '',

  meaningfulOwnedContent = false,

  architectureContainer = false,

  documentMetaSignal = false,

  deploymentBoundarySignal = false,

  journeyHeadingSignal = false,

  runtimeInstanceSignal = false,

  operationOrAnnotationSignal = false,

  componentCollectionBacked = false,

  architectureObjectSignal = false,

  externalReferenceCount = 0,

  ownedArchitectureDescriptionCount = 0,

  subjectAnchoredArchitectureReferenceCount = 0,  

} = {}) {
  const basis = [];
  const rejectionReasons = [];

  if (!headingText) {
    return {
      role:
        HEADING_ROLES.UNKNOWN,

      confidence:
        0,

      basis,

      rejectionReasons: [
        'missing_heading_text',
      ],
    };
  }

  /*
   * Strong structural roles win before
   * component scoring.
   */
  if (architectureContainer) {
    return {
      role:
        HEADING_ROLES
          .STRUCTURAL_CONTAINER,

      confidence:
        1,

      basis: [
        'architecture_container_heading',
      ],

      rejectionReasons,
    };
  }

  if (deploymentBoundarySignal) {
    return {
      role:
        HEADING_ROLES
          .DEPLOYMENT_BOUNDARY,

      confidence:
        0.98,

      basis: [
        'deployment_boundary_context',
      ],

      rejectionReasons,
    };
  }

  if (journeyHeadingSignal) {
    return {
      role:
        HEADING_ROLES
          .JOURNEY_HEADING,

      confidence:
        0.98,

      basis: [
        'journey_heading_context',
      ],

      rejectionReasons,
    };
  }

  if (runtimeInstanceSignal) {
    return {
      role:
        HEADING_ROLES
          .RUNTIME_INSTANCE,

      confidence:
        0.97,

      basis: [
        'deployment_runtime_instance_evidence',
      ],

      rejectionReasons,
    };
  }

  if (documentMetaSignal) {
    return {
      role:
        HEADING_ROLES
          .DOCUMENT_METADATA,

      confidence:
        0.96,

      basis: [
        'document_metadata_heading',
      ],

      rejectionReasons,
    };
  }

  if (operationOrAnnotationSignal) {
    return {
      role:
        HEADING_ROLES
          .OPERATION_OR_ANNOTATION,

      confidence:
        0.9,

      basis: [
        'operation_or_annotation_signal',
      ],

      rejectionReasons,
    };
  }

  if (meaningfulOwnedContent) {
    basis.push(
        'owns_descriptive_content'
    );
    }

  if (componentCollectionBacked) {
    basis.push(
      'component_collection_ancestor'
    );
  }

  if (architectureObjectSignal) {
    basis.push(
      'architecture_object_name_signal'
    );
  }

  if (
    ownedArchitectureDescriptionCount >
    0
    ) {
    basis.push(
        'owns_architecture_description'
    );
    }

    if (
    subjectAnchoredArchitectureReferenceCount >
    0
    ) {
    basis.push(
        'subject_anchored_architecture_reference'
    );
    }

  if (
    externalReferenceCount >
    0
  ) {
    basis.push(
      'referenced_outside_owned_section'
    );
  }

  /*
   * Component scoring.
   *
   * External references strengthen classification,
   * but are never sufficient alone.
   */
  let componentScore =
    0;

    /*
    * Generic owned content is weak evidence.
    */
    if (meaningfulOwnedContent) {
    componentScore += 1;
    }

    /*
    * Explicit component grouping is strong structural
    * evidence when available, but is not required.
    */
    if (componentCollectionBacked) {
    componentScore += 4;
    }

    /*
    * Owned architecture description is strong because
    * structural ownership already ties the description
    * to this heading.
    */
    if (
    ownedArchitectureDescriptionCount >
    0
    ) {
    componentScore += 4;
    }

    /*
    * A separate document statement explicitly beginning
    * with this heading and describing architecture
    * responsibility is also strong evidence.
    */
    if (
    subjectAnchoredArchitectureReferenceCount >
    0
    ) {
    componentScore += 4;
    }

    /*
    * Architecture noun shape is useful supporting
    * evidence but not mandatory for internal names.
    */
    if (architectureObjectSignal) {
    componentScore += 3;
    }

    /*
    * Repeated references prove importance / existence,
    * but never create identity by themselves.
    */
    if (
    externalReferenceCount >=
    2
    ) {
    componentScore += 2;
    } else if (
    externalReferenceCount ===
    1
    ) {
    componentScore += 0.5;
    }

  /*
   * Minimum deterministic component evidence.
   */
  const hasStrongComponentEvidence =
    componentCollectionBacked ||

    ownedArchitectureDescriptionCount >
        0 ||

    subjectAnchoredArchitectureReferenceCount >
        0;

if (
  (
    meaningfulOwnedContent ||
    hasStrongComponentEvidence
  ) &&
  componentScore >= 5
) {
    basis.unshift(
      'non_container_heading'
    );

    return {
      role:
        HEADING_ROLES
          .COMPONENT_IDENTITY,

      confidence:
        Math.min(
          0.99,

          0.55 +
          componentScore * 0.055
        ),

      basis:
        uniq(
          basis
        ),

      rejectionReasons,
    };
  }


  if (!meaningfulOwnedContent) {
    rejectionReasons.push(
        'no_meaningful_owned_content'
    );
    }
  /*
   * Unknown is intentionally valid.
   *
   * Do not force weak / conflicting headings
   * into component identity.
   */
  rejectionReasons.push(
    'insufficient_component_identity_evidence'
  );

  return {
    role:
      HEADING_ROLES.UNKNOWN,

    confidence:
      Math.min(
        0.79,

        0.25 +
        componentScore * 0.06
      ),

    basis:
      uniq(
        basis
      ),

    rejectionReasons:
      uniq(
        rejectionReasons
      ),
  };
}

function confidenceLabel(
  value = 0
) {
  if (value >= 0.85) {
    return 'high';
  }

  if (value >= 0.6) {
    return 'medium';
  }

  return 'low';
}

function classifyHeading({
  section = {},
  sectionIndex = new Map(),
  evidence = [],
} = {}) {
  const headingText =
    safeString(
      section.title ||
      section.sourceTitle
    );

  const ancestors =
    collectAncestorSections({
      section,
      sectionIndex,
    });

  const parentSection =
    ancestors[0] ||
    null;

  const ownedContent =
    collectOwnedContent(
      section
    );

  const meaningfulOwnedContent =
    hasMeaningfulOwnedContent(
      ownedContent
    );

  const architectureContainer =
    isArchitectureContainer(
      section
    );

  const componentCollectionBacked =
    hasComponentCollectionContext(
      ancestors
    );

  const architectureObjectSignal =
    headingHasArchitectureObjectSignal(
      headingText
    );

  const externalReferences =
    collectExternalHeadingReferences({
      headingText,

      sectionId:
        section.id ||
        null,

      evidence,
    });

  const ownedArchitectureDescriptions =
    collectOwnedArchitectureDescriptions(
        ownedContent
    );

    const subjectAnchoredArchitectureReferences =
    collectSubjectAnchoredArchitectureReferences({
        headingText,

        sectionId:
        section.id ||
        null,

        evidence,
    });

  const deploymentContext =
    hasDeploymentContext({
      section,
      ancestors,
    });

  const runtimeSignals =
    hasRuntimeInstanceSignal({
      headingText,
      ownedContent,
      deploymentContext,
    });

  const documentMetaSignal =
    isDocumentMetaHeading({
      section,
      headingText,
    });

  const deploymentBoundarySignal =
    hasDeploymentBoundarySignal({
      section,
      headingText,
    });

  const journeyHeadingSignal =
    hasJourneyHeadingSignal({
      section,
      headingText,
    });

  const operationOrAnnotationSignal =
    hasOperationOrAnnotationSignal({
        headingText,
        architectureObjectSignal,
    });

  const resolution =
    resolveHeadingRole({
      headingText,

      meaningfulOwnedContent,

      architectureContainer,

      documentMetaSignal,

      deploymentBoundarySignal,

      journeyHeadingSignal,

      runtimeInstanceSignal:
        runtimeSignals
          .runtimeInstanceSignal,

      operationOrAnnotationSignal,

      componentCollectionBacked,

      architectureObjectSignal,

      externalReferenceCount:
        externalReferences.length,

      ownedArchitectureDescriptionCount:
        ownedArchitectureDescriptions.length,

      subjectAnchoredArchitectureReferenceCount:
        subjectAnchoredArchitectureReferences.length,
    });

  const sectionEvidence =
    collectSectionEvidence({
      section,
      evidence,
    });

  const componentBearingHeading =
    resolution.role ===
    HEADING_ROLES.COMPONENT_IDENTITY;

  return {
    headingId:
      section.id ||
      `heading_${slugify(
        headingText
      )}`,

    headingText,

    headingLevel:
      deriveHeadingLevel(
        section
      ),

    headingRole:
      resolution.role,

    componentBearingHeading,

    parentSectionId:
      section.parentSectionId ||
      null,

    parentSectionTitle:
      parentSection
        ? safeString(
            parentSection.title
          )
        : null,

    /*
     * New: retain full hierarchy context.
     */
    ancestorSectionIds:
      ancestors
        .map(
          (ancestor) =>
            ancestor.id
        )
        .filter(Boolean),

    ancestorSectionTitles:
      ancestors
        .map(
          (ancestor) =>
            safeString(
              ancestor.title ||
              ancestor.sourceTitle
            )
        )
        .filter(Boolean),

    sectionOrder:
      section.sectionOrder ??
      null,

    sectionDepth:
      section.sectionDepth ??
      null,

    page:
      section.page ||
      null,

    headingKind:
      section.headingKind ||
      null,

    architectureContainer:
      section.architectureContainer ===
      true,

    /*
     * Deterministic classification signals.
     */
    componentCollectionBacked,

    architectureObjectSignal,

    deploymentContext,

    runtimeContentSignal:
      runtimeSignals
        .runtimeContentSignal,

    runtimeNameSignal:
      runtimeSignals
        .runtimeNameSignal,

    numberedSuffixSignal:
      runtimeSignals
        .numberedSuffixSignal,

    operationOrAnnotationSignal,

    documentMetaSignal,

    externalReferenceCount:
      externalReferences.length,

    externalReferenceEvidenceIds:
      uniq(
        externalReferences.map(
          (item) =>
            item.id
        )
      ),

    ownedArchitectureDescriptionCount:
        ownedArchitectureDescriptions
            .length,

        ownedArchitectureDescriptionIds:
        uniq(
            ownedArchitectureDescriptions.map(
            (item) =>
                item.ownedContentId
            )
        ),

        subjectAnchoredArchitectureReferenceCount:
        subjectAnchoredArchitectureReferences
            .length,

        subjectAnchoredArchitectureEvidenceIds:
        uniq(
            subjectAnchoredArchitectureReferences
            .map(
                (item) =>
                item.id
            )
        ),

    ownedContentCount:
      ownedContent.length,

    ownedContent,

    ownedContentEvidenceIds:
      uniq(
        sectionEvidence.map(
          (item) =>
            item.id
        )
      ),

    evidenceIds:
        uniq([
            ...sectionEvidence.map(
            (item) =>
                item.id
            ),

            ...externalReferences.map(
            (item) =>
                item.id
            ),

            ...subjectAnchoredArchitectureReferences
            .map(
                (item) =>
                item.id
            ),
        ]),

    confidence:
      confidenceLabel(
        resolution.confidence
      ),

    confidenceScore:
      Number(
        resolution.confidence
          .toFixed(2)
      ),

    basis:
      uniq(
        resolution.basis
      ),

    rejectionReasons:
      uniq(
        resolution
          .rejectionReasons
      ),

    source:
      'componentHeadingUnderstandingBuilder',
  };
}

function buildHealth({
  headings = [],
} = {}) {
  const componentHeadings =
    asArray(
      headings
    )
      .filter(
        (item) =>
          item.headingRole ===
          HEADING_ROLES
            .COMPONENT_IDENTITY
      );

  const invalidComponentHeadings =
    componentHeadings
        .filter(
        (item) => {
            if (
            !safeString(
                item.headingId
            ) ||

            !safeString(
                item.headingText
            ) ||

            item.architectureContainer ===
                true
            ) {
            return true;
            }

            /*
            * A component must have at least one strong
            * identity-supporting evidence mode.
            *
            * Direct owned content is not mandatory because
            * PDF / Confluence extraction may separate the
            * heading from its descriptive content.
            */
            const hasStrongEvidence =
            item.ownedArchitectureDescriptionCount >
                0 ||

            item
                .subjectAnchoredArchitectureReferenceCount >
                0 ||

            item.componentCollectionBacked ===
                true ||

            (
                item.architectureObjectSignal ===
                true &&

                item.externalReferenceCount >
                0
            );

            return !hasStrongEvidence;
        }
        );

  const duplicateHeadingIds =
    componentHeadings
      .map(
        (item) =>
          item.headingId
      )
      .filter(
        (
          id,
          index,
          ids
        ) =>
          id &&
          ids.indexOf(id) !==
            index
      );

  /*
   * Explicitly ensure runtime instances never
   * leak into component headings.
   */
  const runtimeInstanceLeaks =
    componentHeadings
      .filter(
        (item) =>
          item.runtimeContentSignal ===
            true ||

          (
            item.deploymentContext ===
              true &&

            item.runtimeNameSignal ===
              true &&

            item.numberedSuffixSignal ===
              true
          )
      );

  const violations = [
    ...invalidComponentHeadings.map(
      (item) => ({
        type:
          'invalid_component_bearing_heading',

        severity:
          'high',

        headingId:
          item.headingId ||
          null,

        headingText:
          item.headingText ||
          null,
      })
    ),

    ...duplicateHeadingIds.map(
      (headingId) => ({
        type:
          'duplicate_component_heading_id',

        severity:
          'high',

        headingId,
      })
    ),

    ...runtimeInstanceLeaks.map(
      (item) => ({
        type:
          'runtime_instance_promoted_as_component_heading',

        severity:
          'high',

        headingId:
          item.headingId,

        headingText:
          item.headingText,
      })
    ),
  ];

  return {
    version:
      'component-heading-understanding-health-v3',

    valid:
      violations.length ===
      0,

    violationCount:
      violations.length,

    componentBearingHeadingCount:
      componentHeadings.length,

    rejectedHeadingCount:
      asArray(
        headings
      ).length -
      componentHeadings.length,

    architectureContainerLeakCount:
      componentHeadings
        .filter(
          (item) =>
            item.architectureContainer ===
            true
        )
        .length,

    runtimeInstanceLeakCount:
      runtimeInstanceLeaks.length,

    duplicateHeadingIdCount:
      duplicateHeadingIds.length,

    unknownHeadingCount:
      asArray(
        headings
      )
        .filter(
          (item) =>
            item.headingRole ===
            HEADING_ROLES.UNKNOWN
        )
        .length,

    traversalChanged:
      false,

    graphChanged:
      false,

    violations,
  };
}

function countByRole(
  headings = []
) {
  const counts = {};

  asArray(
    headings
  )
    .forEach(
      (heading) => {
        const role =
          heading.headingRole ||
          HEADING_ROLES.UNKNOWN;

        counts[role] =
          (counts[role] || 0) +
          1;
      }
    );

  return counts;
}

function buildComponentHeadingUnderstanding({
  documentStructure = {},
  evidence = [],
  outputDir = null,
} = {}) {
  const sections =
    asArray(
      documentStructure.sections
    );

  const sectionIndex =
    buildSectionIndex(
      documentStructure
    );

  const headings =
    sections
      .map(
        (section) =>
          classifyHeading({
            section,
            sectionIndex,
            evidence,
          })
      )
      .filter(
        (item) =>
          safeString(
            item.headingText
          )
      );

  /*
   * Compatibility contract.
   *
   * documentUnderstandingBuilder already consumes
   * componentHeadings, so no downstream rewrite
   * is required.
   */
  const componentHeadings =
    headings.filter(
      (item) =>
        item.headingRole ===
        HEADING_ROLES
          .COMPONENT_IDENTITY
    );

  /*
   * Future hybrid semantic review can consume
   * this list without changing deterministic logic.
   */
  const unresolvedHeadings =
    headings.filter(
      (item) =>
        item.headingRole ===
        HEADING_ROLES.UNKNOWN
    );

  const health =
    buildHealth({
      headings,
    });

  const roleCounts =
    countByRole(
      headings
    );

  const payload = {
    version:
      BUILDER_VERSION,

    source:
      'componentHeadingUnderstandingBuilder',

    purpose:
      'Deterministically classify document heading roles and expose only component_identity headings as canonical component candidates.',

    borrowedIdeas: [
      'unstructured_title_starts_section',

      'llamaindex_parent_child_node_ownership',

      'llamaindex_ancestor_traversal',

      'notebook_document_structure_hierarchy',

      'notebook_structural_eligibility_firewall',
    ],

    rules: {
      deterministicOnly:
        true,

      architectureContainerPromotion:
        'forbidden',

      runtimeInstancePromotion:
        'forbidden',

      allHeadingsAreEntities:
        false,

      /*
       * This is the key fix from V1.
       */
      externalReferencePolicy:
        'supporting_evidence_only',

        componentIdentityEvidencePolicy:
        'owned_or_subject_anchored_architecture_description',

        documentSectionNameRequired:
        false,

        unresolvedHeadingPolicy:
        'preserve_as_unknown',

        aliasesInferred:
        false,

      responsibilitiesInferred:
        false,

      fuzzyIdentityMatching:
        'forbidden',

      productKnowledge:
        'forbidden',

      llmClassification:
        'forbidden',

      graphMutation:
        'forbidden',

      traversalMutation:
        'forbidden',
    },

    headingRoles:
      HEADING_ROLES,

    headings,

    componentHeadings,

    unresolvedHeadings,

    health,

    stats: {
      headingCount:
        headings.length,

      componentBearingHeadingCount:
        componentHeadings.length,

      rejectedHeadingCount:
        headings.length -
        componentHeadings.length,

      unknownHeadingCount:
        unresolvedHeadings.length,

      roleCounts,

      componentCollectionBackedCount:
        componentHeadings
          .filter(
            (item) =>
              item.componentCollectionBacked ===
              true
          )
          .length,

      externallyCorroboratedCount:
        componentHeadings
          .filter(
            (item) =>
              item.externalReferenceCount >
              0
          )
          .length,

      ownedArchitectureDescriptionCount:
        componentHeadings
            .filter(
            (item) =>
                item
                .ownedArchitectureDescriptionCount >
                0
            )
            .length,

        subjectAnchoredArchitectureCount:
        componentHeadings
            .filter(
            (item) =>
                item
                .subjectAnchoredArchitectureReferenceCount >
                0
            )
            .length,

      architectureObjectSignalCount:
        componentHeadings
          .filter(
            (item) =>
              item.architectureObjectSignal ===
              true
          )
          .length,

      runtimeInstanceHeadingCount:
        roleCounts[
          HEADING_ROLES.RUNTIME_INSTANCE
        ] || 0,

      operationOrAnnotationHeadingCount:
        roleCounts[
          HEADING_ROLES
            .OPERATION_OR_ANNOTATION
        ] || 0,

      documentMetadataHeadingCount:
        roleCounts[
          HEADING_ROLES
            .DOCUMENT_METADATA
        ] || 0,

      architectureContainerLeakCount:
        health
          .architectureContainerLeakCount,

      runtimeInstanceLeakCount:
        health
          .runtimeInstanceLeakCount,

      traversalChanged:
        false,

      graphChanged:
        false,
    },
  };

  if (outputDir) {
    fs.mkdirSync(
      outputDir,
      {
        recursive:
          true,
      }
    );

    fs.writeFileSync(
      path.join(
        outputDir,
        'component-heading-understanding.json'
      ),

      JSON.stringify(
        payload,
        null,
        2
      ),

      'utf8'
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  HEADING_ROLES,
  buildComponentHeadingUnderstanding,
};