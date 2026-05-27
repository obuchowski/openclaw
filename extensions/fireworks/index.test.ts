import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import {
  createProviderDynamicModelContext,
  runSingleProviderCatalog,
} from "../test-support/provider-model-test-helpers.js";
import fireworksPlugin from "./index.js";
import {
  FIREWORKS_BASE_URL,
  FIREWORKS_DEFAULT_CONTEXT_WINDOW,
  FIREWORKS_DEFAULT_MAX_TOKENS,
  FIREWORKS_DEFAULT_MODEL_ID,
  FIREWORKS_K2_6_CONTEXT_WINDOW,
  FIREWORKS_K2_6_MAX_TOKENS,
  FIREWORKS_K2_6_MODEL_ID,
} from "./provider-catalog.js";
import { resolveThinkingProfile } from "./provider-policy-api.js";

function createFireworksDefaultRuntimeModel(params: { reasoning: boolean }): ProviderRuntimeModel {
  return {
    id: FIREWORKS_DEFAULT_MODEL_ID,
    name: FIREWORKS_DEFAULT_MODEL_ID,
    provider: "fireworks",
    api: "openai-completions",
    baseUrl: FIREWORKS_BASE_URL,
    reasoning: params.reasoning,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS,
  };
}

describe("fireworks provider plugin", () => {
  it("registers Fireworks with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "fireworks-api-key",
    });

    expect(provider.id).toBe("fireworks");
    expect(provider.label).toBe("Fireworks");
    expect(provider.aliases).toEqual(["fireworks-ai"]);
    expect(provider.envVars).toEqual(["FIREWORKS_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    if (!resolved) {
      throw new Error("expected Fireworks api-key auth choice");
    }
    expect(resolved.provider.id).toBe("fireworks");
    expect(resolved.method.id).toBe("api-key");
  });

  it("builds the Fireworks catalog", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const catalogProvider = await runSingleProviderCatalog(provider);

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe(FIREWORKS_BASE_URL);
    const models = catalogProvider.models;
    if (!models) {
      throw new Error("expected Fireworks catalog models");
    }
    expect(models.map((model) => model.id)).toEqual([
      FIREWORKS_K2_6_MODEL_ID,
      FIREWORKS_DEFAULT_MODEL_ID,
    ]);
    expect(models[0]?.reasoning).toBe(false);
    expect(models[0]?.input).toEqual(["text", "image"]);
    expect(models[0]?.contextWindow).toBe(FIREWORKS_K2_6_CONTEXT_WINDOW);
    expect(models[0]?.maxTokens).toBe(FIREWORKS_K2_6_MAX_TOKENS);
    expect(models[1]?.reasoning).toBe(false);
    expect(models[1]?.input).toEqual(["text", "image"]);
    expect(models[1]?.contextWindow).toBe(FIREWORKS_DEFAULT_CONTEXT_WINDOW);
    expect(models[1]?.maxTokens).toBe(FIREWORKS_DEFAULT_MAX_TOKENS);
  });

  it("resolves forward-compat Fireworks model ids from the default template", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/qwen3.6-plus",
        models: [createFireworksDefaultRuntimeModel({ reasoning: true })],
      }),
    );

    expect(resolved?.provider).toBe("fireworks");
    expect(resolved?.id).toBe("accounts/fireworks/models/qwen3.6-plus");
    expect(resolved?.api).toBe("openai-completions");
    expect(resolved?.baseUrl).toBe(FIREWORKS_BASE_URL);
    expect(resolved?.reasoning).toBe(true);
  });

  it("adds Fireworks DeepSeek V4 reasoning_effort compat to dynamic models", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/deepseek-v4-pro",
        models: [createFireworksDefaultRuntimeModel({ reasoning: true })],
      }),
    );

    expect(resolved?.reasoning).toBe(true);
    expect(resolved?.compat).toMatchObject({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      reasoningEffortMap: {
        off: "none",
        minimal: "low",
        max: "max",
      },
    });
  });

  it("adds scoped Fireworks reasoning_effort compat for MiniMax M2 and GLM dynamic models", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const minimax = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/minimax-m2.7",
        models: [createFireworksDefaultRuntimeModel({ reasoning: true })],
      }),
    );
    const glm = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/glm-5.1",
        models: [createFireworksDefaultRuntimeModel({ reasoning: true })],
      }),
    );

    expect(minimax?.compat).toMatchObject({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["low", "medium", "high"],
      reasoningEffortMap: {
        minimal: "low",
        max: "high",
      },
    });
    expect(minimax?.compat?.reasoningEffortMap).not.toHaveProperty("off");
    expect(glm?.compat).toMatchObject({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "low", "medium", "high"],
      reasoningEffortMap: {
        off: "none",
        max: "high",
      },
    });
  });

  it("floors Fireworks GPT-OSS 120B reasoning_effort at minimal", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/gpt-oss-120b",
        models: [createFireworksDefaultRuntimeModel({ reasoning: true })],
      }),
    );

    expect(resolved?.compat).toMatchObject({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
      reasoningEffortMap: {
        off: "minimal",
        minimal: "minimal",
        max: "high",
      },
    });
  });

  it("patches configured Fireworks models during resolved-model normalization", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const normalized = provider.normalizeResolvedModel?.({
      provider: "fireworks",
      modelId: "accounts/fireworks/models/deepseek-v4-pro",
      model: {
        ...createFireworksDefaultRuntimeModel({ reasoning: true }),
        id: "accounts/fireworks/models/deepseek-v4-pro",
        compat: { unsupportedToolSchemaKeywords: ["not"] },
      },
    } as never);

    expect(normalized?.compat).toMatchObject({
      unsupportedToolSchemaKeywords: ["not"],
      supportsReasoningEffort: true,
      reasoningEffortMap: {
        off: "none",
      },
    });
  });

  it("disables reasoning metadata for Fireworks Kimi dynamic models", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/kimi-k2p5",
        models: [createFireworksDefaultRuntimeModel({ reasoning: false })],
      }),
    );

    expect(resolved?.provider).toBe("fireworks");
    expect(resolved?.id).toBe("accounts/fireworks/models/kimi-k2p5");
    expect(resolved?.reasoning).toBe(false);
  });

  it("disables reasoning metadata for Fireworks Kimi k2.5 aliases", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/routers/kimi-k2.5-turbo",
        models: [createFireworksDefaultRuntimeModel({ reasoning: false })],
      }),
    );

    expect(resolved?.provider).toBe("fireworks");
    expect(resolved?.id).toBe("accounts/fireworks/routers/kimi-k2.5-turbo");
    expect(resolved?.reasoning).toBe(false);
  });

  it("disables reasoning metadata for Fireworks Kimi k2.6 dynamic models", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/kimi-k2p6",
        models: [createFireworksDefaultRuntimeModel({ reasoning: false })],
      }),
    );

    expect(resolved?.provider).toBe("fireworks");
    expect(resolved?.id).toBe("accounts/fireworks/models/kimi-k2p6");
    expect(resolved?.reasoning).toBe(false);
  });

  it("exposes Fireworks thinking policies for documented reasoning families", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: "accounts/fireworks/routers/kimi-k2p5-turbo",
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on", rank: 20 }],
      defaultLevel: "off",
      preserveWhenCatalogReasoningFalse: true,
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: FIREWORKS_K2_6_MODEL_ID,
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on", rank: 20 }],
      defaultLevel: "off",
      preserveWhenCatalogReasoningFalse: true,
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/deepseek-v4-pro",
      }),
    ).toMatchObject({
      defaultLevel: "high",
      levels: expect.arrayContaining([{ id: "off" }, { id: "max", rank: 80 }]),
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/minimax-m2.7",
      }),
    ).toEqual({
      levels: [
        { id: "low", rank: 20 },
        { id: "medium", rank: 30 },
        { id: "high", rank: 40 },
      ],
      defaultLevel: "medium",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/glm-5.1",
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on", rank: 20 }],
      defaultLevel: "low",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/gpt-oss-120b",
      }),
    ).toEqual({
      levels: [
        { id: "minimal", rank: 10 },
        { id: "low", rank: 20 },
        { id: "medium", rank: 30 },
        { id: "high", rank: 40 },
      ],
      defaultLevel: "minimal",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/qwen3.6-plus",
      }),
    ).toBeUndefined();
    expect(resolveThinkingProfile({ modelId: FIREWORKS_K2_6_MODEL_ID })).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on", rank: 20 }],
      defaultLevel: "off",
      preserveWhenCatalogReasoningFalse: true,
    });
    expect(
      resolveThinkingProfile({
        modelId: "accounts/fireworks/models/qwen3.6-plus",
      }),
    ).toBeUndefined();
  });
});
