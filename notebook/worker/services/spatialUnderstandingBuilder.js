const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function listPageImages(jobDir) {
  const pageImagesDir = path.join(jobDir, "page-images");

  if (!fs.existsSync(pageImagesDir)) {
    return [];
  }

  return fs
    .readdirSync(pageImagesDir)
    .filter((fileName) => /\.(png|jpg|jpeg|webp)$/i.test(fileName))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((fileName, index) => ({
      page: index + 1,
      fileName,
      path: path.join(pageImagesDir, fileName),
    }));
}

function isTesseractAvailable() {
  try {
    execFileSync("tesseract", ["--version"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function getPngDimensions(buffer) {
  if (
    buffer.length >= 24 &&
    buffer.toString("ascii", 1, 4) === "PNG"
  ) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  return null;
}

function getJpegDimensions(buffer) {
  let offset = 2;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      break;
    }

    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);

    if (
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3 ||
      marker === 0xc5 ||
      marker === 0xc6 ||
      marker === 0xc7 ||
      marker === 0xc9 ||
      marker === 0xca ||
      marker === 0xcb ||
      marker === 0xcd ||
      marker === 0xce ||
      marker === 0xcf
    ) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }

    offset += 2 + length;
  }

  return null;
}

function getImageDimensions(imagePath) {
  try {
    const buffer = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();

    if (ext === ".png") {
      return getPngDimensions(buffer);
    }

    if (ext === ".jpg" || ext === ".jpeg") {
      return getJpegDimensions(buffer);
    }

    return null;
  } catch {
    return null;
  }
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldKeepOcrLabel(text, confidence) {
  const normalized = normalizeText(text);

  if (!normalized) return false;
  if (normalized.length < 2) return false;
  if (normalized.length > 80) return false;
  if (Number.isFinite(confidence) && confidence < 35) return false;

  const junk = new Set([
    "|",
    "-",
    "_",
    ".",
    ",",
    ":",
    ";",
    "page",
  ]);

  if (junk.has(normalized.toLowerCase())) return false;

  return true;
}


function isBoilerplateOrNoiseLabel(label) {
  const text = normalizeText(label.text).toLowerCase();

  if (!text) return true;

  const boilerplateTerms = [
    "confidential",
    "unauthorized",
    "disclosure",
    "prohibited",
    "copyright",
    "rights reserved",
    "internal use",
  ];

  if (boilerplateTerms.some((term) => text.includes(term))) {
    return true;
  }

  const stopwords = new Set([
    "a",
    "an",
    "and",
    "or",
    "of",
    "to",
    "in",
    "is",
    "are",
    "the",
    "this",
    "that",
    "for",
    "with",
    "by",
    "on",
    "as",
    "at",
    "be",
    "any",
    "use",
  ]);

  if (stopwords.has(text)) return true;

  // Header/footer zones.
  if (label.y < 0.04 || label.y > 0.96) {
    return true;
  }

  // Tiny OCR fragments.
  if (label.width < 0.01 || label.height < 0.006) {
    return true;
  }

  // Very short low-value lowercase tokens.
  if (text.length <= 2 && !/[0-9]/.test(text)) {
    return true;
  }

  return false;
}

function mergeLabelsIntoPhrases(labels) {
  if (!Array.isArray(labels) || labels.length === 0) {
    return [];
  }

  const sorted = [...labels].sort((a, b) => {
    if (Math.abs(a.y - b.y) > 0.01) {
      return a.y - b.y;
    }

    return a.x - b.x;
  });

  const phrases = [];
  let current = null;

  for (const label of sorted) {
    if (!current) {
      current = {
        labels: [label],
        minX: label.x,
        maxX: label.x + label.width,
        minY: label.y,
        maxY: label.y + label.height,
      };

      continue;
    }

    const sameLine = Math.abs(label.y - current.minY) < 0.012;
    const horizontalGap = label.x - current.maxX;

    const closeEnough = horizontalGap >= 0 && horizontalGap < 0.04;

    if (sameLine && closeEnough) {
      current.labels.push(label);

      current.maxX = Math.max(
        current.maxX,
        label.x + label.width
      );

      current.maxY = Math.max(
        current.maxY,
        label.y + label.height
      );
    } else {
      phrases.push(buildPhraseLabel(current));
      current = {
        labels: [label],
        minX: label.x,
        maxX: label.x + label.width,
        minY: label.y,
        maxY: label.y + label.height,
      };
    }
  }

  if (current) {
    phrases.push(buildPhraseLabel(current));
  }

  return phrases;
}

function buildPhraseLabel(group) {
  const labels = group.labels;

  const first = labels[0];

  const text = labels
    .map((label) => label.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const avgConfidence =
    labels.reduce((sum, label) => {
      return sum + (label.confidence || 0);
    }, 0) / labels.length;

  return {
    id: `${first.id}_phrase`,
    page: first.page,
    text,
    x: Number(group.minX.toFixed(6)),
    y: Number(group.minY.toFixed(6)),
    width: Number((group.maxX - group.minX).toFixed(6)),
    height: Number((group.maxY - group.minY).toFixed(6)),
    confidence: Number(avgConfidence.toFixed(4)),
    source: "ocr_phrase",
    wordCount: labels.length,
  };
}

function buildTextRegionsFromLabels(labels, page) {
  if (!Array.isArray(labels) || labels.length === 0) {
    return [];
  }

  const sorted = [...labels].sort((a, b) => {
    if (Math.abs(a.y - b.y) > 0.02) return a.y - b.y;
    return a.x - b.x;
  });

  const groups = [];
  let current = null;

  for (const label of sorted) {
    if (!current) {
      current = createRegionSeed(label);
      continue;
    }

    const verticalGap = label.y - current.maxY;
    const horizontallyRelated =
      label.x <= current.maxX + 0.12 && label.x + label.width >= current.minX - 0.12;

    if (verticalGap >= 0 && verticalGap < 0.035 && horizontallyRelated) {
      addLabelToRegionSeed(current, label);
    } else {
      groups.push(current);
      current = createRegionSeed(label);
    }
  }

  if (current) groups.push(current);

  return groups
    .filter((group) => group.labels.length >= 2)
    .map((group, index) =>
        addRegionClassification(buildTextRegion(group, page, index + 1))
    );
}


function countMatches(text, patterns) {
  return patterns.reduce((count, pattern) => {
    return count + (pattern.test(text) ? 1 : 0);
  }, 0);
}

function classifyRegion(region) {
  const text = normalizeText(region.textPreview).toLowerCase();

  if (!text) {
    return {
      regionType: "unknown",
      scores: {},
    };
  }

  const scores = {
    wiki_reference: 0,
    runbook_steps: 0,
    configuration: 0,
    architecture_flow: 0,
    table: 0,
    metadata: 0,
  };

  scores.wiki_reference += countMatches(text, [
    /https?:\/\//,
    /\bwww\./,
    /\bgithub\b/,
    /\bwiki\b/,
    /\breadme\b/,
    /\.(com|net|org)\b/,
  ]) * 4;

  scores.runbook_steps += countMatches(text, [
    /\bclick\b/,
    /\bselect\b/,
    /\bopen\b/,
    /\benter\b/,
    /\bchoose\b/,
    /\bnavigate\b/,
    /\bscroll\b/,
    /\blog in\b/,
    /\bsign in\b/,
    /\bstep\s+\d+\b/,
    /\bfrom\s+home\b/,
  ]) * 3;

  scores.configuration += countMatches(text, [
    /\bconfig\b/,
    /\bconfiguration\b/,
    /\bsetting\b/,
    /\bparameter\b/,
    /\bvalue\b/,
    /\bvalues\b/,
    /\bkey\b/,
    /\btoken\b/,
    /\bsecret\b/,
    /\bprofile\b/,
    /\bendpoint\b/,
    /\bfqdn\b/,
    /\bvip\b/,
    /\burl\b/,
    /\buri\b/,
    /\bjson\b/,
    /\byaml\b/,
    /\bxml\b/,
  ]) * 3;

  scores.architecture_flow += countMatches(text, [
    /\barchitecture\b/,
    /\bworkflow\b/,
    /\bingest\b/,
    /\borchestration\b/,
    /\bconnectivity\b/,
    /\bredundancy\b/,
    /\bclient\b/,
    /\bserver\b/,
    /\bservice\b/,
    /\bprovider\b/,
    /\binstance\b/,
    /\bapi\b/,
    /\bhttps\b/,
    /\bhttp\b/,
    /\btcp\b/,
    /\bpush\b/,
    /\bpull\b/,
    /\broute\b/,
    /\brouting\b/,
    /\bsource\b/,
    /\bdestination\b/,
  ]) * 3;

  const numericPatternScore = countMatches(text, [
    /\b\d+x\d+\b/,
    /\b\d{1,3}(\.\d{1,3}){3}\b/,
    /\b\d+\/\d+\b/,
    /\b\d{2,}\b/,
  ]) * 2;

  const looksLikeDelimitedTable =
    region.labelCount >= 4 &&
    numericPatternScore >= 4;

  scores.table += numericPatternScore;

  if (looksLikeDelimitedTable) {
    scores.table += 3;
  }

  scores.metadata += countMatches(text, [
    /\bteam\b/,
    /\bowner\b/,
    /\bownership\b/,
    /\bprogram\b/,
    /\bestimate\b/,
    /\bdate\b/,
    /\bstatus\b/,
    /\bname\b/,
  ]) * 2;

  // Weak contextual nudges only — never direct classification.
  scores.architecture_flow += countMatches(text, [
    /\bcloud\b/,
    /\bplatform\b/,
    /\bdeployment\b/,
    /\binfrastructure\b/,
  ]);

  const personListLike =
    region.labelCount >= 2 &&
    scores.metadata >= 2 &&
    scores.architecture_flow <= 4 &&
    !/\bhttps?\b|\bworkflow\b|\bconnectivity\b|\bclient\b|\bserver\b|\bapi\b|\bhttp\b|\btcp\b/.test(text);

  if (personListLike) {
    scores.metadata += 4;
  }

  const topicListLike =
    region.labelCount >= 2 &&
    /\barchitecture\b|\bworkflow\b|\bingest\b|\bsolutioning\b|\bchannels\b|\bscope\b/.test(text);

  if (topicListLike) {
    scores.metadata += 2;
    scores.table = Math.max(0, scores.table - 2);
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [regionType, score] = sorted[0];

  if (!score || score < 2) {
    return {
      regionType: "unknown",
      scores,
    };
  }

  return {
    regionType,
    scores,
  };
}

function addRegionClassification(region) {
  const classification = classifyRegion(region);

  return {
    ...region,
    regionType: classification.regionType,
    classificationScores: classification.scores,
  };
}


function detectTextConnectorsFromRegion(region) {
  const text = normalizeText(
    region.fullText || region.textPreview
 );
  const lower = text.toLowerCase();

  const connectors = [];

  const hasArrow =
    /(-+>|=+>|→|⇒|➜|➔|——>|-->|>}|-\s*>)/.test(text);

  const hasDirectionWord =
    /\b(to|from|via|through|into|out of|toward|towards|between)\b/.test(lower);

  const hasFlowVerb =
    /\b(sends?|receives?|pushes?|pulls?|routes?|connects?|forwards?|publishes?|consumes?|emits?|writes?|reads?|calls?)\b/.test(lower);

  const hasRolePair =
    /\bclient\b.*\bserver\b|\bsource\b.*\bdestination\b|\bproducer\b.*\bconsumer\b|\binput\b.*\boutput\b/.test(lower);

  const hasProtocolToken =
    /\b(http|https|tcp|udp|grpc|api|webhook|socket)\b/.test(lower);

  const hasSequenceSignal =
    /\bstep\s+\d+\b|\bfirst\b|\bthen\b|\bnext\b|\bfinally\b/.test(lower);

  const signalCount = [
    hasArrow,
    hasDirectionWord,
    hasFlowVerb,
    hasRolePair,
    hasProtocolToken,
    hasSequenceSignal,
  ].filter(Boolean).length;

  if (signalCount === 0) {
    return [];
  }

  let confidence = "low";

  if (hasArrow || signalCount >= 3) {
    confidence = "medium";
  }

  if (hasArrow && signalCount >= 2) {
    confidence = "high";
  }

  connectors.push({
    id: `${region.id}_connector_001`,
    page: region.page,
    regionId: region.id,
    type: "text_flow_signal",
    source: "spatial_text_connector_heuristic",
    confidence,
    signalCount,
    signals: {
      hasArrow,
      hasDirectionWord,
      hasFlowVerb,
      hasRolePair,
      hasProtocolToken,
      hasSequenceSignal,
    },
    textPreview: region.textPreview,
    bounds: region.bounds,
  });

  return connectors;
}

function buildConnectorsFromRegions(regions) {
  if (!Array.isArray(regions) || regions.length === 0) {
    return [];
  }

  return regions.flatMap((region) => detectTextConnectorsFromRegion(region));
}


function buildRelationshipsFromConnectors(connectors) {
  if (!Array.isArray(connectors) || connectors.length === 0) {
    return [];
  }

  return connectors.map((connector, index) => ({
    id: `${connector.regionId}_relationship_${String(index + 1).padStart(3, "0")}`,
    page: connector.page,
    regionId: connector.regionId,
    connectorId: connector.id,
    type: "candidate_flow",
    source: "spatial_text_connector_heuristic",
    confidence: connector.confidence,
    signalCount: connector.signalCount,
    signals: connector.signals,
    evidenceText: normalizeText(connector.textPreview),
    bounds: connector.bounds,
    derivedFrom: [
      {
        type: "connector",
        id: connector.id,
      },
    ],
  }));
}

function createRegionSeed(label) {
  return {
    labels: [label],
    minX: label.x,
    minY: label.y,
    maxX: label.x + label.width,
    maxY: label.y + label.height,
  };
}

function addLabelToRegionSeed(group, label) {
  group.labels.push(label);
  group.minX = Math.min(group.minX, label.x);
  group.minY = Math.min(group.minY, label.y);
  group.maxX = Math.max(group.maxX, label.x + label.width);
  group.maxY = Math.max(group.maxY, label.y + label.height);
}

function buildTextRegion(group, page, index) {
  const padding = 0.015;

  const x = Math.max(0, group.minX - padding);
  const y = Math.max(0, group.minY - padding);
  const maxX = Math.min(1, group.maxX + padding);
  const maxY = Math.min(1, group.maxY + padding);

  return {
    id: `p${page}_region_${String(index).padStart(3, "0")}`,
    page,
    type: "text_cluster",
    source: "ocr_phrase_proximity",
    labelIds: group.labels.map((label) => label.id),
    textPreview: group.labels
      .slice(0, 5)
      .map((label) => label.text)
      .join(" | "),
    fullText: group.labels
        .map((label) => label.text)
        .join(" "),  
    bounds: {
      x: Number(x.toFixed(6)),
      y: Number(y.toFixed(6)),
      width: Number((maxX - x).toFixed(6)),
      height: Number((maxY - y).toFixed(6)),
    },
    labelCount: group.labels.length,
    confidence: Number(
      (
        group.labels.reduce((sum, label) => sum + (label.confidence || 0), 0) /
        group.labels.length
      ).toFixed(4)
    ),
  };
}


function parseTesseractTsv(tsv, { page, imageWidth, imageHeight }) {
  const lines = String(tsv || "").split(/\r?\n/);
  const header = lines.shift();

  if (!header) return [];

  const columns = header.split("\t");
  const indexOf = (name) => columns.indexOf(name);

  const levelIndex = indexOf("level");
  const leftIndex = indexOf("left");
  const topIndex = indexOf("top");
  const widthIndex = indexOf("width");
  const heightIndex = indexOf("height");
  const confIndex = indexOf("conf");
  const textIndex = indexOf("text");

  if (
    leftIndex === -1 ||
    topIndex === -1 ||
    widthIndex === -1 ||
    heightIndex === -1 ||
    confIndex === -1 ||
    textIndex === -1
  ) {
    return [];
  }

  const labels = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    const parts = line.split("\t");
    const level = Number(parts[levelIndex]);
    const rawText = parts.slice(textIndex).join("\t");
    const text = normalizeText(rawText);
    const confidence = Number(parts[confIndex]);

    if (level !== 5) continue;
    if (!shouldKeepOcrLabel(text, confidence)) continue;

    const left = Number(parts[leftIndex]);
    const top = Number(parts[topIndex]);
    const width = Number(parts[widthIndex]);
    const height = Number(parts[heightIndex]);

    if (
      !Number.isFinite(left) ||
      !Number.isFinite(top) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0 ||
      !imageWidth ||
      !imageHeight
    ) {
      continue;
    }

    labels.push({
      id: `p${page}_label_${String(labels.length + 1).padStart(4, "0")}`,
      page,
      text,
      x: Number((left / imageWidth).toFixed(6)),
      y: Number((top / imageHeight).toFixed(6)),
      width: Number((width / imageWidth).toFixed(6)),
      height: Number((height / imageHeight).toFixed(6)),
      confidence: Number((confidence / 100).toFixed(4)),
      source: "tesseract_tsv",
    });
  }

  return labels;
}

function extractOcrLabelsForImage(pageImage) {
  const dimensions = getImageDimensions(pageImage.path);

  if (!dimensions) {
    return {
      labels: [],
      warning: `Could not read image dimensions for ${pageImage.fileName}`,
    };
  }

  try {
    const tsv = execFileSync(
      "tesseract",
      [pageImage.path, "stdout", "--psm", "11", "tsv"],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 20,
      }
    );

    return {
      labels: parseTesseractTsv(tsv, {
        page: pageImage.page,
        imageWidth: dimensions.width,
        imageHeight: dimensions.height,
      }),
      warning: null,
    };
  } catch (error) {
    return {
      labels: [],
      warning: `OCR failed for ${pageImage.fileName}: ${error.message}`,
    };
  }
}

