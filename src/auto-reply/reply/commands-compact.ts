// Implements compaction commands for session context and model state.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { clearCliSession, getCliSessionBinding } from "../../agents/cli-session.js";
import { resolveAnthropicFixedContextWindow } from "../../agents/context-resolution.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { classifyCompactionReason } from "../../agents/embedded-agent-runner/compact-reasons.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import {
  OPENAI_CODEX_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  resolveContextConfigProviderForRuntime,
} from "../../agents/openai-routing.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CommandHandler } from "./commands-types.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";

const compactRuntimeLoader = createLazyImportLoader(() => import("./commands-compact.runtime.js"));

function loadCompactRuntime(): Promise<typeof import("./commands-compact.runtime.js")> {
  return compactRuntimeLoader.load();
}

function extractCompactInstructions(params: {
  rawBody?: string;
  ctx: import("../templating.js").MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  isGroup: boolean;
}): string | undefined {
  const raw = stripStructuralPrefixes(params.rawBody ?? "");
  const stripped = params.isGroup
    ? stripMentions(raw, params.ctx, params.cfg, params.agentId)
    : raw;
  const trimmed = stripped.trim();
  if (!trimmed) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  const prefix = lowered.startsWith("/compact") ? "/compact" : null;
  if (!prefix) {
    return undefined;
  }
  let rest = trimmed.slice(prefix.length).trimStart();
  if (rest.startsWith(":")) {
    rest = rest.slice(1).trimStart();
  }
  return rest.length ? rest : undefined;
}

function isCompactionSkipReason(reason?: string): boolean {
  const classification = classifyCompactionReason(reason);
  // Manual /compact mirrors preflight semantics: already-small sessions are a
  // successful no-op, not a failed compaction.
  return (
    classification === "no_compactable_entries" ||
    classification === "below_threshold" ||
    classification === "already_compacted_recently"
  );
}

function formatCompactionReason(reason?: string): string | undefined {
  const text = normalizeOptionalString(reason);
  if (!text) {
    return undefined;
  }

  const classification = classifyCompactionReason(reason);
  const lower = normalizeLowercaseStringOrEmpty(reason);
  switch (classification) {
    case "no_compactable_entries":
      return "nothing compactable in this session yet";
    case "below_threshold":
      return lower.includes("already under target")
        ? "context is already under the compaction target"
        : "context is below the compaction threshold";
    case "already_compacted_recently":
      return "session was already compacted recently";
    default:
      return text;
  }
}

