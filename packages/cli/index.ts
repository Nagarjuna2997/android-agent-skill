#!/usr/bin/env node
import { Command, Option } from "commander";
import { operations, execute } from "../core/registry.js";
import {
  run,
  rootPath,
  AgentError,
  redact,
  type Context,
} from "../core/index.js";
import { serve } from "../mcp/index.js";
import { createRun, listRuns, showRun, resumeRun } from "../core/runs.js";
const cli = new Command()
  .name("android-agent")
  .description(
    "Local-first Android engineering tools. Gradle executes project code; use trusted repositories.",
  )
  .version("0.1.0")
  .option("--project <path>", "project root", process.cwd())
  .option("--device <serial>", "explicit ADB serial")
  .option("--json", "machine-readable output")
  .option("--dry-run", "preview actions")
  .option("--confirm <fingerprint>", "single-use approved action fingerprint")
  .option("--timeout <milliseconds>", "process deadline", (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 1800000)
      throw Error("Timeout must be 1..1800000 ms");
    return n;
  })
  .option("--quiet", "suppress successful output")
  .option("--verbose", "show error details");
cli.exitOverride();
async function context(): Promise<Context> {
  const o = cli.opts();
  return {
    root: await rootPath(o.project),
    device: o.device,
    dryRun: o.dryRun,
    confirm: o.confirm,
    timeout: o.timeout,
    runner: run,
  };
}
function output(result: any) {
  const o = cli.opts();
  if (o.json) console.log(JSON.stringify({ ok: true, result }));
  else if (!o.quiet) console.log(JSON.stringify(result, null, 2));
  if (result?.ready === false) process.exitCode = 1;
}
const commands = new Map<string, Command>([["", cli]]);
function command(path: string): Command {
  if (commands.has(path)) return commands.get(path)!;
  const parts = path.split(" "),
    leaf = parts.pop()!,
    parent = command(parts.join(" "));
  const c = parent.command(leaf);
  commands.set(path, c);
  return c;
}
for (const op of operations) {
  const cmd = command(op.command).description(op.description);
  for (const [name, field] of Object.entries<any>(op.schema.shape)) {
    const flag = "--" + name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
    let base = field;
    while (base._def?.innerType) base = base._def.innerType;
    const bool = base._def?.typeName === "ZodBoolean",
      arr = base._def?.typeName === "ZodArray";
    cmd.addOption(
      new Option(
        bool ? flag : `${flag} <${name}${arr ? "..." : ""}>`,
        `${name}${field.isOptional() ? " (optional)" : ""}`,
      ),
    );
  }
  cmd.action(async () => {
    output(await execute(await context(), op.name, cmd.opts()));
  });
}
// Familiar parent commands delegate only when they have a safe, documented default.
for (const [parent, child] of [
  ["devices", "list"],
  ["emulator", "list"],
  ["confirmations", "list"],
  ["models", "current"],
])
  command(parent).action(async () =>
    output(await execute(await context(), `${parent} ${child}`, {})),
  );
command("mcp")
  .description("Start stdio MCP server scoped to --project")
  .option(
    "--allow-mutations",
    "enable mutating tools; destructive grants remain separate",
  )
  .action(async (_opts, cmd) => {
    await serve(await context(), cmd.opts().allowMutations);
  });
for (const action of ["create", "list", "show", "resume"]) {
  const c = command("runs " + action).description(
    `${action} persisted deterministic workflow`,
  );
  if (action === "create") c.requiredOption("--file <path>", "plan JSON");
  if (["show", "resume"].includes(action))
    c.requiredOption("--id <id>", "run ID");
  c.action(async () => {
    const ctx = await context(),
      p = c.opts();
    output(
      await (action === "create"
        ? createRun(ctx, p.file)
        : action === "list"
          ? listRuns(ctx)
          : action === "show"
            ? showRun(ctx, p.id)
            : resumeRun(ctx, p.id)),
    );
  });
}
try {
  await cli.parseAsync();
} catch (e: any) {
  if (e.code === "commander.helpDisplayed" || e.code === "commander.version") {
  } else {
    const error = {
      code: e instanceof AgentError ? e.code : (e.code ?? "ERROR"),
      message: redact(e.message),
      ...(e instanceof AgentError ? { details: e.details } : {}),
    };
    if (cli.opts().json) console.log(JSON.stringify({ ok: false, error }));
    else
      console.error(
        cli.opts().verbose
          ? JSON.stringify(error, null, 2)
          : `${error.code}: ${error.message}`,
      );
    process.exitCode = 1;
  }
}
