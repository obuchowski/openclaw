/**
 * Tests the automatic-path CLI reseed bridge: when the CLI-reported live usage
 * for a turn exceeds the resolved context-window budget, the CLI session binding
 * is dropped so the next turn rebuilds the backend session from the compacted
 * history (mirror of the manual /compact bridge). No-op otherwise.
 *
 * The bridge operates on the STORE (not runParams.sessionEntry) and, when it
 * decides to reseed, sets `context.reseedCliBindingOverBudget` so the
 * authoritative post-run store write drops the binding as its last action —
 * making the clear overwrite-proof.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import { saveSessionStore } from "../config/sessions/store.js";
import { reseedCliSessionIfOverBudget } from "./cli-runner.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./cli-runner/types.js";
import { getCliSessionBinding, setCliSessionBinding } from "./cli-session.js";

function makeSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  const entry = {
    sessionId: "sess-1",
    updatedAt: Date.now(),
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
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reseed-over-budget-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function seedStore(sessionKey: string, entry: SessionEntry): Promise<void> {
    await saveSessionStore(storePath, { [sessionKey]: entry }, { skipMaintenance: true });
  }

  it("clears the store binding and sets the reseed flag when usage exceeds budget", async () => {
    const sessionKey = "agent:main";
    const entry = makeSessionEntry();
    setCliSessionBinding(entry, "claude-cli", { sessionId: "cli-123", authEpochVersion: 1 });
    await seedStore(sessionKey, entry);

    const context = makeContext({
      budget: 272000,
      provider: "claude-cli",
      // sessionEntry intentionally undefined: the reply-dispatch path frequently
      // does not populate it. The bridge must still work off the store.
      sessionKey,
      storePath,
    });

    await reseedCliSessionIfOverBudget({ context, usageTotal: 408542 });

    // Overwrite-proof signal for the authoritative post-run store write.
    expect(context.reseedCliBindingOverBudget).toBe(true);
    // Belt-and-suspenders in-store clear happened too.
    const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(getCliSessionBinding(persisted!, "claude-cli")).toBeUndefined();
  });

  it("works when runParams.sessionEntry is undefined (store-based, not entry-based)", async () => {
    const sessionKey = "agent:main";
    const entry = makeSessionEntry({ model: "claude-fable-5", modelProvider: "claude-cli" });
    setCliSessionBinding(entry, "claude-cli", { sessionId: "cli-xyz", authEpochVersion: 1 });
    await seedStore(sessionKey, entry);

    const context = makeContext({
      budget: 272000,
      // Display provider disagrees with the binding key; probing must find the
      // binding via the persisted entry's modelProvider.
      provider: "anthropic",
      sessionKey,
      storePath,
    });

    await reseedCliSessionIfOverBudget({ context, usageTotal: 300000 });

    expect(context.reseedCliBindingOverBudget).toBe(true);
    const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(getCliSessionBinding(persisted!, "claude-cli")).toBeUndefined();
  });

  it("also clears an in-memory sessionEntry when one is supplied", async () => {
    const sessionKey = "agent:main";
    const entry = makeSessionEntry();
    setCliSessionBinding(entry, "claude-cli", { sessionId: "cli-mem", authEpochVersion: 1 });
    await seedStore(sessionKey, entry);

    const context = makeContext({
      budget: 272000,
      provider: "claude-cli",
      sessionEntry: entry,
      sessionKey,
      storePath,
    });

    await reseedCliSessionIfOverBudget({ context, usageTotal: 500000 });

    expect(getCliSessionBinding(entry, "claude-cli")).toBeUndefined();
    const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(getCliSessionBinding(persisted!, "claude-cli")).toBeUndefined();
  });

  it("leaves the binding untouched and logs under-budget when usage is at or below budget", async () => {
    const sessionKey = "agent:main";
    const entry = makeSessionEntry();
    setCliSessionBinding(entry, "claude-cli", { sessionId: "cli-keep", authEpochVersion: 1 });
    await seedStore(sessionKey, entry);

    const context = makeContext({
      budget: 272000,
      provider: "claude-cli",
      sessionEntry: entry,
      sessionKey,
      storePath,
    });

    await reseedCliSessionIfOverBudget({ context, usageTotal: 200000 });

    expect(context.reseedCliBindingOverBudget).toBeUndefined();
    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe("cli-keep");
  });

  it("declines with reason=no-usage when usage is unknown or zero (no silent exit)", async () => {
    const sessionKey = "agent:main";
    const entry = makeSessionEntry();
    setCliSessionBinding(entry, "claude-cli", { sessionId: "cli-keep", authEpochVersion: 1 });
    await seedStore(sessionKey, entry);

    const context = makeContext({
      budget: 272000,
      provider: "claude-cli",
      sessionEntry: entry,
      sessionKey,
      storePath,
    });

    await reseedCliSessionIfOverBudget({ context, usageTotal: 0 });
    expect(context.reseedCliBindingOverBudget).toBeUndefined();
    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe("cli-keep");

    await reseedCliSessionIfOverBudget({ context, usageTotal: undefined });
    expect(context.reseedCliBindingOverBudget).toBeUndefined();
    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe("cli-keep");
  });

  it("is a no-op when the budget is unknown", async () => {
    const sessionKey = "agent:main";
    const entry = makeSessionEntry();
    setCliSessionBinding(entry, "claude-cli", { sessionId: "cli-keep", authEpochVersion: 1 });
    await seedStore(sessionKey, entry);

    const context = makeContext({
      provider: "claude-cli",
      sessionEntry: entry,
      sessionKey,
      storePath,
    });

    await reseedCliSessionIfOverBudget({ context, usageTotal: 999999 });

    expect(context.reseedCliBindingOverBudget).toBeUndefined();
    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe("cli-keep");
  });

  it("declines with reason=no-binding when there is no CLI binding to clear", async () => {
    const sessionKey = "agent:main";
    const entry = makeSessionEntry();
    await seedStore(sessionKey, entry);

    const context = makeContext({
      budget: 272000,
      provider: "claude-cli",
      sessionEntry: entry,
      sessionKey,
      storePath,
    });

    await expect(
      reseedCliSessionIfOverBudget({ context, usageTotal: 999999 }),
    ).resolves.toBeUndefined();
    expect(context.reseedCliBindingOverBudget).toBeUndefined();
  });
});
