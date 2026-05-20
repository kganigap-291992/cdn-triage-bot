'use strict';

/**
 * BUG-22H.4 — Architecture Graph Partitioner
 *
 * Separates relationships into primary/supporting/background/unknown lanes.
 * No traversal changes yet.
 */

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function partitionRelationships(relationships = []) {
  const buckets = {
    primary: [],
    supporting: [],
    background: [],
    unknown: [],
  };

  for (const relationship of asArray(relationships)) {
    const priority = relationship.flowPriority || 'unknown';

    if (priority === 'primary') {
      buckets.primary.push(relationship);
    } else if (priority === 'supporting') {
      buckets.supporting.push(relationship);
    } else if (priority === 'background') {
      buckets.background.push(relationship);
    } else {
      buckets.unknown.push(relationship);
    }
  }

  return buckets;
}

function summarizeBucket(items = []) {
  return {
    count: items.length,
    edgeTypeBreakdown: items.reduce((acc, item) => {
      const key = item.edgeType || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    interactionModeBreakdown: items.reduce((acc, item) => {
      const key = item.interactionMode || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };
}

function buildArchitectureGraphPartitions(relationships = []) {
  const buckets = partitionRelationships(relationships);

  return {
    version: 'architecture-graph-partitions-v1',
    generatedAt: new Date().toISOString(),
    stats: {
      totalRelationshipCount: asArray(relationships).length,
      primaryCount: buckets.primary.length,
      supportingCount: buckets.supporting.length,
      backgroundCount: buckets.background.length,
      unknownCount: buckets.unknown.length,
    },
    summaries: {
      primary: summarizeBucket(buckets.primary),
      supporting: summarizeBucket(buckets.supporting),
      background: summarizeBucket(buckets.background),
      unknown: summarizeBucket(buckets.unknown),
    },
    primary: buckets.primary,
    supporting: buckets.supporting,
    background: buckets.background,
    unknown: buckets.unknown,
  };
}

module.exports = {
  partitionRelationships,
  buildArchitectureGraphPartitions,
};