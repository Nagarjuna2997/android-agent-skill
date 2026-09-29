import { XMLParser, XMLValidator } from "fast-xml-parser";
import TOML from "@iarna/toml";
import { scan, type Source } from "../core/index.js";
export const array = (v: any): any[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
export function xml(text: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw Error("DTD/entities not supported");
  const valid = XMLValidator.validate(text);
  if (valid !== true) throw Error(valid.err.msg);
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    processEntities: false,
  }).parse(text);
}
export function uncomment(s: string) {
  return s.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, (m) =>
    m.replace(/[^\n]/g, " "),
  );
}
export async function inspect(root: string) {
  const input = await scan(root),
    warnings = [...input.limits],
    catalogs: any[] = [];
  for (const f of input.files.filter((f) => f.path.endsWith(".toml")))
    try {
      catalogs.push({ file: f.path, data: TOML.parse(f.content) });
    } catch {
      warnings.push(`Cannot parse catalog: ${f.path}`);
    }
  const versions = Object.assign(
    {},
    ...catalogs.map((c) => c.data.versions ?? {}),
  );
  const dependencies: any[] = [];
  for (const c of catalogs)
    for (const [alias, v] of Object.entries<any>(c.data.libraries ?? {})) {
      const coordinate =
        typeof v === "string" ? v : (v.module ?? `${v.group}:${v.name}`);
      const parts = coordinate.split(":");
      dependencies.push({
        file: c.file,
        alias,
        group: parts[0],
        name: parts[1],
        version:
          parts[2] ??
          (typeof v.version === "string"
            ? v.version
            : versions[v.version?.ref]) ??
          null,
        source: "catalog",
      });
    }
  const modules = input.files
    .filter((f) => /(^|\/)build.gradle(\.kts)?$/.test(f.path))
    .map((f) => {
      const text = uncomment(f.content),
        directory = f.path.replace(/(^|\/)build.gradle(\.kts)?$/, "");
      const plugins = [
        ...text.matchAll(
          /(?:id\s*\(?\s*["']([^"']+)["']|alias\(libs.plugins.([\w.]+)\))/g,
        ),
      ].map((m) => m[1] ?? m[2]);
      for (const p of plugins) {
        const key = p.replaceAll(".", "-");
        for (const c of catalogs) {
          const item = c.data.plugins?.[key];
          if (item?.id && !plugins.includes(item.id)) plugins.push(item.id);
        }
      }
      for (const m of text.matchAll(/["']([\w.-]+):([\w.-]+):([^"'\s]+)["']/g))
        dependencies.push({
          file: f.path,
          group: m[1],
          name: m[2],
          version: m[3],
          source: "literal",
        });
      const number = (name: string) => {
        const m = text.match(
          new RegExp(`\\b${name}(?:Version)?\\s*(?:=|\\()?\\s*(\\d+)`),
        );
        return m ? Number(m[1]) : null;
      };
      return {
        path: directory || ".",
        gradleFile: f.path,
        kind: plugins.includes("com.android.application")
          ? "application"
          : plugins.some((p) => p.includes("android.library"))
            ? "library"
            : "unknown",
        plugins,
        sdk: {
          compile: number("compileSdk"),
          target: number("targetSdk"),
          min: number("minSdk"),
        },
        versionCode: number("versionCode"),
        versionName: text.match(/versionName\s*=?\s*["']([^"']+)/)?.[1] ?? null,
        applicationId:
          text.match(/applicationId\s*=?\s*["']([^"']+)/)?.[1] ?? null,
        compose: /compose\s*=\s*true|compose.compiler/.test(text),
        buildTypes: [...text.matchAll(/\b(debug|release)\s*\{/g)].map(
          (m) => m[1],
        ),
        declaredVariantNames: [
          ...text.matchAll(
            /(?:create|getByName|register)\s*\(\s*["']([^"']+)/g,
          ),
        ].map((m) => m[1]),
        projectDependencies: [
          ...text.matchAll(/project\s*\(\s*["']([^"']+)/g),
        ].map((m) => m[1]),
      };
    });
  const manifests: any[] = [];
  for (const f of input.files.filter((f) =>
    f.path.endsWith("AndroidManifest.xml"),
  ))
    try {
      const m = xml(f.content).manifest,
        a = m.application ?? {};
      manifests.push({
        file: f.path,
        package: m.package ?? null,
        permissions: array(m["uses-permission"]).map((p) => p["android:name"]),
        features: array(m["uses-feature"]).map((p) => p["android:name"]),
        application: {
          debuggable: a["android:debuggable"],
          allowBackup: a["android:allowBackup"],
          usesCleartextTraffic: a["android:usesCleartextTraffic"],
        },
        components: [
          "activity",
          "activity-alias",
          "service",
          "receiver",
          "provider",
        ].flatMap((kind) =>
          array(a[kind]).map((c) => ({
            kind,
            name: c["android:name"],
            exported: c["android:exported"] ?? null,
            foregroundServiceType: c["android:foregroundServiceType"] ?? null,
            intentFilters: array(c["intent-filter"]).map((i) => ({
              autoVerify: i["android:autoVerify"] ?? null,
              actions: array(i.action).map((a) => a["android:name"]),
              categories: array(i.category).map((a) => a["android:name"]),
              data: array(i.data),
            })),
          })),
        ),
      });
    } catch (e) {
      warnings.push(`${f.path}: ${(e as Error).message}`);
    }
  const all = input.files.map((f) => f.content).join("\n");
  const frameworks = [
    "firebase",
    "compose",
    "hilt",
    "room",
    "work",
    "datastore",
    "billing",
    "maps",
    "retrofit",
    "okhttp",
    "junit",
    "espresso",
    "mockk",
    "baselineprofile",
    "benchmark",
    "mlkit",
    "litert",
  ].filter((x) => all.toLowerCase().includes(x));
  return {
    schemaVersion: 1,
    root,
    projectType: modules.some((m) => m.kind === "application")
      ? "android-application"
      : modules.length
        ? "gradle"
        : "unknown",
    modules,
    manifests,
    dependencies,
    versions,
    frameworks,
    languages: {
      kotlin: input.files.filter((f) => f.path.endsWith(".kt")).length,
      java: input.files.filter((f) => f.path.endsWith(".java")).length,
    },
    layouts: input.files
      .filter((f) => /\/res\/layout[^/]*\/.*xml$/.test(f.path))
      .map((f) => f.path),
    ci: input.files
      .filter((f) => f.path.startsWith(".github/workflows/"))
      .map((f) => f.path),
    files: input.files.map(({ path, sha256 }) => ({ path, sha256 })),
    warnings,
    limitations: [
      "Static declarations only; convention plugins, computed SDK values, resolved variants and manifest merging require Gradle.",
    ],
  };
}
export type Graph = Awaited<ReturnType<typeof inspect>>;
export function location(f: Source, index: number) {
  return { file: f.path, line: f.content.slice(0, index).split("\n").length };
}
