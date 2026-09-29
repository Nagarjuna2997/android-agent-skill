import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  lstat,
  realpath,
  readdir,
  stat,
} from "node:fs/promises";
import { resolve, join, relative, isAbsolute, dirname } from "node:path";
import ignore from "ignore";
export class AgentError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: unknown = null,
  ) {
    super(message);
  }
}
export const hash = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
export const now = () => new Date().toISOString();
export function redact(s: string): string {
  for (const [k, v] of Object.entries(process.env))
    if (v && v.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k))
      s = s.split(v).join("[REDACTED]");
  return s
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b(?:AIza[\w-]{25,}|sk-[\w-]{16,}|gh[pousr]_[\w]{20,})/g,
      "[REDACTED]",
    )
    .replace(
      /((?:password|api[_-]?key|token|secret|private_key)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
      "$1[REDACTED]",
    );
}
export async function rootPath(path: string) {
  const p = await realpath(resolve(path));
  if (!(await stat(p)).isDirectory())
    throw new AgentError("PROJECT", "Project must be a directory");
  return p;
}
export async function safePath(root: string, path: string) {
  const full = resolve(root, path),
    rel = relative(root, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new AgentError("PATH", "Path must be inside project");
  let at = root;
  for (const part of rel.split(/[\\/]/)) {
    at = join(at, part);
    try {
      if ((await lstat(at)).isSymbolicLink())
        throw new AgentError(
          "SYMLINK",
          "Symlinks are not allowed for managed files",
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return full;
}
export async function save(root: string, path: string, value: unknown) {
  const dest = await safePath(root, path);
  await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = dest + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(tmp, dest);
  return dest;
}
export async function load<T>(
  root: string,
  path: string,
  fallback: T,
): Promise<T> {
  try {
    return JSON.parse(await readFile(await safePath(root, path), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}
export interface Source {
  path: string;
  content: string;
  sha256: string;
}
export async function scan(root: string) {
  const ig = ignore().add([
    ".git/",
    ".gradle/",
    "build/",
    "node_modules/",
    ".android-agent/",
    ".idea/",
    ".env*",
    "*.keystore",
    "*.jks",
    "local.properties",
  ]);
  for (const file of [".gitignore", ".androidagentignore"])
    try {
      ig.add(await readFile(await safePath(root, file), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  const files: Source[] = [],
    limits = new Set<string>();
  let bytes = 0,
    dirs = 0;
  async function walk(dir: string): Promise<void> {
    if (++dirs > 2000) {
      limits.add("directory budget");
      return;
    }
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(dir, e.name),
        path = relative(root, full).replaceAll("\\", "/");
      if (e.isSymbolicLink()) {
        limits.add("symlinks skipped");
        continue;
      }
      if (ig.ignores(path + (e.isDirectory() ? "/" : ""))) continue;
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (
        !e.isFile() ||
        !(
          /\.(kt|java|xml|kts|gradle|toml|properties|json|rules|yml|yaml|txt)$/.test(
            path,
          ) || e.name === "gradlew"
        )
      )
        continue;
      const size = (await stat(full)).size;
      if (files.length >= 5000 || size > 512000 || bytes + size > 16000000) {
        limits.add("file/byte budget");
        continue;
      }
      try {
        const content = await readFile(full, "utf8");
        files.push({ path, content, sha256: hash(content) });
        bytes += size;
      } catch {
        limits.add("unreadable file");
      }
    }
  }
  await walk(root);
  return { files, limits: [...limits], bytes };
}
export interface ProcessResult {
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  startedAt: string;
  binary?: Buffer;
}
export type Runner = (
  command: string,
  args: string[],
  opts?: {
    cwd?: string;
    timeout?: number;
    binary?: boolean;
    input?: string;
    redactArgs?: boolean;
  },
) => Promise<ProcessResult>;
export const run: Runner = async (command, args, opts = {}) => {
  const start = Date.now(),
    startedAt = now();
  return await new Promise((done, reject) => {
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      timedOut = false,
      truncated = false;
    const max = opts.binary ? 32 * 1024 * 1024 : 2 * 1024 * 1024;
    const child = spawn(command, args, {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeout ?? 120000);
    const collect = (chunk: Buffer, err: boolean) => {
      const old = err ? stderr : stdout;
      const next = Buffer.concat([old, chunk]).subarray(0, max);
      if (old.length + chunk.length > max) {
        truncated = true;
        kill();
      }
      if (err) stderr = next;
      else stdout = next;
    };
    child.stdout.on("data", (d) => collect(d, false));
    child.stderr.on("data", (d) => collect(d, true));
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new AgentError("EXEC", redact(e.message)));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      done({
        command,
        args: opts.redactArgs ? ["[REDACTED]"] : args.map(redact),
        exitCode,
        stdout: opts.binary ? "" : redact(stdout.toString()),
        stderr: redact(stderr.toString()),
        durationMs: Date.now() - start,
        timedOut,
        truncated,
        startedAt,
        ...(opts.binary ? { binary: stdout } : {}),
      });
    });
  });
};
export function checked(r: ProcessResult) {
  if (r.exitCode !== 0 || r.timedOut || r.truncated)
    throw new AgentError(
      "COMMAND_FAILED",
      "Command did not complete successfully",
      r,
    );
  return r;
}
export interface Context {
  root: string;
  device?: string;
  dryRun?: boolean;
  confirm?: string;
  timeout?: number;
  runner: Runner;
}
export async function evidence(ctx: Context, kind: string, result: unknown) {
  const id = randomUUID();
  const path = await save(ctx.root, `.android-agent/evidence/${id}.json`, {
    schemaVersion: 1,
    id,
    kind,
    at: now(),
    result,
  });
  return { path, sha256: hash(await readFile(path)) };
}
export async function authorize(
  ctx: Context,
  action: string,
  parameters: unknown,
) {
  const fingerprint = hash(
    JSON.stringify({ root: ctx.root, action, parameters }),
  );
  if (ctx.dryRun) return;
  if (!ctx.confirm)
    throw new AgentError(
      "CONFIRMATION_REQUIRED",
      `Review this action, then use confirm --fingerprint ${fingerprint} and retry with --confirm ${fingerprint}`,
      { action, parameters, fingerprint },
    );
  const grants = await load<Record<string, { expiresAt: number }>>(
    ctx.root,
    ".android-agent/confirmations.json",
    {},
  );
  if (
    ctx.confirm !== fingerprint ||
    !grants[fingerprint] ||
    grants[fingerprint].expiresAt < Date.now()
  )
    throw new AgentError(
      "CONFIRMATION_REQUIRED",
      "Missing, expired or mismatched confirmation",
      { fingerprint },
    );
  delete grants[fingerprint];
  await save(ctx.root, ".android-agent/confirmations.json", grants);
}
