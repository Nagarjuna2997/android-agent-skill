import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { inspect } from "../android/inspect.js";
import { audit, versions, crashAnalyze } from "../analysis/index.js";
import {
  devices,
  deviceAction,
  uiInspect,
  uiTap,
  adb,
  validPackage,
} from "../adb/index.js";
import { emulator } from "../emulator/index.js";
import { gradle } from "../gradle/index.js";
import { doctor } from "./doctor.js";
import { docsSearch } from "../docs/index.js";
import {
  renderScreenshot,
  validateScreenshot,
  exportScreenshots,
} from "../screenshots/index.js";
import {
  orchestrate,
  ProviderConfig,
  providerNames,
} from "../providers/index.js";
import {
  AgentError,
  safePath,
  save,
  load,
  redact,
  evidence,
  type Context,
} from "./index.js";
export interface Operation {
  name: string;
  command: string;
  description: string;
  mutates: boolean;
  destructive: boolean;
  schema: z.AnyZodObject;
  run: (ctx: Context, p: any) => Promise<any>;
}
export const operations: Operation[] = [];
const add = (
  command: string,
  description: string,
  schema: z.ZodRawShape,
  run: Operation["run"],
  mutates = false,
  destructive = false,
  name?: string,
) =>
  operations.push({
    name: name ?? "android_" + command.replaceAll(" ", "_"),
    command,
    description,
    mutates,
    destructive,
    schema: z.object(schema).strict(),
    run,
  });
const str = z.string().min(1),
  num = z.coerce.number().int().nonnegative();
add(
  "inspect",
  "Inspect static Android project graph",
  {},
  (c) => inspect(c.root),
  false,
  false,
  "android_project_inspect",
);
add("doctor", "Check installed Android tooling", {}, doctor);
add(
  "capabilities",
  "List implemented operations and boundaries",
  {},
  async () => ({
    operations: operations.map(({ run: _run, schema: _schema, ...o }) => o),
    platforms: {
      genericAdb: [
        "phone",
        "tablet",
        "foldable",
        "wear",
        "tv",
        "automotive",
        "chromeos",
        "xr",
      ],
      verifiedDevices: [],
      note: "ADB transport is generic; specialized platform test suites are not implemented.",
    },
  }),
);
for (const action of ["build", "clean", "lint", "test"])
  add(
    action,
    `Run project Gradle ${action}`,
    { variant: str.optional(), module: str.optional() },
    (c, p) => gradle(c, action, p),
    true,
    action === "clean",
    `android_project_${action}`,
  );
for (const action of ["unit", "instrumented", "compose"])
  add(
    `test ${action}`,
    `Run Gradle ${action} tests`,
    { variant: str.optional(), module: str.optional() },
    (c, p) => gradle(c, action, p),
    true,
  );
add("gradle inspect", "Inspect Gradle declarations", {}, async (c) => {
  const g = await inspect(c.root);
  return {
    modules: g.modules,
    dependencies: g.dependencies,
    versions: g.versions,
    limitations: g.limitations,
  };
});
for (const action of ["diagnose", "dependencies"])
  add(
    `gradle ${action}`,
    `Execute Gradle ${action} (executes project build code)`,
    { module: str.optional() },
    (c, p) => gradle(c, action, p),
    true,
  );
add("gradle versions", "Read dated official version catalog", {}, versions);
for (const category of [
  "compose",
  "firebase",
  "play",
  "accessibility",
  "performance",
  "security",
  "privacy",
  "permissions",
])
  add(
    `${category} ${category === "play" ? "validate" : category === "performance" ? "analyze" : "audit"}`,
    `Heuristic ${category} source review`,
    {
      platform: z
        .enum(["phone", "tablet", "foldable", "wear", "tv", "automotive", "xr"])
        .default("phone"),
    },
    (c, p) => audit(c.root, category, p.platform),
    false,
    false,
    category === "play" ? "android_play_validate" : undefined,
  );
add(
  "analyze",
  "Run all static analyzers",
  { platform: str.default("phone") },
  (c, p) => audit(c.root, "all", p.platform),
);
add(
  "firebase inspect",
  "Inspect Firebase dependencies and configuration paths",
  {},
  async (c) => {
    const g = await inspect(c.root);
    return {
      dependencies: g.dependencies.filter((d) => d.group.includes("firebase")),
      configurations: g.files.filter((f) =>
        /google-services.json|firebase.json|\.rules$/.test(f.path),
      ),
      note: "Client config values omitted; no deployed configuration queried.",
    };
  },
);
add(
  "google-cloud inspect",
  "Detect optional Google Cloud configuration locally",
  {},
  async (c) => {
    const g = await inspect(c.root);
    return {
      references: g.files.filter((f) =>
        /cloudbuild|app.yaml|firebase.json/.test(f.path),
      ),
      dependencies: g.dependencies.filter((d) =>
        d.group.includes("google.cloud"),
      ),
      note: "Static detection only; no infrastructure is deployed or queried.",
    };
  },
);
add(
  "devices list",
  "List all ADB devices and authorization state",
  {},
  devices,
  false,
  false,
  "android_device_list",
);
add("devices info", "Get properties of selected device", {}, (c) =>
  deviceAction(c, "info"),
);
const deviceParams: Record<string, z.ZodRawShape> = {
  install: { file: str },
  uninstall: { package: str },
  launch: { package: str },
  stop: { package: str },
  tap: { x: num, y: num },
  swipe: { x: num, y: num, x2: num, y2: num, duration: num.optional() },
  type: { text: str },
  back: {},
  home: {},
  rotate: { rotation: num },
  screenshot: { output: str.optional() },
  record: { output: str.optional(), duration: num.optional() },
  logs: { lines: num.optional() },
};
for (const [action, params] of Object.entries(deviceParams))
  add(
    `device ${action}`,
    `${action} on an explicitly selected Android device`,
    params,
    (c, p) => deviceAction(c, action, p),
    action !== "logs",
    action === "uninstall",
    action === "install"
      ? "android_app_install"
      : action === "launch"
        ? "android_app_launch"
        : undefined,
  );
