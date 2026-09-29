import { z } from "zod";
import { randomUUID } from "node:crypto";
import { readFile, open, unlink, readdir } from "node:fs/promises";
import { operations, execute } from "./registry.js";
import {
  AgentError,
  scan,
  hash,
  save,
  load,
  safePath,
  now,
  redact,
  type Context,
} from "./index.js";
const Step = z
  .object({
    id: z.string().regex(/^[\w-]+$/),
    operation: z.string(),
    parameters: z.record(z.unknown()).default({}),
  })
  .strict();
export const Plan = z
  .object({ title: z.string(), steps: z.array(Step).min(1).max(50) })
  .strict();
const validId = (id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw new AgentError("RUN_ID", "Invalid run ID");
  return id;
};
async function fingerprint(ctx: Context) {
  const s = await scan(ctx.root);
  return hash(JSON.stringify(s.files.map((f) => [f.path, f.sha256])));
}
export async function createRun(ctx: Context, file: string) {
  const plan = Plan.parse(
    JSON.parse(await readFile(await safePath(ctx.root, file), "utf8")),
  );
  if (new Set(plan.steps.map((s) => s.id)).size !== plan.steps.length)
    throw new AgentError("PLAN", "Duplicate step IDs");
  for (const s of plan.steps) {
    const op = operations.find(
      (o) => o.name === s.operation || o.command === s.operation,
    );
    if (
      !op ||
      op.destructive ||
      op.command.startsWith("agent ") ||
      op.command.startsWith("confirm") ||
      op.command.startsWith("models ") ||
      op.command === "init" ||
      op.command === "device type" ||
      op.command === "ui type"
    )
      throw new AgentError(
        "PLAN",
        "Workflow step is unknown or requires a separate interactive action",
      );
    op.schema.parse(s.parameters);
  }
  const state = {
    schemaVersion: 1,
    id: randomUUID(),
    title: plan.title,
    createdAt: now(),
    root: ctx.root,
    device: ctx.device ?? null,
    fingerprint: await fingerprint(ctx),
    status: "planned",
    steps: plan.steps.map((s) => ({ ...s, status: "pending", evidence: null })),
    environment: { node: process.version, platform: process.platform },
    provider: null,
  };
  if (ctx.dryRun) return { planned: true, plan };
  await save(ctx.root, `.android-agent/runs/${state.id}.json`, state);
  return state;
}
export async function listRuns(ctx: Context) {
  const dir = await safePath(ctx.root, ".android-agent/runs");
  try {
    return (await readdir(dir))
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -5));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
export async function showRun(ctx: Context, id: string) {
  const state = await load<any>(
    ctx.root,
    `.android-agent/runs/${validId(id)}.json`,
    null,
  );
  if (!state) throw new AgentError("RUN_MISSING", "Run not found");
  return state;
}
export async function resumeRun(ctx: Context, id: string) {
  const state = await showRun(ctx, id);
  if (state.root !== ctx.root || state.device !== (ctx.device ?? null))
    throw new AgentError(
      "RUN_CONTEXT",
      "Project/device differs from saved run",
    );
  if (state.fingerprint !== (await fingerprint(ctx)))
    throw new AgentError(
      "RUN_STALE",
      "Source/configuration changed; create a new run",
    );
  if (ctx.dryRun) return { planned: true, state };
  const lockPath = await safePath(ctx.root, `.android-agent/runs/${id}.lock`);
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new AgentError(
      "RUN_LOCKED",
      "Run is locked. After verifying no process is active, remove the stale .lock file manually.",
    );
  }
  try {
    for (const s of state.steps) {
      if (s.status === "running")
        throw new AgentError(
          "RUN_UNCERTAIN",
          `Interrupted step ${s.id} may have side effects; inspect evidence and create a fresh plan`,
        );
      if (s.status === "complete") {
        if (
          !s.evidence ||
          hash(await readFile(await safePath(ctx.root, s.evidence.path))) !==
            s.evidence.sha256
        )
          throw new AgentError(
            "EVIDENCE_INVALID",
            "Saved step evidence changed or is missing",
          );
        continue;
      }
      const op = operations.find(
        (o) => o.name === s.operation || o.command === s.operation,
      );
      if (s.status === "failed" && op?.mutates)
        throw new AgentError(
          "RUN_UNCERTAIN",
          "Failed mutating step may have partial effects; create a fresh plan after review",
        );
      if (!op || op.destructive)
        throw new AgentError("PLAN", "Saved operation no longer permitted");
      s.status = "running";
      state.status = "running";
      await save(ctx.root, `.android-agent/runs/${id}.json`, state);
      try {
        const result = await execute(ctx, s.operation, s.parameters);
        const relative = `.android-agent/runs/${id}-${s.id}.evidence`;
        await save(ctx.root, relative, { at: now(), result });
        s.evidence = {
          path: relative,
          sha256: hash(await readFile(await safePath(ctx.root, relative))),
        };
        s.status = "complete";
        s.completedAt = now();
      } catch (e) {
        s.status = "failed";
        s.error = redact((e as Error).message);
        state.status = "failed";
        await save(ctx.root, `.android-agent/runs/${id}.json`, state);
        throw e;
      }
      await save(ctx.root, `.android-agent/runs/${id}.json`, state);
    }
    state.status = "complete";
    state.completedAt = now();
    await save(ctx.root, `.android-agent/runs/${id}.json`, state);
    return state;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
