import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import type { ModelCompatConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  isFireworksDeepSeekV4ModelId,
  isFireworksGlmReasoningModelId,
  isFireworksGptOss120bModelId,
  isFireworksMinimaxM2ModelId,
} from "./model-id.js";

const FIREWORKS_DEEPSEEK_V4_REASONING_EFFORT_MAP = {
  off: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  adaptive: "high",
  max: "max",
} as const satisfies Record<string, string>;

const FIREWORKS_MINIMAX_M2_REASONING_EFFORT_MAP = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  adaptive: "medium",
  max: "high",
} as const satisfies Record<string, string>;

const FIREWORKS_GLM_REASONING_EFFORT_MAP = {
  off: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  adaptive: "high",
  max: "high",
} as const satisfies Record<string, string>;

const FIREWORKS_GPT_OSS_120B_REASONING_EFFORT_MAP = {
  off: "minimal",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  adaptive: "medium",
  max: "high",
} as const satisfies Record<string, string>;

export function resolveFireworksCompatPatch(
  modelId: string,
): Partial<ModelCompatConfig> | undefined {
  if (isFireworksDeepSeekV4ModelId(modelId)) {
    return {
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      reasoningEffortMap: FIREWORKS_DEEPSEEK_V4_REASONING_EFFORT_MAP,
    };
  }

  if (isFireworksMinimaxM2ModelId(modelId)) {
    return {
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["low", "medium", "high"],
      reasoningEffortMap: FIREWORKS_MINIMAX_M2_REASONING_EFFORT_MAP,
    };
  }

  if (isFireworksGlmReasoningModelId(modelId)) {
    return {
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "low", "medium", "high"],
      reasoningEffortMap: FIREWORKS_GLM_REASONING_EFFORT_MAP,
    };
  }

  if (isFireworksGptOss120bModelId(modelId)) {
    return {
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
      reasoningEffortMap: FIREWORKS_GPT_OSS_120B_REASONING_EFFORT_MAP,
    };
  }

  return undefined;
}

export function applyFireworksModelCompat<T extends ProviderRuntimeModel>(model: T): T {
  const patch = resolveFireworksCompatPatch(model.id);
  if (!patch) {
    return model;
  }

  return {
    ...model,
    compat: {
      ...model.compat,
      ...patch,
    },
  };
}