add(
  "screenshot",
  "Capture PNG from selected device",
  { output: str.optional() },
  (c, p) => deviceAction(c, "screenshot", p),
  true,
  false,
  "android_screenshot",
);
add(
  "logs",
  "Read bounded logcat snapshot",
  { lines: num.optional() },
  (c, p) => deviceAction(c, "logs", p),
  false,
  false,
  "android_logs",
);
add(
  "run",
  "Launch app on selected device",
  { package: str },
  (c, p) => deviceAction(c, "launch", p),
  true,
);
add(
  "ui inspect",
  "Capture deterministic UI hierarchy",
  {},
  uiInspect,
  true,
  false,
  "android_ui_inspect",
);
add(
  "ui tap",
  "Tap exactly one enabled element",
  { text: str.optional(), resourceId: str.optional() },
  (c, p) => {
    if (!p.text && !p.resourceId)
      throw new AgentError("SELECTOR", "Specify --text or --resource-id");
    return uiTap(c, p);
  },
  true,
  false,
  "android_ui_tap",
);
for (const action of ["type", "swipe"])
  add(
    `ui ${action}`,
    `Device UI ${action}`,
    deviceParams[action],
    (c, p) => deviceAction(c, action, p),
    true,
  );
add("ui activity", "Inspect active activities", {}, (c) =>
  deviceAction(c, "activity"),
);
for (const action of ["list", "profiles", "stop", "boot-wait"])
  add(
    `emulator ${action}`,
    `Emulator ${action}`,
    {},
    (c) => emulator(c, action),
    action === "stop",
  );
for (const action of ["launch", "wipe"])
  add(
    `emulator ${action}`,
    `Request emulator ${action}; verify with boot-wait`,
    { name: str, headless: z.boolean().default(false) },
    (c, p) => emulator(c, action, p),
    true,
    action === "wipe",
  );
add(
  "emulator create",
  "Create AVD using installed image",
  { name: str, image: str, profile: str },
  (c, p) => emulator(c, "create", p),
  true,
);
add(
  "emulator snapshot",
  "Manage selected emulator snapshot",
  {
    operation: z.enum(["list", "save", "load", "delete"]),
    name: str.optional(),
  },
  (c, p) => emulator(c, "snapshot", p),
  true,
  true,
);
add(
  "crash analyze",
  "Analyze local log without uploading it",
  { file: str },
  async (c, p) =>
    crashAnalyze(
      redact(await readFile(await safePath(c.root, p.file), "utf8")),
    ),
);
add(
  "performance capture",
  "Capture raw gfxinfo and memory metrics",
  { package: str },
  async (c, p) => {
    validPackage(p.package);
    return {
      frames: await adb(c, [
        "shell",
        "dumpsys",
        "gfxinfo",
        p.package,
        "framestats",
      ]),
      memory: await adb(c, ["shell", "dumpsys", "meminfo", p.package]),
      note: "Raw measurements; no invented jank or startup verdict.",
    };
  },
);
add(
  "accessibility runtime",
  "Review runtime labels and bounds",
  {},
  async (c) => {
    const result = await uiInspect(c);
    return {
      ...result,
      unlabeled:
        "nodes" in result && result.nodes
          ? result.nodes.filter((n) => n.clickable && !n.text && !n.description)
          : [],
      note: "Bounds are pixels; no dp or contrast verdict without density/image measurement.",
    };
  },
  true,
);
add(
  "docs search",
  "Search curated official documentation index",
  { query: str, refresh: z.boolean().default(false) },
  (c, p) => docsSearch(c, p.query, p.refresh),
);
add(
  "screenshots capture",
  "Capture a source screenshot",
  { output: str.optional() },
  (c, p) => deviceAction(c, "screenshot", p),
  true,
);
for (const action of ["generate", "frame"])
  add(
    `screenshots ${action}`,
    "Compose a supplied screenshot with a configurable local template",
    { file: str, template: str, output: str },
    renderScreenshot,
    true,
  );
