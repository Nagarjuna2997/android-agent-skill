import { readFile, readdir, lstat, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  safePath,
  checked,
  evidence,
  hash,
  authorize,
  AgentError,
  type Context,
} from "../core/index.js";
import { xml, array } from "../android/inspect.js";
export async function gradle(ctx: Context, action: string, p: any = {}) {
  const variant = p.variant ?? "Debug";
  if (!/^[A-Za-z][\w]*$/.test(variant))
    throw new AgentError("INPUT", "Invalid variant");
  const module = p.module ?? "";
  if (module && !/^:[\w-]+(?::[\w-]+)*$/.test(module))
    throw new AgentError("INPUT", "Module must be :app or :parent:child");
  const tasks: Record<string, string> = {
    build: `assemble${variant}`,
    bundle: `bundle${variant}`,
    clean: "clean",
    lint: `lint${variant}`,
    test: `test${variant}UnitTest`,
    unit: `test${variant}UnitTest`,
    instrumented: `connected${variant}AndroidTest`,
    compose: `connected${variant}AndroidTest`,
    dependencies: "dependencies",
    diagnose: "help",
    versions: "--version",
  };
  const task = tasks[action];
  if (!task) throw new AgentError("ACTION", "Unknown Gradle action");
  if (action === "clean") await authorize(ctx, "gradle.clean", { module });
  const wrapper = await safePath(
    ctx.root,
    process.platform === "win32" ? "gradlew.bat" : "gradlew",
  );
  try {
    await stat(wrapper);
  } catch {
    throw new AgentError(
      "GRADLE_WRAPPER",
      "Project wrapper missing; generate/review a wrapper first",
    );
  }
  if (process.platform === "win32")
    throw new AgentError(
      "UNSUPPORTED_PLATFORM",
      "Gradle execution on Windows requires a reviewed native launcher; use WSL. Inspection and device commands remain available.",
    );
  const args = [
    module && action !== "versions" ? `${module}:${task}` : task,
    "--console=plain",
    "--no-daemon",
  ];
  if (ctx.dryRun)
    return {
      planned: true,
      command: wrapper,
      args,
      mutates: true,
      trust: "Gradle executes project code",
    };
  const started = Date.now();
  const r = await ctx.runner(wrapper, args, {
    cwd: ctx.root,
    timeout: ctx.timeout ?? 600000,
  });
  const artifacts: any[] = [],
    suites: any[] = [];
  async function collect(dir: string, depth = 0): Promise<void> {
    if (depth > 12 || artifacts.length > 100 || suites.length > 1000) return;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (
        e.isSymbolicLink() ||
        [".git", "node_modules", ".gradle", ".android-agent"].includes(e.name)
      )
        continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await collect(full, depth + 1);
      else if (e.isFile() && /\.(apk|aab|xml)$/.test(e.name)) {
        const s = await lstat(full);
        if (s.mtimeMs < started - 1000) continue;
        const path = relative(ctx.root, full);
        if (/\.(apk|aab)$/.test(e.name) && path.includes("outputs")) {
          artifacts.push({
            path,
            sha256: hash(await readFile(full)),
            bytes: s.size,
          });
        } else if (e.name.startsWith("TEST-") && s.size < 2000000) {
          try {
            const doc = xml(await readFile(full, "utf8"));
            for (const t of array(doc.testsuite ?? doc.testsuites?.testsuite))
              suites.push({
                path,
                tests: Number(t.tests ?? 0),
                failures: Number(t.failures ?? 0),
                errors: Number(t.errors ?? 0),
                skipped: Number(t.skipped ?? 0),
              });
          } catch {
            /* not a JUnit report */
          }
        }
      }
    }
  }
  await collect(ctx.root);
  const result = {
    ...r,
    artifacts,
    testSummary: suites.length
      ? {
          tests: suites.reduce((s, t) => s + t.tests, 0),
          failures: suites.reduce((s, t) => s + t.failures + t.errors, 0),
          suites,
        }
      : null,
    note: "Only reports/artifacts modified during this invocation are listed; cached outputs may be omitted.",
  };
  const proof = await evidence(ctx, `gradle.${action}`, result);
  checked(r);
  return { ...result, evidence: proof };
}
