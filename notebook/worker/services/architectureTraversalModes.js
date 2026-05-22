const TRAVERSAL_MODES = {
  REQUEST_LIFECYCLE: "request_lifecycle",
  DEBUGGING_PATH: "debugging_path",
  CONTROL_PLANE: "control_plane",
  PERSISTENCE_PATH: "persistence_path",
  OBSERVABILITY_PATH: "observability_path",
  RCA_PATH: "rca_path",
};

const DEFAULT_TRAVERSAL_MODE = TRAVERSAL_MODES.REQUEST_LIFECYCLE;

const MODE_DEFINITIONS = {
  [TRAVERSAL_MODES.REQUEST_LIFECYCLE]: {
    mode: TRAVERSAL_MODES.REQUEST_LIFECYCLE,
    label: "Request Lifecycle",
    goal: "Explain how a request or interaction moves through the architecture from entry to state or completion.",
    traversalDirection: "forward",
    preferredRegions: [
      "traffic_entry",
      "validation",
      "routing",
      "processing",
      "persistence",
      "recap_or_mental_model",
    ],
    secondaryRegions: [],
    optionalRegions: ["observability", "control"],
    avoidRegions: [],
    cameraBias: "forward_progression",
    continuityStrategy: "preserve_forward_responsibility_flow",
    fallbackPolicy: {
      allowRegionFallback: true,
      allowTitleFallback: true,
      allowSyntheticBridge: false,
      fallbackMustNotInventArchitecture: true,
    },
    confidencePolicy: {
      high: "can_drive_teaching_order",
      medium: "can_support_teaching_order",
      low: "debug_only",
      unknown: "safe_default_only",
    },
  },

  [TRAVERSAL_MODES.DEBUGGING_PATH]: {
    mode: TRAVERSAL_MODES.DEBUGGING_PATH,
    label: "Debugging Path",
    goal: "Explain the architecture as an investigation path for finding likely failure boundaries and dependencies.",
    traversalDirection: "bidirectional",
    preferredRegions: [
      "traffic_entry",
      "validation",
      "routing",
      "processing",
      "persistence",
    ],
    secondaryRegions: ["observability", "control"],
    optionalRegions: ["recap_or_mental_model"],
    avoidRegions: [],
    cameraBias: "investigative_broad_context",
    continuityStrategy: "preserve_dependency_context",
    fallbackPolicy: {
      allowRegionFallback: true,
      allowTitleFallback: true,
      allowSyntheticBridge: false,
      fallbackMustNotInventArchitecture: true,
    },
    confidencePolicy: {
      high: "can_drive_operational_reasoning",
      medium: "can_be_described_with_uncertainty",
      low: "debug_only",
      unknown: "safe_default_only",
    },
  },

  [TRAVERSAL_MODES.CONTROL_PLANE]: {
    mode: TRAVERSAL_MODES.CONTROL_PLANE,
    label: "Control Plane",
    goal: "Explain routing, coordination, validation, orchestration, and control responsibilities.",
    traversalDirection: "forward",
    preferredRegions: ["validation", "routing", "control", "processing"],
    secondaryRegions: ["traffic_entry", "persistence"],
    optionalRegions: ["observability", "recap_or_mental_model"],
    avoidRegions: [],
    cameraBias: "control_flow_context",
    continuityStrategy: "preserve_control_responsibility_chain",
    fallbackPolicy: {
      allowRegionFallback: true,
      allowTitleFallback: true,
      allowSyntheticBridge: false,
      fallbackMustNotInventArchitecture: true,
    },
    confidencePolicy: {
      high: "can_drive_teaching_order",
      medium: "can_support_teaching_order",
      low: "debug_only",
      unknown: "safe_default_only",
    },
  },

  [TRAVERSAL_MODES.PERSISTENCE_PATH]: {
    mode: TRAVERSAL_MODES.PERSISTENCE_PATH,
    label: "Persistence Path",
    goal: "Explain where state, storage, persistence, or durable dependencies appear in the architecture.",
    traversalDirection: "forward",
    preferredRegions: ["processing", "persistence"],
    secondaryRegions: ["routing", "validation"],
    optionalRegions: ["traffic_entry", "recap_or_mental_model"],
    avoidRegions: [],
    cameraBias: "state_dependency_context",
    continuityStrategy: "preserve_state_boundary_context",
    fallbackPolicy: {
      allowRegionFallback: true,
      allowTitleFallback: true,
      allowSyntheticBridge: false,
      fallbackMustNotInventArchitecture: true,
    },
    confidencePolicy: {
      high: "can_drive_teaching_order",
      medium: "can_be_described_with_uncertainty",
      low: "debug_only",
      unknown: "safe_default_only",
    },
  },

  [TRAVERSAL_MODES.OBSERVABILITY_PATH]: {
    mode: TRAVERSAL_MODES.OBSERVABILITY_PATH,
    label: "Observability Path",
    goal: "Explain where signals, monitoring, health, telemetry, or feedback loops appear around the architecture.",
    traversalDirection: "bidirectional",
    preferredRegions: ["observability", "traffic_entry", "routing", "processing"],
    secondaryRegions: ["validation", "persistence", "control"],
    optionalRegions: ["recap_or_mental_model"],
    avoidRegions: [],
    cameraBias: "wide_context_with_signal_paths",
    continuityStrategy: "preserve_signal_and_dependency_context",
    fallbackPolicy: {
      allowRegionFallback: true,
      allowTitleFallback: true,
      allowSyntheticBridge: false,
      fallbackMustNotInventArchitecture: true,
    },
    confidencePolicy: {
      high: "can_drive_operational_reasoning",
      medium: "can_be_described_with_uncertainty",
      low: "debug_only",
      unknown: "safe_default_only",
    },
  },

  [TRAVERSAL_MODES.RCA_PATH]: {
    mode: TRAVERSAL_MODES.RCA_PATH,
    label: "RCA Path",
    goal: "Explain likely responsibility boundaries, dependency chains, blast-radius clues, and investigation order.",
    traversalDirection: "bidirectional",
    preferredRegions: [
      "traffic_entry",
      "validation",
      "routing",
      "processing",
      "persistence",
      "observability",
    ],
    secondaryRegions: ["control"],
    optionalRegions: ["recap_or_mental_model"],
    avoidRegions: [],
    cameraBias: "investigative_boundary_context",
    continuityStrategy: "preserve_cause_effect_dependency_context",
    fallbackPolicy: {
      allowRegionFallback: true,
      allowTitleFallback: true,
      allowSyntheticBridge: false,
      fallbackMustNotInventArchitecture: true,
    },
    confidencePolicy: {
      high: "can_drive_operational_reasoning",
      medium: "can_be_described_with_uncertainty",
      low: "debug_only",
      unknown: "safe_default_only",
    },
  },
};

