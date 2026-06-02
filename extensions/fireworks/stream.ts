import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream-shared";
import { isFireworksKimiModelId } from "./model-id.js";

function isFireworksProviderId(providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  return normalized === "fireworks" || normalized === "fireworks-ai";
}

export function createFireworksKimiThinkingDisabledWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  return createFireworksKimiThinkingWrapper(baseStreamFn, "off");
}

export function createFireworksKimiThinkingWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      const thinkingType = !thinkingLevel || thinkingLevel === "off" ? "disabled" : "enabled";
      payloadObj.thinking = { type: thinkingType };
      delete payloadObj.reasoning;
      delete payloadObj.reasoning_effort;
      delete payloadObj.reasoningEffort;
    });
}

export function wrapFireworksProviderStream(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | undefined {
  if (
    !isFireworksProviderId(ctx.provider) ||
    (ctx.model && ctx.model.api !== "openai-completions") ||
    !isFireworksKimiModelId(ctx.modelId)
  ) {
    return undefined;
  }
  return createFireworksKimiThinkingWrapper(ctx.streamFn, ctx.thinkingLevel);
}
