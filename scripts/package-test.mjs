import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function exec(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: 180000,
    shell: process.platform === "win32",
  });
  if (r.status !== 0) throw Error(`${cmd} failed: ${r.stderr}\n${r.stdout}`);
  return r.stdout;
}
const packed = JSON.parse(exec(npm, ["pack", "--json"], process.cwd()))[0];
const tmp = await mkdtemp(join(tmpdir(), "android-agent-pack-"));
try {
  exec(
    npm,
    ["install", "--prefix", tmp, "--ignore-scripts", resolve(packed.filename)],
    process.cwd(),
  );
  const file = join(tmp, "node_modules/android-agent-skill/dist/cli/index.js");
  const help = exec(process.execPath, [file, "--help"], tmp);
  if (!help.includes("inspect")) throw Error("Missing CLI");
  const r = JSON.parse(
    exec(
      process.execPath,
      [file, "gradle", "versions", "--json", "--project", tmp],
      tmp,
    ),
  );
  if (!r.result.toolchain) throw Error("Missing packaged version data");
  const p = JSON.parse(
    await readFile(
      join(tmp, "node_modules/android-agent-skill/package.json"),
      "utf8",
    ),
  );
  console.log(
    JSON.stringify({
      installed: true,
      version: p.version,
      tarball: packed.filename,
      bytes: packed.size,
      files: packed.entryCount,
      executable: true,
      catalog: true,
    }),
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}
