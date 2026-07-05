/**
 * Tests the automatic-path CLI reseed bridge: when the CLI-reported live usage
 * for a turn exceeds the resolved context-window budget, the CLI session binding
 * is cleared so the next turn rebuilds the backend session from the compacted
 * history (mirror of the manual /compact bridge). No-op otherwise.
 */
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { reseedCliSessionIfOverBudget } from "./cli-runner.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./cli-runner/types.js";
import { getCliSessionBinding, setCliSessionBinding } from "./cli-session.js";

function makeSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  const entry = {
    sessionId: "sess-1",
    updatedAt: 1,
    ...overrides,
  } as SessionEntry;
  return entry;
}

function makeContext(params: {
  budget?: number;
  provider: string;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
}): PreparedCliRunContext {
  const runParams = {
    provider: params.provider,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  } as unknown as RunCliAgentParams;
  return {
    params: runParams,
    contextWindowInfo:
      typeof params.budget === "number"
        ? { tokens: params.budget, source: "catalog" as const }
        : undefined,
  } as unknown as PreparedCliRunContext;
}

describe("reseedCliSessionIfOverBudget", () => {
  it("clears the CLI binding when usage exceeds the resolved budget", async () => {
    const entry = makeSessionEntry();
    setCliSessionBinding(entry, "claude-cli", { sessionId: "cli-123", authEpochVersion: 1 });
    expect(getCliSessionBinding(entry, "claude-cli")).toBeDefined();

    const context = makeContext({
      budget: 272000,
      provider: "claude-cli",
      sessionEntry: entry,
      sessionKey: "agent:main",
      // No storePath: exercise the in-memory clear only (skips file I/O).
    });

    await reseedCliSessionIfOverBudget({ context, usageTotal: 366000 });

    expect(getCliSessionBinding(entry, "claude-cli")).toBeUndefined();
  });

  it("probes the session entry modelProvider when the run provider disagrees", async () => {
    // Display provider "anthropic" vs binding key "claude-cli" (per 0dbfb1a5a4).
    const entry = makeSessionEntry({ modelProvider: "claude-cli" });
    setCliSessionBinding(entry, "claude-cli", { sessionId: "cli-abc", authEpochVersion: 1 });

    const context = makeContext({
      budget: 272000,
      provider: "anthropic",
      sessionEntry: entry,
      sessionKey: "agent:main",
    });

    await reseedCliSessionIfOverBudget({ context, usageTotal: 300000 });

    expect(getCliSessionBinding(entry, "claude-cli")).toBeUndefined();
  });

  it("leaves the binding untouched when usage is at or below budget", async () => {
    const entry = makeSessionEntry();
    setCliSessionBinding(entry, "claude-cli", { sessionId: "cli-keep", authEpochVersion: 1 });

    const context = makeContext({
      budget: 272000,
      provider: "claude-cli",
      sessionEntry: entry,
      sessionKey: "agent:main",
    });

    await reseedCliSessionIfOverBudget({ context, usageTotal: 200000 });

    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe("cli-keep");
  });

  it("is a no-op when the budget is unknown", async () => {
    const entry = makeSessionEntry();
    setCliSessionBinding(entry, "claude-cli", { sessionId: "cli-keep", authEpochVersion: 1 });

    const context = makeContext({
      provider: "claude-cli",
      sessionEntry: entry,
      sessionKey: "agent:main",
    });

    await reseedCliSessionIfOverBudget({ context, usageTotal: 999999 });

    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe("cli-keep");
  });

  it("is a no-op when usage is unknown or zero", async () => {
    const entry = makeSessionEntry();
    setCliSessionBinding(entry, "claude-cli", { sessionId: "cli-keep", authEpochVersion: 1 });

    const context = makeContext({
      budget: 272000,
      provider: "claude-cli",
      sessionEntry: entry,
      sessionKey: "agent:main",
    });

    await reseedCliSessionIfOverBudget({ context, usageTotal: 0 });
    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe("cli-keep");

    await reseedCliSessionIfOverBudget({ context, usageTotal: undefined });
    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe("cli-keep");
  });

  it("is a no-op when there is no CLI binding to clear", async () => {
    const entry = makeSessionEntry();
    const context = makeContext({
      budget: 272000,
      provider: "claude-cli",
      sessionEntry: entry,
      sessionKey: "agent:main",
    });

    await expect(
      reseedCliSessionIfOverBudget({ context, usageTotal: 999999 }),
    ).resolves.toBeUndefined();
    expect(getCliSessionBinding(entry, "claude-cli")).toBeUndefined();
  });
});