function getTraversalMode(mode = DEFAULT_TRAVERSAL_MODE) {
  return MODE_DEFINITIONS[mode] || MODE_DEFINITIONS[DEFAULT_TRAVERSAL_MODE];
}

function getDefaultTraversalMode() {
  return getTraversalMode(DEFAULT_TRAVERSAL_MODE);
}

function getAvailableTraversalModes() {
  return Object.values(MODE_DEFINITIONS);
}

function buildTraversalModeMetadata(selectedMode = DEFAULT_TRAVERSAL_MODE) {
  const modeDefinition = getTraversalMode(selectedMode);
  const defaultMode = getDefaultTraversalMode();

  return {
    availableTraversalModes: getAvailableTraversalModes().map((mode) => ({
      mode: mode.mode,
      label: mode.label,
      goal: mode.goal,
      traversalDirection: mode.traversalDirection,
      cameraBias: mode.cameraBias,
    })),
    defaultTraversalMode: defaultMode.mode,
    selectedTraversalMode: modeDefinition.mode,
    selectedTraversalModeLabel: modeDefinition.label,
    traversalModeGoal: modeDefinition.goal,
    traversalDirection: modeDefinition.traversalDirection,
    preferredRegions: modeDefinition.preferredRegions || [],
    secondaryRegions: modeDefinition.secondaryRegions || [],
    optionalRegions: modeDefinition.optionalRegions || [],
    avoidRegions: modeDefinition.avoidRegions || [],
    cameraBias: modeDefinition.cameraBias,
    confidencePolicy: modeDefinition.confidencePolicy || {},
    continuityStrategy: modeDefinition.continuityStrategy,
    fallbackPolicy: modeDefinition.fallbackPolicy || {},
    traversalModeExecution: "metadata_only",
  };
}

module.exports = {
  TRAVERSAL_MODES,
  DEFAULT_TRAVERSAL_MODE,
  MODE_DEFINITIONS,
  getTraversalMode,
  getDefaultTraversalMode,
  getAvailableTraversalModes,
  buildTraversalModeMetadata,
};