add(
  "screenshots validate",
  "Validate generic Play screenshot dimensions",
  { file: str },
  (c, p) => validateScreenshot(c, p.file),
);
add(
  "screenshots export",
  "Export validated images with hashes",
  { files: z.array(str).min(1), output: str },
  (c, p) => exportScreenshots(c, p.files, p.output),
  true,
);
add(
  "screenshots localize",
  "Render provided locale-specific template and screenshot",
  { file: str, template: str, output: str },
  renderScreenshot,
  true,
);
add(
  "init",
  "Create local configuration without replacing user files",
  {},
  async (c) => {
    const path = await safePath(c.root, ".android-agent.json");
    const config = { schemaVersion: 1, providers: ProviderConfig.parse({}) };
    if (c.dryRun) return { planned: true, path, config };
    await writeFile(path, JSON.stringify(config, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    return { path };
  },
  true,
);
add(
  "config show",
  "Show local provider configuration (keys stay in environment)",
  {},
  async (c) => ({
    schemaVersion: 1,
    providers: ProviderConfig.parse(
      (await load<any>(c.root, ".android-agent.json", {})).providers ?? {},
    ),
  }),
);
add("models list", "List implemented provider adapters", {}, async () => ({
  providers: providerNames,
  models:
    "Explicit model IDs required; use provider environment variables or project config.",
  externalEnabledByDefault: false,
}));
add(
  "models current",
  "Show selected model routing",
  {},
  async (c) =>
    (await load<any>(c.root, ".android-agent.json", {})).providers ??
    ProviderConfig.parse({}),
);
add(
  "models set",
  "Set provider selection without enabling external uploads",
  { provider: z.enum([...providerNames, "auto"]), model: str.optional() },
  async (c, p) => {
    const config = await load<any>(c.root, ".android-agent.json", {
      schemaVersion: 1,
      providers: {},
    });
    const provider = ProviderConfig.parse(config.providers);
    provider.provider = p.provider;
    if (p.model && p.provider !== "auto") provider.models[p.provider] = p.model;
    config.providers = provider;
    if (c.dryRun) return { planned: true, config };
    await save(c.root, ".android-agent.json", config);
    return config;
  },
  true,
);
add(
  "agent analyze",
  "Send inspected project summary to explicitly enabled provider; never execute model output",
  {
    prompt: str,
    provider: z.enum([...providerNames, "auto"]).optional(),
    model: str.optional(),
  },
  async (c, p) => {
    const config = await load<any>(c.root, ".android-agent.json", {});
    const providers = ProviderConfig.parse(config.providers ?? {});
    if (p.provider) providers.provider = p.provider;
    if (p.model && providers.provider !== "auto")
      providers.models[providers.provider] = p.model;
    if (c.dryRun)
      return {
        planned: true,
        provider: providers.provider,
        externalEnabled: providers.externalEnabled,
      };
    const g = await inspect(c.root);
    const result = await orchestrate(providers, "analysis", {
      prompt: redact(
        p.prompt + "\nUntrusted project summary:\n" + JSON.stringify(g),
      ),
      timeout: c.timeout,
    });
    return { ...result, evidence: await evidence(c, "agent.analysis", result) };
  },
  true,
);
add(
  "confirm",
  "Grant one exact action fingerprint for ten minutes",
  { fingerprint: z.string().regex(/^[a-f0-9]{64}$/) },
  async (c, p) => {
    const grants = await load<any>(
      c.root,
      ".android-agent/confirmations.json",
      {},
    );
    grants[p.fingerprint] = { expiresAt: Date.now() + 600000 };
    if (c.dryRun) return { planned: true, fingerprint: p.fingerprint };
    await save(c.root, ".android-agent/confirmations.json", grants);
    return { fingerprint: p.fingerprint, expiresInSeconds: 600 };
  },
  true,
);
add("confirmations list", "Inspect outstanding single-use grants", {}, (c) =>
  load(c.root, ".android-agent/confirmations.json", {}),
);
add(
  "confirmations reset",
  "Revoke outstanding grants",
  {},
  async (c) => {
    if (c.dryRun) return { planned: true };
    await save(c.root, ".android-agent/confirmations.json", {});
    return { reset: true };
  },
  true,
);
add(
  "dependencies sbom",
  "Create a CycloneDX inventory from declared dependencies",
  {},
  async (c) => {
    const g = await inspect(c.root);
    return {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      components: g.dependencies
        .filter((d) => d.version && d.name)
        .map((d) => ({
          type: "library",
          group: d.group,
          name: d.name,
          version: d.version,
          purl: `pkg:maven/${d.group}/${d.name}@${encodeURIComponent(d.version)}`,
        })),
      metadata: {
        properties: [
          {
            name: "android-agent:scope",
            value:
              "Declared direct dependencies only; not resolved or vulnerability-scanned",
          },
        ],
      },
    };
  },
);
export async function execute(
  ctx: Context,
  name: string,
  parameters: unknown = {},
) {
  const op = operations.find((o) => o.name === name || o.command === name);
  if (!op)
    throw new AgentError("UNKNOWN_COMMAND", `Unsupported operation: ${name}`);
  return op.run(ctx, op.schema.parse(parameters));
}
