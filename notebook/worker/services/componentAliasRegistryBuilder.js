'use strict';

/**
 * componentAliasRegistryBuilder.js
 *
 * BUG-10 — Deterministic Component Alias Registry
 *
 * Owns:
 * - build one canonical alias registry from BUG-7 canonical components
 * - preserve canonical component identity
 * - preserve source entity identity and provenance
 * - reject ambiguous aliases rather than guessing ownership
 * - provide stable alias → canonical component mappings
 *
 * Borrowed ideas:
 * - Existing Notebook canonical component registry
 * - Existing componentClaimRegistryBuilder alias ownership
 * - Knowledge graphs: one canonical node, multiple labels
 * - Compiler symbol tables: ambiguous symbols fail closed
 *
 * Does NOT:
 * - infer new component meaning
 * - infer aliases from product knowledge
 * - infer runtime families
 * - infer deployment
 * - infer responsibilities
 * - mutate architecture graph
 * - mutate traversal
 * - call an LLM
 */

const fs = require('fs');
const path = require('path');

const BUILDER_VERSION =
  'component-alias-registry-v1';

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

function normalizeAlias(value = '') {
  return safeLower(value)
    .replace(/^[•◦▪‣*-]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniq(values = []) {
  return Array.from(
    new Set(
      asArray(values)
        .map(safeString)
        .filter(Boolean)
    )
  );
}

function buildAliasCandidates({
  canonicalComponents = [],
} = {}) {
  return asArray(canonicalComponents)
    .map((component) => {
      const componentId =
        safeString(component.id);

      const canonicalName =
        safeString(
          component.title ||
          component.name
        );

      if (
        !componentId ||
        !canonicalName
      ) {
        return null;
      }

      /*
       * BUG-7 already owns identity derivation.
       * BUG-10 only registers those identities.
       *
       * Do not create broad aliases here from:
       * - first token guesses
       * - suffix stripping
       * - industry knowledge
       *
       * Those belong upstream if ever justified.
       */
      const aliases =
        uniq([
          canonicalName,

          ...asArray(
            component.rawIdentityNames
          ),
        ])
          .filter(
            (alias) =>
              safeString(alias).length >= 2
          );

      return {
        componentId,
        canonicalName,

        sourceEntityId:
          component.entityId ||
          null,

        canonicalIdentitySource:
          component.canonicalIdentitySource ||
          'original_entity',

        aliases,

        evidenceIds:
          uniq(
            component.evidenceIds
          ),

        pages:
          uniq(
            component.pages
          ),

        sectionIds:
          uniq(
            component.sectionIds
          ),

        confidence:
          component.confidence ||
          'unknown',
      };
    })
    .filter(Boolean);
}

function buildAliasOwnershipIndex(
  aliasCandidates = []
) {
  const aliasOwners =
    new Map();

  for (const component of aliasCandidates) {
    for (const alias of component.aliases) {
      const aliasKey =
        normalizeAlias(alias);

      if (!aliasKey) {
        continue;
      }

      if (!aliasOwners.has(aliasKey)) {
        aliasOwners.set(
          aliasKey,
          new Set()
        );
      }

      aliasOwners
        .get(aliasKey)
        .add(
          component.componentId
        );
    }
  }

  return aliasOwners;
}

function buildResolvedAliasRegistry({
  aliasCandidates = [],
  aliasOwnershipIndex = new Map(),
} = {}) {
  return aliasCandidates.map(
    (component) => {
      const resolvedAliases = [];
      const ambiguousAliases = [];

      for (const alias of component.aliases) {
        const aliasKey =
          normalizeAlias(alias);

        if (!aliasKey) {
          continue;
        }

        const owners =
          aliasOwnershipIndex.get(
            aliasKey
          );

        if (
          !owners ||
          owners.size !== 1
        ) {
          ambiguousAliases.push(
            alias
          );

          continue;
        }

        resolvedAliases.push(
          alias
        );
      }

      return {
        componentId:
          component.componentId,

        canonicalName:
          component.canonicalName,

        sourceEntityId:
          component.sourceEntityId,

        canonicalIdentitySource:
          component.canonicalIdentitySource,

        aliases:
          uniq(
            resolvedAliases
          ),

        ambiguousAliases:
          uniq(
            ambiguousAliases
          ),

        aliasCount:
          uniq(
            resolvedAliases
          ).length,

        ambiguousAliasCount:
          uniq(
            ambiguousAliases
          ).length,

        evidenceIds:
          component.evidenceIds,

        pages:
          component.pages,

        sectionIds:
          component.sectionIds,

        confidence:
          component.confidence,
      };
    }
  );
}

function buildAliasLookup(
  components = []
) {
  const lookup = [];

  for (const component of components) {
    for (const alias of component.aliases) {
      lookup.push({
        alias,
        normalizedAlias:
          normalizeAlias(alias),

        componentId:
          component.componentId,

        canonicalName:
          component.canonicalName,

        sourceEntityId:
          component.sourceEntityId,
      });
    }
  }

  return lookup
    .sort(
      (left, right) =>
        left.normalizedAlias.localeCompare(
          right.normalizedAlias
        )
    );
}

function buildAmbiguousAliasRecords({
  aliasOwnershipIndex = new Map(),
  aliasCandidates = [],
} = {}) {
  const componentById =
    new Map(
      aliasCandidates.map(
        (component) => [
          component.componentId,
          component,
        ]
      )
    );

  const ambiguous = [];

  for (
    const [
      normalizedAlias,
      owners,
    ]
    of aliasOwnershipIndex.entries()
  ) {
    if (
      !owners ||
      owners.size <= 1
    ) {
      continue;
    }

    ambiguous.push({
      normalizedAlias,

      componentIds:
        Array.from(owners),

      canonicalNames:
        Array.from(owners)
          .map(
            (componentId) =>
              componentById.get(
                componentId
              )?.canonicalName
          )
          .filter(Boolean),

      status:
        'ambiguous',

      resolution:
        'unresolved',

      reason:
        'alias_has_multiple_canonical_component_owners',
    });
  }

  return ambiguous.sort(
    (left, right) =>
      left.normalizedAlias.localeCompare(
        right.normalizedAlias
      )
  );
}

function buildAliasHealth({
  canonicalComponents = [],
  components = [],
  aliasLookup = [],
  ambiguousAliases = [],
} = {}) {
  const duplicateAliasKeys =
    aliasLookup
      .map(
        (record) =>
          record.normalizedAlias
      )
      .filter(
        (
          alias,
          index,
          aliases
        ) =>
          aliases.indexOf(alias) !==
          index
      );

  const missingComponentIds =
    components.filter(
      (component) =>
        !safeString(
          component.componentId
        )
    );

  const missingCanonicalNames =
    components.filter(
      (component) =>
        !safeString(
          component.canonicalName
        )
    );

  const canonicalComponentIds =
    new Set(
      asArray(canonicalComponents)
        .map(
          (component) =>
            safeString(component.id)
        )
        .filter(Boolean)
    );

  const orphanAliasMappings =
    aliasLookup.filter(
      (record) =>
        !canonicalComponentIds.has(
          record.componentId
        )
    );

  const violations = [
    ...missingComponentIds.map(
      (component) => ({
        type:
          'missing_component_id',

        severity:
          'high',

        canonicalName:
          component.canonicalName ||
          null,
      })
    ),

    ...missingCanonicalNames.map(
      (component) => ({
        type:
          'missing_canonical_name',

        severity:
          'high',

        componentId:
          component.componentId ||
          null,
      })
    ),

    ...duplicateAliasKeys.map(
      (normalizedAlias) => ({
        type:
          'duplicate_resolved_alias',

        severity:
          'high',

        normalizedAlias,
      })
    ),

    ...orphanAliasMappings.map(
      (record) => ({
        type:
          'orphan_alias_mapping',

        severity:
          'high',

        normalizedAlias:
          record.normalizedAlias,

        componentId:
          record.componentId,
      })
    ),
  ];

  return {
    version:
      'component-alias-registry-health-v1',

    valid:
      violations.length === 0,

    violationCount:
      violations.length,

    canonicalComponentCount:
      asArray(
        canonicalComponents
      ).length,

    componentAliasRecordCount:
      components.length,

    resolvedAliasCount:
      aliasLookup.length,

    ambiguousAliasCount:
      ambiguousAliases.length,

    duplicateResolvedAliasCount:
      duplicateAliasKeys.length,

    orphanAliasMappingCount:
      orphanAliasMappings.length,

    missingComponentIdCount:
      missingComponentIds.length,

    missingCanonicalNameCount:
      missingCanonicalNames.length,

    graphChanged:
      false,

    traversalChanged:
      false,

    violations,
  };
}

function buildComponentAliasRegistry({
  documentUnderstanding = {},
  outputDir = null,
} = {}) {
  const canonicalComponents =
    asArray(
      documentUnderstanding
        .canonicalComponents
    );

  const aliasCandidates =
    buildAliasCandidates({
      canonicalComponents,
    });

  const aliasOwnershipIndex =
    buildAliasOwnershipIndex(
      aliasCandidates
    );

  const components =
    buildResolvedAliasRegistry({
      aliasCandidates,
      aliasOwnershipIndex,
    });

  const aliasLookup =
    buildAliasLookup(
      components
    );

  const ambiguousAliases =
    buildAmbiguousAliasRecords({
      aliasOwnershipIndex,
      aliasCandidates,
    });

  const health =
    buildAliasHealth({
      canonicalComponents,
      components,
      aliasLookup,
      ambiguousAliases,
    });

  const payload = {
    version:
      BUILDER_VERSION,

    source:
      'componentAliasRegistryBuilder',

    purpose:
      'Provide one deterministic canonical alias registry for document-defined architecture components.',

    rules: {
      deterministicOnly:
        true,

      canonicalIdentityOwnedByBug7:
        true,

      ambiguousAliasGuessing:
        'forbidden',

      productKnowledgeAliases:
        'forbidden',

      inferredSemanticAliases:
        'forbidden',

      graphMutation:
        'forbidden',

      traversalMutation:
        'forbidden',

      llmAliasResolution:
        'forbidden',
    },

    components,
    aliasLookup,
    ambiguousAliases,
    health,

    stats: {
      canonicalComponentCount:
        canonicalComponents.length,

      componentAliasRecordCount:
        components.length,

      componentWithMultipleAliasesCount:
        components.filter(
          (component) =>
            component.aliasCount > 1
        ).length,

      resolvedAliasCount:
        aliasLookup.length,

      ambiguousAliasCount:
        ambiguousAliases.length,

      componentWithAmbiguousAliasCount:
        components.filter(
          (component) =>
            component
              .ambiguousAliasCount > 0
        ).length,

      graphChanged:
        false,

      traversalChanged:
        false,
    },

    inputs: {
      documentUnderstandingVersion:
        documentUnderstanding.version ||
        null,
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
        'component-aliases.json'
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
  normalizeAlias,
  buildComponentAliasRegistry,
};