function buildSpatialUnderstanding({ jobDir }) {
  const pageImages = listPageImages(jobDir);
  const tesseractAvailable = isTesseractAvailable();

  const warnings = [];
    let totalRawLabelCount = 0;
    let totalLabelCount = 0;
    let totalRegionCount = 0;
    let totalConnectorCount = 0;
    let totalRelationshipCount = 0;
    let totalFocusCandidateCount = 0;

  const pages = pageImages.map((pageImage) => {
    let rawLabels = [];
    let labels = [];
    let regions = [];
    let connectors = [];
    let relationships = [];
    let focusCandidates = [];

    if (tesseractAvailable) {
      const result = extractOcrLabelsForImage(pageImage);
      rawLabels = result.labels;
      const cleanedLabels = rawLabels.filter(
        (label) => !isBoilerplateOrNoiseLabel(label)
        );

      labels = mergeLabelsIntoPhrases(cleanedLabels);

      regions = buildTextRegionsFromLabels(labels, pageImage.page);
      connectors = buildConnectorsFromRegions(regions);
      relationships = buildRelationshipsFromConnectors(connectors);
      focusCandidates = regions.map((region) => ({
        id: `${region.id}_focus`,
        page: region.page,
        source: "text_region",
        regionId: region.id,
        bounds: region.bounds,
        confidence: region.confidence,
        reason: "Grouped OCR phrase cluster",
        }));

      if (result.warning) {
        warnings.push(result.warning);
      }
    }

    totalRawLabelCount += rawLabels.length;
    totalLabelCount += labels.length;
    totalRegionCount += regions.length;
    totalConnectorCount += connectors.length;
    totalRelationshipCount += relationships.length;
    totalFocusCandidateCount += focusCandidates.length;

    return {
      page: pageImage.page,
      imageFileName: pageImage.fileName,
      imagePath: pageImage.path,

      rawLabels,
      labels,
      regions,
      connectors,
      readingOrder: [],
      focusCandidates,
      relationships,
    };
  });

  return {
    version: "spatial-understanding-v2-ocr-clean-labels",
    source: "page-images",
    ocrUsed: tesseractAvailable,
    ocrEngine: tesseractAvailable ? "tesseract-cli" : null,
    layoutModelUsed: false,
    pages,
    stats: {
      pageCount: pages.length,
      rawLabelCount: totalRawLabelCount,
      labelCount: totalLabelCount,
      regionCount: totalRegionCount,
      connectorCount: totalConnectorCount,
      relationshipCount: totalRelationshipCount,
      focusCandidateCount: totalFocusCandidateCount,
    },
    warnings,
    notes: tesseractAvailable
      ? [
          "OCR raw labels are preserved in rawLabels.",
          "Cleaned OCR labels are exposed in labels.",
          "Coordinates are normalized to page image dimensions.",
          "Regions/connectors/relationships remain empty for later spatial phases.",
        ]
      : [
          "Tesseract CLI not found. Spatial understanding scaffold was generated without OCR labels.",
          "Install Tesseract locally to populate labels in Phase 8C.7A.",
        ],
  };
}

function saveSpatialUnderstanding(jobDir, spatialUnderstanding) {
  const outputPath = path.join(jobDir, "spatial-understanding.json");
  fs.writeFileSync(outputPath, JSON.stringify(spatialUnderstanding, null, 2), "utf8");
  return outputPath;
}

module.exports = {
  buildSpatialUnderstanding,
  saveSpatialUnderstanding,
};