function resolveManualCompactContextTokenBudget(params: {
  cfg: OpenClawConfig;
  provider?: string;
  model?: string;
  agentId: string;
  sessionKey: string;
  liveContextTokens?: number;
  persistedContextTokens?: number;
}): number | undefined {
  const liveContextTokens =
    typeof params.liveContextTokens === "number" &&
    Number.isFinite(params.liveContextTokens) &&
    params.liveContextTokens > 0
      ? Math.floor(params.liveContextTokens)
      : undefined;

  const model = normalizeOptionalString(params.model);
  const provider = normalizeOptionalString(params.provider);
  if (!model || !provider) {
    return liveContextTokens ?? resolvePersistedContextTokens(params.persistedContextTokens);
  }

  const harnessPolicy = resolveAgentHarnessPolicy({
    provider,
    modelId: model,
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const contextConfigProvider = resolveContextConfigProviderForRuntime({
    provider,
    runtimeId: harnessPolicy.runtime,
    config: params.cfg,
  });
  // Models with a fixed Anthropic window (claude-cli + fable): this ad-hoc
  // chain used to fall through to the 128k catalog default, which then CAPPED
  // compact.queued's correct full resolution via Math.min(requested, resolved).
  // resolveContextWindowInfo (used by compact.queued and the live-turn path)
  // already resolves these models correctly (fixed window capped by catalog,
  // e.g. 272k for fable on this host) — defer to it instead of guessing here.
  const fixedContextWindow = resolveAnthropicFixedContextWindow(
    normalizeProviderId(provider),
    model,
  );
  if (typeof fixedContextWindow === "number" && fixedContextWindow > 0) {
    // Prefer the session-tracked window (live or persisted contextTokens, e.g.
    // 272k recorded by the CLI runner) — the catalog chain below would return
    // the 128k default for these models. Deferring entirely does not help:
    // compact.queued's own resolver also misses CLI-lane models.
    return liveContextTokens ?? resolvePersistedContextTokens(params.persistedContextTokens);
  }
  const configuredContextTokens = resolveContextTokensForModel({
    cfg: params.cfg,
    provider: contextConfigProvider,
    model: resolveManualCompactContextModelId({
      provider,
      contextConfigProvider,
      model,
    }),
    allowAsyncLoad: false,
  });
  if (typeof configuredContextTokens === "number" && configuredContextTokens > 0) {
    const configuredBudget = Math.floor(configuredContextTokens);
    return liveContextTokens !== undefined
      ? Math.min(liveContextTokens, configuredBudget)
      : configuredBudget;
  }

  if (liveContextTokens !== undefined) {
    return liveContextTokens;
  }

  return resolvePersistedContextTokens(params.persistedContextTokens);
}

function resolvePersistedContextTokens(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function resolveManualCompactContextModelId(params: {
  provider: string;
  contextConfigProvider: string;
  model: string;
}): string {
  const model = params.model.trim();
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0) {
    return model;
  }

  const modelProvider = normalizeProviderId(model.slice(0, slashIndex));
  const selectedProvider = normalizeProviderId(params.provider);
  const contextConfigProvider = normalizeProviderId(params.contextConfigProvider);
  const modelId = model.slice(slashIndex + 1).trim();
  if (!modelId) {
    return model;
  }

  if (
    modelProvider === selectedProvider ||
    modelProvider === contextConfigProvider ||
    (modelProvider === OPENAI_PROVIDER_ID && contextConfigProvider === OPENAI_CODEX_PROVIDER_ID)
  ) {
    return modelId;
  }

  return model;
}

export const handleCompactCommand: CommandHandler = async (params) => {
  const compactRequested =
    params.command.commandBodyNormalized === "/compact" ||
    params.command.commandBodyNormalized.startsWith("/compact ");
  if (!compactRequested) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /compact from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  if (!targetSessionEntry?.sessionId) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚙️ Compaction unavailable (missing session id).",
        isStatusNotice: true,
      },
    };
  }
  const runtime = await loadCompactRuntime();
  const sessionId = targetSessionEntry.sessionId;
  if (runtime.isEmbeddedAgentRunAbortableForCompaction(sessionId)) {
    runtime.abortEmbeddedAgentRun(sessionId);
    await runtime.waitForEmbeddedAgentRunEnd(sessionId, 15_000);
  }
  const sessionAgentId = params.sessionKey
    ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
    : (params.agentId ?? "main");
  const currentAgentId = params.agentId ?? "main";
  const sessionAgentDir =
    sessionAgentId === currentAgentId && params.agentDir
      ? params.agentDir
      : resolveAgentDir(params.cfg, sessionAgentId);
  const customInstructions = extractCompactInstructions({
    rawBody: params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body,
    ctx: params.ctx,
    cfg: params.cfg,
    agentId: sessionAgentId,
    isGroup: params.isGroup,
  });
  const contextTokenBudget = resolveManualCompactContextTokenBudget({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    liveContextTokens: params.contextTokens,
    persistedContextTokens: targetSessionEntry.contextTokens,
  });
  const result = await runtime.compactEmbeddedAgentSession({
    abortSignal: params.opts?.abortSignal,
    sessionId,
    sessionKey: params.sessionKey,
    allowGatewaySubagentBinding: true,
    messageChannel: params.command.channel,
    groupId: targetSessionEntry.groupId,
    groupChannel: targetSessionEntry.groupChannel,
    groupSpace: targetSessionEntry.space,
    spawnedBy: targetSessionEntry.spawnedBy,
    senderId: params.command.senderId,
    senderName: params.ctx.SenderName,
    senderUsername: params.ctx.SenderUsername,
    senderE164: params.ctx.SenderE164,
    sessionFile: runtime.resolveSessionFilePath(
      sessionId,
      targetSessionEntry,
      runtime.resolveSessionFilePathOptions({
        agentId: sessionAgentId,
        storePath: params.storePath,
      }),
    ),
    workspaceDir: params.workspaceDir,
    agentDir: sessionAgentDir,
    config: params.cfg,
    skillsSnapshot: targetSessionEntry.skillsSnapshot,
    provider: params.provider,
    model: params.model,
    authProfileId: targetSessionEntry.authProfileOverride,
    contextTokenBudget,
    agentHarnessId:
      targetSessionEntry.sessionId === sessionId ? targetSessionEntry.agentHarnessId : undefined,
    thinkLevel: params.resolvedThinkLevel ?? (await params.resolveDefaultThinkingLevel()),
    bashElevated: {
      enabled: false,
      allowed: false,
      defaultLevel: "off",
    },
    customInstructions,
    trigger: "manual",
    ownerNumbers: params.command.ownerList.length > 0 ? params.command.ownerList : undefined,
  });

  let compactLabel =
    result.ok || isCompactionSkipReason(result.reason)
      ? result.compacted
        ? result.result?.tokensBefore != null && result.result?.tokensAfter != null
          ? `Compacted (${runtime.formatTokenCount(result.result.tokensBefore)} → ${runtime.formatTokenCount(result.result.tokensAfter)})`
          : result.result?.tokensBefore
            ? `Compacted (${runtime.formatTokenCount(result.result.tokensBefore)} before)`
            : "Compacted"
        : "Compaction skipped"
      : "Compaction failed";
  if (result.ok && result.compacted) {
    await runtime.incrementCompactionCount({
      cfg: params.cfg,
      sessionEntry: targetSessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      // Update token counts after compaction
      tokensAfter: result.result?.tokensAfter,
      newSessionId: result.result?.sessionId,
      newSessionFile: result.result?.sessionFile,
    });
  }
  // CLI backends (claude-cli etc.) keep their own transcript and only pick up
  // the compacted OpenClaw history when the session reseeds — resolveCliSessionReuse
  // has no compaction-based invalidation, so without this the live CLI window
  // keeps growing no matter how well the context engine compacts its stored view.
  // On a manual /compact, drop the CLI binding whenever the stored view is in a
  // compacted state (freshly compacted or already under target) so the next turn
  // rebuilds the CLI session from the compacted history.
  const compactedStateReasonClass = classifyCompactionReason(result.reason);
  // "live context still exceeds target" is returned with ok=false, but on CLI
  // lanes it is exactly the state a reseed resolves: the stored view is as
  // compact as it gets and only the CLI backend's own transcript keeps the live
  // window over target. Treat it as a reseed trigger despite the failure flag.
  const storedViewCompact =
    result.compacted ||
    compactedStateReasonClass === "below_threshold" ||
    compactedStateReasonClass === "already_compacted_recently" ||
    compactedStateReasonClass === "live_context_still_exceeds_target";
  // The command context and the session entry can disagree on the provider id
  // (display provider "anthropic" vs the binding key "claude-cli") — probe both
  // before concluding there is no CLI binding to reseed.
  const cliBindingProviderCandidates = [
    normalizeOptionalString(params.provider),
    normalizeOptionalString(targetSessionEntry.modelProvider),
  ].filter((value): value is string => value !== undefined);
  const cliBindingProvider = cliBindingProviderCandidates.find(
    (candidate) => getCliSessionBinding(targetSessionEntry, candidate) !== undefined,
  );
  const cliSessionReseedScheduled =
    (result.ok || compactedStateReasonClass === "live_context_still_exceeds_target") &&
    storedViewCompact &&
    cliBindingProvider !== undefined;
  if (!cliSessionReseedScheduled && storedViewCompact) {
    logVerbose(
      `compact: no CLI binding to reseed (candidates=${cliBindingProviderCandidates.join(",") || "<none>"} bindings=${Object.keys(targetSessionEntry.cliSessionBindings ?? {}).join(",") || "<none>"})`,
    );
  }
  if (cliSessionReseedScheduled && cliBindingProvider) {
    const now = Date.now();
    clearCliSession(targetSessionEntry, cliBindingProvider);
    targetSessionEntry.updatedAt = now;
    if (params.sessionStore && params.sessionKey) {
      params.sessionStore[params.sessionKey] = targetSessionEntry;
    }
    if (params.storePath && params.sessionKey) {
      await updateSessionEntry(
        {
          storePath: params.storePath,
          sessionKey: params.sessionKey,
        },
        async (entry) => {
          const next = { ...entry };
          clearCliSession(next, cliBindingProvider);
          return {
            cliSessionBindings: next.cliSessionBindings,
            cliSessionIds: next.cliSessionIds,
            claudeCliSessionId: next.claudeCliSessionId,
            updatedAt: now,
          };
        },
      );
    }
    logVerbose(
      `compact: cleared CLI session binding provider=${cliBindingProvider} sessionKey=${params.sessionKey} (reseed from compacted history on next turn)`,
    );
  }
  // Use the post-compaction token count for context summary if available
  const tokensAfterCompaction = result.result?.tokensAfter;
  const totalTokens =
    result.ok && result.compacted
      ? tokensAfterCompaction
      : runtime.resolveFreshSessionTotalTokens(targetSessionEntry);
  const contextSummary = runtime.formatContextUsageShort(
    typeof totalTokens === "number" && totalTokens > 0 ? totalTokens : null,
    contextTokenBudget ?? null,
  );
  let reason = formatCompactionReason(result.reason);
  if (cliSessionReseedScheduled && !result.ok) {
    // The reseed resolves the "live context still exceeds target" state; do not
    // report it as a failure once the reseed is scheduled.
    compactLabel = "Compacted";
    reason = undefined;
  }
  const reseedNote = cliSessionReseedScheduled
    ? " • CLI session reseeds from compacted history next turn"
    : "";
  const line = reason
    ? `${compactLabel}: ${reason} • ${contextSummary}${reseedNote}`
    : `${compactLabel} • ${contextSummary}${reseedNote}`;
  runtime.enqueueSystemEvent(line, { sessionKey: params.sessionKey });
  return {
    shouldContinue: false,
    reply: {
      text: `⚙️ ${line}`,
      isStatusNotice: true,
    },
  };
};
