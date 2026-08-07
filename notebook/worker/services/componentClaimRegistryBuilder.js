'use strict';

/**
 * componentClaimRegistryBuilder.js
 *
 * BUG-9 — Deterministic Component Claim Registry
 *
 * Owns:
 * - extract explicit document claims about canonical components
 * - preserve positive and negative claim polarity
 * - preserve exact source wording and evidence provenance
 * - group claims under canonical component identity
 *
 * Borrowed ideas:
 * - NotebookLM: claims must remain grounded in supplied sources
 * - RDF / knowledge graphs: subject-predicate-object assertions
 * - Neo4j property graphs: evidence-bearing entity facts
 * - Existing Notebook builders:
 *     canonical component registry ownership
 *     evidenceIds / confidence / basis
 *     deterministic health and validation contracts
 *
 * Does NOT:
 * - infer facts from component names
 * - treat missing information as false
 * - generate synthetic negative capabilities
 * - summarize or polish claims
 * - resolve broad aliases
 * - infer private implementation behavior
 * - mutate architecture graph
 * - mutate traversal
 * - call an LLM
 */

const fs = require('fs');
const path = require('path');

const BUILDER_VERSION =
  'component-claim-registry-v1';

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

function escapeRegExp(value = '') {
  return String(value)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeClaimValue(value = '') {
  return safeString(value)
    .replace(/^[\s,:;–—-]+/, '')
    .replace(/[\s.;,:]+$/, '')
    .trim();
}

function splitIntoClauses(value = '') {
  return safeString(value)
    /*
     * Preserve short definition labels while splitting
     * larger paragraphs and numbered journey prose.
     */
    .replace(/\s+(?=\d+\.\s+)/g, '\n')
    .split(
      /\n+|(?<=[.!?])\s+|;/
    )
    .map(safeString)
    .filter(Boolean);
}

function normalizeEvidenceRecord(
  record = {},
  fallbackSource = null
) {
  const id =
    record.id ||
    record.evidenceId ||
    null;

  const text =
    safeString(
      record.text ||
      record.rawText ||
      record.content ||
      record.summary ||
      record.value ||
      record.label
    );

  if (!id || !text) {
    return null;
  }

  return {
    id,
    text,

    page:
      record.page ||
      record.pageNumber ||
      null,

    sectionId:
      record.sectionId ||
      null,

    parentSectionId:
      record.parentSectionId ||
      null,

    headingKind:
      record.headingKind ||
      null,

    type:
      record.type ||
      record.evidenceType ||
      record.normalizedType ||
      null,

    source:
      record.source ||
      fallbackSource ||
      null,

    confidence:
      record.confidence ||
      null,
  };
}

function collectEvidence({
  documentUnderstanding = {},
  architectureEvidence = {},
} = {}) {
  const byId =
    new Map();

  const candidates = [
    ...asArray(
      documentUnderstanding.evidence
    ).map((record) =>
      normalizeEvidenceRecord(
        record,
        'document-understanding.json'
      )
    ),

    ...asArray(
      architectureEvidence.evidenceRecords
    ).map((record) =>
      normalizeEvidenceRecord(
        record,
        'architecture-evidence.json'
      )
    ),
  ]
    .filter(Boolean);

  for (const record of candidates) {
    if (!byId.has(record.id)) {
      byId.set(
        record.id,
        record
      );

      continue;
    }

    const existing =
      byId.get(record.id);

    byId.set(
      record.id,
      {
        ...existing,

        text:
          existing.text ||
          record.text,

        page:
          existing.page ||
          record.page,

        sectionId:
          existing.sectionId ||
          record.sectionId,

        parentSectionId:
          existing.parentSectionId ||
          record.parentSectionId,

        headingKind:
          existing.headingKind ||
          record.headingKind,

        type:
          existing.type ||
          record.type,

        source:
          existing.source ||
          record.source,

        confidence:
          existing.confidence ||
          record.confidence,
      }
    );
  }

  return Array.from(
    byId.values()
  );
}

function buildCanonicalComponentReferences({
  documentUnderstanding = {},
} = {}) {
  const components =
    asArray(
      documentUnderstanding
        .canonicalComponents
    );

  /*
   * Alias ownership is intentionally conservative.
   * Ambiguous aliases are removed rather than selecting
   * one canonical component arbitrarily.
   */
  const references =
    components
      .map((component) => {
        const title =
          safeString(
            component.title ||
            component.name
          );

        if (
          !component.id ||
          !title
        ) {
          return null;
        }

        const aliases =
          uniq([
            title,

            ...asArray(
              component.rawIdentityNames
            ),

            /*
             * Preserve the source entity label used by
             * BUG-7, such as:
             *   Super8 Shared
             *   Atlas Validation
             */
            component.sourceEntityName,
          ])
            .map(safeString)
            .filter(
              (alias) =>
                alias.length >= 3
            );

        return {
          componentId:
            component.id,

          componentName:
            title,

          componentKind:
            component.kind ||
            'unknown',

          componentEvidenceIds:
            uniq(
              component.evidenceIds
            ),

          aliases,

          sourceEntityId:
            component.entityId ||
            null,

          canonicalIdentitySource:
            component.canonicalIdentitySource ||
            'original_entity',

          confidence:
            component.confidence ||
            'unknown',
        };
      })
      .filter(Boolean);

  const aliasOwners =
    new Map();

  for (const reference of references) {
    for (const alias of reference.aliases) {
      const key =
        safeLower(alias);

      if (!aliasOwners.has(key)) {
        aliasOwners.set(
          key,
          new Set()
        );
      }

      aliasOwners
        .get(key)
        .add(
          reference.componentId
        );
    }
  }

  return references.map(
    (reference) => ({
      ...reference,

      aliases:
        reference.aliases.filter(
          (alias) =>
            aliasOwners
              .get(
                safeLower(alias)
              )
              ?.size === 1
        ),
    })
  );
}

function findAliasMentions({
  text = '',
  componentReferences = [],
} = {}) {
  const mentions = [];

  for (
    const component of
    componentReferences
  ) {
    for (const alias of component.aliases) {
      const regex =
        new RegExp(
          `(^|[^a-z0-9])(${escapeRegExp(alias)})(?=$|[^a-z0-9])`,
          'gi'
        );

      let match;

      while (
        (match =
          regex.exec(text)) !== null
      ) {
        const prefixLength =
          match[1]?.length ||
          0;

        const start =
          match.index +
          prefixLength;

        const matchedAlias =
          match[2];

        mentions.push({
          component,
          alias:
            matchedAlias,

          start,

          end:
            start +
            matchedAlias.length,
        });

        if (
          regex.lastIndex ===
          match.index
        ) {
          regex.lastIndex += 1;
        }
      }
    }
  }

  /*
   * Prefer the longest alias when multiple aliases start
   * at the same character position.
   */
  return mentions
    .sort(
      (left, right) =>
        left.start -
          right.start ||
        right.alias.length -
          left.alias.length
    )
    .filter(
      (mention, index, all) =>
        !all.some(
          (other, otherIndex) =>
            otherIndex < index &&
            other.start ===
              mention.start &&
            other.end >=
              mention.end
        )
    );
}

const NEGATIVE_CLASSIFICATION_PATTERNS = [
  /^(?:is|are)\s+not\s+(?:an?\s+|the\s+)?(.+)$/i,
  /^(?:should|must)\s+not\s+be\s+(?:treated|classified|described|understood)\s+as\s+(?:an?\s+|the\s+)?(.+)$/i,
  /^(?:is|are)\s+not\s+(?:intended|designed)\s+to\s+be\s+(?:an?\s+|the\s+)?(.+)$/i,
  /^(?:should|must)\s+not\s+be\s+confused\s+with\s+(?:an?\s+|the\s+)?(.+)$/i,
];

const NEGATIVE_CAPABILITY_PATTERNS = [
  /^does\s+not\s+(.+)$/i,
  /^do\s+not\s+(.+)$/i,
  /^never\s+(.+)$/i,
  /^cannot\s+(.+)$/i,
  /^can\s+not\s+(.+)$/i,
  /^must\s+not\s+(.+)$/i,
];

const POSITIVE_CLASSIFICATION_PATTERNS = [
  /^(?:is|are)\s+(?:an?\s+|the\s+)?(.+)$/i,
  /^(?:acts|act)\s+as\s+(?:an?\s+|the\s+)?(.+)$/i,
  /^(?:serves|serve)\s+as\s+(?:an?\s+|the\s+)?(.+)$/i,
  /^(?:represents|represent)\s+(?:an?\s+|the\s+)?(.+)$/i,
  /^(?:functions|function)\s+as\s+(?:an?\s+|the\s+)?(.+)$/i,
];

const POSITIVE_CAPABILITY_PATTERN =
  /^(routes?|forwards?|sends?|delivers?|passes?|returns?|publishes?|emits?|distributes?|writes?|commits?|persists?|stores?|archives?|saves?|reads?|loads?|retrieves?|fetches?|calls?|invokes?|queries?|checks?|depends\s+on|relies\s+on|uses?|connects?|links?|validates?|verifies?|authenticates?|authorizes?|indexes?|enriches?|normalizes?|maps?|processes?|transforms?|collects?|monitors?|serves?|provides?)\b(.+)$/i;

const DOCUMENT_META_CLAIM_PATTERN =
  /\b(defined in prose|defined elsewhere|listed above|listed below|shown in the diagram|described in this document|documented component|component definition)\b/i;

const RUNTIME_INSTANCE_LABEL_PATTERN =
  /^(?:worker|indexer|cache|replica|api|service|processor|pod|instance|node)\s+(?:[1-9][0-9]*|[A-D])$/i;

const DEFINITION_NOUN_PATTERN =
  /\b(api|application|app|service|worker|processor|indexer|cache|database|db|store|storage|proxy|reverse[- ]proxy|router|routing|gateway|queue|broker|repository|object storage|metadata store|validation service|authentication service|telemetry stack|observability platform|provider|client|console|interface|runtime|replica|cluster|engine|orchestrator|scheduler|publication service|configuration service|routing layer)\b/i;

function looksLikeListMembershipStatement(value = '') {
  const text = safeString(value);

  if (!text) {
    return false;
  }

  if (/^[-•▪◦]\s+/.test(text)) {
    return true;
  }

  const separatorCount =
    (text.match(/\s[-–—]\s/g) || []).length;

  return separatorCount >= 2;
}

function buildClaim({
  component = {},
  evidence = {},
  claimType,
  polarity,
  value,
  statement,
  matchedAlias,
  basis,
  confidence,
} = {}) {
  const normalizedValue =
    normalizeClaimValue(value);

  const rawStatement =
    safeString(statement);

  if (
    !component.componentId ||
    !normalizedValue ||
    !rawStatement ||
    !evidence.id ||

    DOCUMENT_META_CLAIM_PATTERN.test(
        normalizedValue
    ) ||

    DOCUMENT_META_CLAIM_PATTERN.test(
        rawStatement
    ) ||

    (
        claimType === 'definition' &&
        RUNTIME_INSTANCE_LABEL_PATTERN.test(
        normalizedValue
        )
    ) ||

    (
        claimType === 'definition' &&
        looksLikeListMembershipStatement(
        rawStatement
        )
    )
    ) {
    return null;
    }

  const predicate =
    claimType ===
      'classification'
      ? 'is_a'
      : claimType ===
          'capability'
        ? 'performs'
        : 'document_states';

  return {
    claimId:
      [
        'claim',
        slugify(
          component.componentId
        ),
        polarity,
        slugify(claimType),
        slugify(normalizedValue),
      ].join('_'),

    componentId:
      component.componentId,

    componentName:
      component.componentName,

    subject:
      component.componentName,

    predicate,

    object:
      normalizedValue,

    claimType,

    polarity,

    value:
      normalizedValue,

    statement:
      rawStatement,

    matchedAlias:
      safeString(matchedAlias),

    evidenceIds: [
      evidence.id,
    ],

    pages:
      uniq([
        evidence.page,
      ]),

    sectionIds:
      uniq([
        evidence.sectionId,
      ]),

    parentSectionIds:
      uniq([
        evidence.parentSectionId,
      ]),

    headingKinds:
      uniq([
        evidence.headingKind,
      ]),

    evidenceSources:
      uniq([
        evidence.source,
      ]),

    evidenceTypes:
      uniq([
        evidence.type,
      ]),

    basis,

    confidence:
      confidence ||
      'high',

    source:
      'componentClaimRegistryBuilder',

    safety: {
      explicitDocumentStatement:
        true,

      inferredFromMissingInformation:
        false,

      productKnowledgeUsed:
        false,

      llmGenerated:
        false,

      canInferPrivateImplementation:
        false,
    },
  };
}

function extractClaimFromClause({
  clause = '',
  mention = {},
  evidence = {},
} = {}) {
  const text =
    safeString(clause);

  if (
    !text ||
    !mention.component
  ) {
    return null;
  }

  /*
   * V1 requires the component mention to appear near the
   * start of the clause. This avoids assigning predicates
   * to an object mentioned later in a relationship sentence.
   */
  if (mention.start > 24) {
    return null;
  }

  const afterSubject =
    safeString(
      text.slice(
        mention.end
      )
    )
      .replace(
        /^[\s,:;–—-]+/,
        ''
      )
      .trim();

  if (!afterSubject) {
    return null;
  }

  for (
    const pattern of
    NEGATIVE_CLASSIFICATION_PATTERNS
  ) {
    const match =
      afterSubject.match(
        pattern
      );

    if (match) {
      return buildClaim({
        component:
          mention.component,

        evidence,

        claimType:
          'classification',

        polarity:
          'negative',

        value:
          match[1],

        statement:
          text,

        matchedAlias:
          mention.alias,

        basis:
          'explicit_negative_classification_statement',

        confidence:
          'high',
      });
    }
  }

  for (
    const pattern of
    NEGATIVE_CAPABILITY_PATTERNS
  ) {
    const match =
      afterSubject.match(
        pattern
      );

    if (match) {
      return buildClaim({
        component:
          mention.component,

        evidence,

        claimType:
          'capability',

        polarity:
          'negative',

        value:
          match[1],

        statement:
          text,

        matchedAlias:
          mention.alias,

        basis:
          'explicit_negative_capability_statement',

        confidence:
          'high',
      });
    }
  }

  for (
    const pattern of
    POSITIVE_CLASSIFICATION_PATTERNS
  ) {
    const match =
      afterSubject.match(
        pattern
      );

    if (match) {
      return buildClaim({
        component:
          mention.component,

        evidence,

        claimType:
          'classification',

        polarity:
          'positive',

        value:
          match[1],

        statement:
          text,

        matchedAlias:
          mention.alias,

        basis:
          'explicit_positive_classification_statement',

        confidence:
          'high',
      });
    }
  }

  const capabilityMatch =
    afterSubject.match(
      POSITIVE_CAPABILITY_PATTERN
    );

  if (capabilityMatch) {
    return buildClaim({
      component:
        mention.component,

      evidence,

      claimType:
        'capability',

      polarity:
        'positive',

      value:
        `${capabilityMatch[1]}${capabilityMatch[2]}`,

      statement:
        text,

      matchedAlias:
        mention.alias,

      basis:
        'explicit_positive_capability_statement',

      confidence:
        'high',
    });
  }

  /*
   * Support concise architecture definitions such as:
   *
   * Super8 — Shared reverse proxy and routing layer
   * Nimbus: Canonical metadata store
   *
   * Require an architecture noun so ordinary headings do
   * not become semantic claims.
   */
  const definitionSeparator =
    text.slice(
      mention.end
    ).match(
      /^\s*(?:[:–—-])\s*(.+)$/
    );

  if (
    definitionSeparator &&
    DEFINITION_NOUN_PATTERN.test(
      definitionSeparator[1]
    )
  ) {
    return buildClaim({
      component:
        mention.component,

      evidence,

      claimType:
        'definition',

      polarity:
        'positive',

      value:
        definitionSeparator[1],

      statement:
        text,

      matchedAlias:
        mention.alias,

      basis:
        'explicit_document_definition_label',

      confidence:
        'high',
    });
  }

  /*
   * Some architecture diagrams omit punctuation:
   *
   * Super8 Shared reverse proxy and routing layer
   *
   * Only accept this shape from short, structural evidence.
   */
  const shortStructuralEvidence =
    (
      safeLower(
        evidence.type
      ) === 'section' ||
      safeLower(
        evidence.type
      ) === 'heading' ||
      safeLower(
        evidence.type
      ) === 'diagram_label' ||
      safeLower(
        evidence.type
      ) === 'label' ||
      safeLower(
        evidence.source
      ).includes(
        'heading'
      )
    ) &&
    text.length <= 180;

  if (
    shortStructuralEvidence &&
    DEFINITION_NOUN_PATTERN.test(
      afterSubject
    )
  ) {
    return buildClaim({
      component:
        mention.component,

      evidence,

      claimType:
        'definition',

      polarity:
        'positive',

      value:
        afterSubject,

      statement:
        text,

      matchedAlias:
        mention.alias,

      basis:
        'explicit_short_structural_definition',

      confidence:
        'medium',
    });
  }

  return null;
}

function mergeClaims(
  claims = []
) {
  const byKey =
    new Map();

  for (const claim of claims) {
    if (!claim) {
      continue;
    }

    const key =
      [
        claim.componentId,
        claim.claimType,
        claim.polarity,
        safeLower(
          claim.value
        ),
      ].join(':');

    if (!byKey.has(key)) {
      byKey.set(
        key,
        claim
      );

      continue;
    }

    const existing =
      byKey.get(key);

    byKey.set(
      key,
      {
        ...existing,

        evidenceIds:
          uniq([
            ...asArray(
              existing.evidenceIds
            ),

            ...asArray(
              claim.evidenceIds
            ),
          ]),

        pages:
          uniq([
            ...asArray(
              existing.pages
            ),

            ...asArray(
              claim.pages
            ),
          ]),

        sectionIds:
          uniq([
            ...asArray(
              existing.sectionIds
            ),

            ...asArray(
              claim.sectionIds
            ),
          ]),

        parentSectionIds:
          uniq([
            ...asArray(
              existing.parentSectionIds
            ),

            ...asArray(
              claim.parentSectionIds
            ),
          ]),

        headingKinds:
          uniq([
            ...asArray(
              existing.headingKinds
            ),

            ...asArray(
              claim.headingKinds
            ),
          ]),

        evidenceSources:
          uniq([
            ...asArray(
              existing.evidenceSources
            ),

            ...asArray(
              claim.evidenceSources
            ),
          ]),

        evidenceTypes:
          uniq([
            ...asArray(
              existing.evidenceTypes
            ),

            ...asArray(
              claim.evidenceTypes
            ),
          ]),

        statements:
          uniq([
            ...asArray(
              existing.statements ||
              [
                existing.statement,
              ]
            ),

            ...asArray(
              claim.statements ||
              [
                claim.statement,
              ]
            ),
          ]),

        confidence:
          existing.confidence ===
            'high' ||
          claim.confidence ===
            'high'
            ? 'high'
            : 'medium',
      }
    );
  }

  return Array.from(
    byKey.values()
  )
    .map((claim) => ({
      ...claim,

      statements:
        uniq(
          claim.statements ||
          [
            claim.statement,
          ]
        ),
    }))
    .sort(
      (left, right) =>
        left.componentName
          .localeCompare(
            right.componentName
          ) ||
        left.claimType
          .localeCompare(
            right.claimType
          ) ||
        left.polarity
          .localeCompare(
            right.polarity
          ) ||
        left.value
          .localeCompare(
            right.value
          )
    );
}

function extractComponentClaims({
  componentReferences = [],
  evidence = [],
} = {}) {
  const claims = [];

  for (const record of evidence) {
    let previousExplicitSubject = null;

    for (
      const clause of
      splitIntoClauses(
        record.text
      )
    ) {
      const mentions =
        findAliasMentions({
          text:
            clause,

          componentReferences,
        });

      if (mentions.length) {
        previousExplicitSubject =
          mentions[0];

        for (const mention of mentions) {
          const claim =
            extractClaimFromClause({
              clause,
              mention,
              evidence:
                record,
            });

          if (claim) {
            claims.push(
              claim
            );

            break;
          }
        }

        continue;
      }

      const pronounNegative =
        clause.match(
          /^(?:it|this component|this service)\s+(is not|does not|never|cannot|must not)\b(.+)$/i
        );

      if (
        pronounNegative &&
        previousExplicitSubject
      ) {
        const syntheticClause =
          `${previousExplicitSubject.alias} ${pronounNegative[1]}${pronounNegative[2]}`;

        const claim =
          extractClaimFromClause({
            clause:
              syntheticClause,

            mention: {
              ...previousExplicitSubject,
              start:
                0,

              end:
                previousExplicitSubject
                  .alias.length,
            },

            evidence:
              record,
          });

        if (claim) {
          claims.push({
            ...claim,

            statement:
              clause,

            basis:
              `${claim.basis}_adjacent_pronoun_subject`,
          });
        }
      }
    }
  }

  return mergeClaims(
    claims
  );
}

function groupClaimsByComponent({
  componentReferences = [],
  claims = [],
} = {}) {
  const claimsByComponent =
    new Map();

  for (const claim of claims) {
    if (
      !claimsByComponent.has(
        claim.componentId
      )
    ) {
      claimsByComponent.set(
        claim.componentId,
        []
      );
    }

    claimsByComponent
      .get(
        claim.componentId
      )
      .push(
        claim
      );
  }

  return componentReferences.map(
    (component) => {
      const componentClaims =
        asArray(
          claimsByComponent.get(
            component.componentId
          )
        );

      const positiveClaims =
        componentClaims.filter(
          (claim) =>
            claim.polarity ===
            'positive'
        );

      const negativeClaims =
        componentClaims.filter(
          (claim) =>
            claim.polarity ===
            'negative'
        );

      return {
        componentId:
          component.componentId,

        componentName:
          component.componentName,

        componentKind:
          component.componentKind,

        sourceEntityId:
          component.sourceEntityId,

        canonicalIdentitySource:
          component.canonicalIdentitySource,

        aliases:
          component.aliases,

        claimCount:
          componentClaims.length,

        positiveClaimCount:
          positiveClaims.length,

        negativeClaimCount:
          negativeClaims.length,

        claims:
          componentClaims,

        positiveClaims,

        negativeClaims,

        evidenceIds:
          uniq(
            componentClaims.flatMap(
              (claim) =>
                claim.evidenceIds
            )
          ),

        pages:
          uniq(
            componentClaims.flatMap(
              (claim) =>
                claim.pages
            )
          ),

        sectionIds:
          uniq(
            componentClaims.flatMap(
              (claim) =>
                claim.sectionIds
            )
          ),

        confidence:
          componentClaims.some(
            (claim) =>
              claim.confidence ===
              'high'
          )
            ? 'high'
            : componentClaims.length
              ? 'medium'
              : 'unknown',

        source:
          'componentClaimRegistryBuilder',

        safety: {
          onlyExplicitDocumentClaims:
            true,

          missingClaimsAreUnknown:
            true,

          negativeClaimsRequireExplicitNegation:
            true,

          productKnowledgeUsed:
            false,

          llmGenerated:
            false,
        },
      };
    }
  );
}

function buildComponentClaimHealth({
  componentReferences = [],
  componentClaims = [],
  claims = [],
} = {}) {
  const duplicateClaimIds =
    claims
      .map(
        (claim) =>
          claim.claimId
      )
      .filter(
        (id, index, ids) =>
          id &&
          ids.indexOf(id) !==
            index
      );

  const claimsWithoutEvidence =
    claims.filter(
      (claim) =>
        asArray(
          claim.evidenceIds
        ).length === 0
    );

  const claimsWithoutSubject =
    claims.filter(
      (claim) =>
        !safeString(
          claim.componentId
        ) ||
        !safeString(
          claim.componentName
        )
    );

  const claimsWithoutValue =
    claims.filter(
      (claim) =>
        !safeString(
          claim.value
        )
    );

  const invalidPolarityClaims =
    claims.filter(
      (claim) =>
        ![
          'positive',
          'negative',
        ].includes(
          claim.polarity
        )
    );

  const negativeClaimsWithoutExplicitBasis =
    claims.filter(
      (claim) =>
        claim.polarity ===
          'negative' &&
        !safeString(
          claim.basis
        ).startsWith(
          'explicit_negative_'
        )
    );

  const orphanClaimComponentIds =
    claims
      .filter(
        (claim) =>
          !componentReferences.some(
            (component) =>
              component.componentId ===
              claim.componentId
          )
      )
      .map(
        (claim) =>
          claim.componentId
      );

  const graphChanged =
    false;

  const traversalChanged =
    false;

  const violations = [
    ...duplicateClaimIds.map(
      (claimId) => ({
        type:
          'duplicate_claim_id',

        severity:
          'high',

        claimId,
      })
    ),

    ...claimsWithoutEvidence.map(
      (claim) => ({
        type:
          'claim_without_evidence',

        severity:
          'high',

        claimId:
          claim.claimId,
      })
    ),

    ...claimsWithoutSubject.map(
      (claim) => ({
        type:
          'claim_without_canonical_subject',

        severity:
          'high',

        claimId:
          claim.claimId,
      })
    ),

    ...claimsWithoutValue.map(
      (claim) => ({
        type:
          'claim_without_value',

        severity:
          'high',

        claimId:
          claim.claimId,
      })
    ),

    ...invalidPolarityClaims.map(
      (claim) => ({
        type:
          'invalid_claim_polarity',

        severity:
          'high',

        claimId:
          claim.claimId,

        polarity:
          claim.polarity,
      })
    ),

    ...negativeClaimsWithoutExplicitBasis.map(
      (claim) => ({
        type:
          'negative_claim_without_explicit_negation_basis',

        severity:
          'high',

        claimId:
          claim.claimId,
      })
    ),

    ...orphanClaimComponentIds.map(
      (componentId) => ({
        type:
          'claim_subject_not_in_canonical_registry',

        severity:
          'high',

        componentId,
      })
    ),
  ];

  return {
    version:
      'component-claim-registry-health-v1',

    valid:
      violations.length === 0 &&
      graphChanged === false &&
      traversalChanged === false,

    violationCount:
      violations.length,

    warningCount:
      0,

    canonicalComponentCount:
      componentReferences.length,

    componentClaimRecordCount:
      componentClaims.length,

    componentWithClaimsCount:
      componentClaims.filter(
        (component) =>
          component.claimCount > 0
      ).length,

    componentWithoutClaimsCount:
      componentClaims.filter(
        (component) =>
          component.claimCount === 0
      ).length,

    claimCount:
      claims.length,

    positiveClaimCount:
      claims.filter(
        (claim) =>
          claim.polarity ===
          'positive'
      ).length,

    negativeClaimCount:
      claims.filter(
        (claim) =>
          claim.polarity ===
          'negative'
      ).length,

    classificationClaimCount:
      claims.filter(
        (claim) =>
          claim.claimType ===
          'classification'
      ).length,

    capabilityClaimCount:
      claims.filter(
        (claim) =>
          claim.claimType ===
          'capability'
      ).length,

    definitionClaimCount:
      claims.filter(
        (claim) =>
          claim.claimType ===
          'definition'
      ).length,

    duplicateClaimIdCount:
      duplicateClaimIds.length,

    claimWithoutEvidenceCount:
      claimsWithoutEvidence.length,

    claimWithoutSubjectCount:
      claimsWithoutSubject.length,

    claimWithoutValueCount:
      claimsWithoutValue.length,

    invalidPolarityClaimCount:
      invalidPolarityClaims.length,

    negativeClaimWithoutExplicitBasisCount:
      negativeClaimsWithoutExplicitBasis.length,

    orphanClaimComponentCount:
      orphanClaimComponentIds.length,

    graphChanged,

    traversalChanged,

    violations,
  };
}

function buildComponentClaimRegistry({
  documentUnderstanding = {},
  componentAliasRegistry = {},
  architectureEvidence = {},
  outputDir = null,
} = {}) {
  const componentReferences =
  asArray(componentAliasRegistry.components)
    .map((component) => ({
      componentId:
        component.componentId,

      componentName:
        component.canonicalName,

      componentKind:
        'unknown',

      componentEvidenceIds:
        uniq(
          component.evidenceIds
        ),

      aliases:
        uniq(
          component.aliases
        ),

      sourceEntityId:
        component.sourceEntityId ||
        null,

      canonicalIdentitySource:
        component.canonicalIdentitySource ||
        'original_entity',

      confidence:
        component.confidence ||
        'unknown',
    }))
    .filter(
      (component) =>
        component.componentId &&
        component.componentName
    );

  const evidence =
    collectEvidence({
      documentUnderstanding,
      architectureEvidence,
    });

  const claims =
    extractComponentClaims({
      componentReferences,
      evidence,
    });

  const componentClaims =
    groupClaimsByComponent({
      componentReferences,
      claims,
    });

  const health =
    buildComponentClaimHealth({
      componentReferences,
      componentClaims,
      claims,
    });

  const payload = {
    version:
      BUILDER_VERSION,

    source:
      'componentClaimRegistryBuilder',

    purpose:
      'Store explicit evidence-backed component claims without expanding, interpreting, or inventing document meaning.',

    borrowedIdeas: [
      'notebooklm_strict_source_grounding',
      'rdf_subject_predicate_object_assertions',
      'knowledge_graph_evidence_backed_entity_facts',
      'notebook_canonical_component_registry',
      'notebook_evidence_ids_confidence_and_basis_contracts',
    ],

    rules: {
      deterministicOnly:
        true,

      llmGeneratedClaims:
        'forbidden',

      productKnowledge:
        'forbidden',

      privateImplementationInference:
        'forbidden',

      missingInformation:
        'unknown_not_false',

      positiveClaims:
        'explicit_document_statement_required',

      negativeClaims:
        'explicit_document_negation_required',

      architectureGraphMutation:
        'forbidden',

      traversalMutation:
        'forbidden',

      aliasResolution:
        'component_alias_registry_only',

      downstreamPolish:
        'later_phase_only',
    },

    claims,

    componentClaims,

    health,

    sourceArtifacts: {
        documentUnderstanding:
            documentUnderstanding.version ||
            null,

        componentAliasRegistry:
            componentAliasRegistry.version ||
            null,

        architectureEvidence:
            architectureEvidence.version ||
            null,
        },

    stats: {
      canonicalComponentCount:
        componentReferences.length,

      componentClaimRecordCount:
        componentClaims.length,

      componentWithClaimsCount:
        health.componentWithClaimsCount,

      componentWithoutClaimsCount:
        health.componentWithoutClaimsCount,

      claimCount:
        claims.length,

      positiveClaimCount:
        health.positiveClaimCount,

      negativeClaimCount:
        health.negativeClaimCount,

      classificationClaimCount:
        health.classificationClaimCount,

      capabilityClaimCount:
        health.capabilityClaimCount,

      definitionClaimCount:
        health.definitionClaimCount,

      evidenceRecordCount:
        evidence.length,

      graphChanged:
        false,

      traversalChanged:
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
        'component-claims.json'
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
  buildComponentClaimRegistry,
};