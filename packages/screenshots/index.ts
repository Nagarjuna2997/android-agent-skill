import sharp from "sharp";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import { safePath, hash, AgentError, type Context } from "../core/index.js";
const color = z.string().regex(/^#[\da-fA-F]{6}$/);
export const Template = z
  .object({
    width: z.number().int().min(320).max(3840).default(1080),
    height: z.number().int().min(320).max(3840).default(1920),
    background: color.default("#10231c"),
    foreground: color.default("#ffffff"),
    accent: color.default("#a8f0bc"),
    layout: z.enum(["stack", "split", "minimal"]).default("stack"),
    caption: z.string().max(120).default(""),
    locale: z
      .string()
      .regex(/^[\w-]+$/)
      .default("en"),
    fontSize: z.number().min(16).max(100).default(56),
    padding: z.number().min(20).max(180).default(64),
  })
  .strict();
const escape = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export async function renderScreenshot(
  ctx: Context,
  p: { file: string; template: string; output: string },
) {
  const t = Template.parse(
      JSON.parse(await readFile(await safePath(ctx.root, p.template), "utf8")),
    ),
    input = await safePath(ctx.root, p.file),
    output = await safePath(ctx.root, p.output);
  if (ctx.dryRun) return { planned: true, template: t, output };
  const source = await readFile(input);
  const meta = await sharp(source, { limitInputPixels: 32e6 }).metadata();
  if (!["png", "jpeg"].includes(meta.format ?? ""))
    throw new AgentError("IMAGE", "Use a PNG or JPEG screenshot");
  const maxWidth = Math.round(
      t.layout === "split" ? t.width * 0.47 : t.width - 2 * t.padding,
    ),
    maxHeight = Math.round(
      t.layout === "minimal" ? t.height - 2 * t.padding : t.height * 0.7,
    );
  const image = await sharp(source)
    .resize(maxWidth, maxHeight, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  const im = await sharp(image).metadata();
  const left = Math.round(
      t.layout === "split" ? t.width * 0.51 : (t.width - im.width!) / 2,
    ),
    top = Math.round(
      t.layout === "minimal"
        ? (t.height - im.height!) / 2
        : t.height - im.height! - t.padding,
    );
  const captionWidth =
    t.layout === "split" ? t.width * 0.42 : t.width - 2 * t.padding;
  const chars = Math.max(8, Math.floor(captionWidth / (t.fontSize * 0.6)));
  const words = t.caption.split(/\s+/),
    lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).length > chars && line) {
      lines.push(line);
      line = "";
    }
    line += (line ? " " : "") + w;
  }
  if (line) lines.push(line);
  if (lines.length > 4)
    throw new AgentError(
      "CAPTION",
      "Caption exceeds four lines; shorten text or reduce font size",
    );
  const svg = Buffer.from(
    `<svg width="${t.width}" height="${t.height}"><rect width="100%" height="100%" fill="${t.background}"/><rect x="${t.padding}" y="${t.padding}" width="48" height="6" fill="${t.accent}"/><text x="${t.padding}" y="${t.padding + t.fontSize + 30}" font-family="sans-serif" font-size="${t.fontSize}" fill="${t.foreground}">${lines.map((l, i) => `<tspan x="${t.padding}" dy="${i ? t.fontSize * 1.2 : 0}">${escape(l)}</tspan>`).join("")}</text></svg>`,
  );
  const bytes = await sharp(svg)
    .composite([{ input: image, left, top }])
    .flatten({ background: t.background })
    .removeAlpha()
    .png()
    .toBuffer();
  await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
  return {
    path: output,
    sha256: hash(bytes),
    sourceHash: hash(source),
    width: t.width,
    height: t.height,
    locale: t.locale,
    review:
      "Review caption shaping and visual layout; this is a neutral composition, not an official hardware frame.",
  };
}
export async function validateScreenshot(ctx: Context, file: string) {
  const m = await sharp(await safePath(ctx.root, file), {
    limitInputPixels: 32e6,
  }).metadata();
  const issues = [];
  if (!["png", "jpeg"].includes(m.format ?? "")) issues.push("Use JPEG or PNG");
  if (m.hasAlpha) issues.push("Remove alpha for Play listing");
  if (
    !m.width ||
    !m.height ||
    Math.min(m.width, m.height) < 320 ||
    Math.max(m.width, m.height) > 3840
  )
    issues.push("Generic screenshot dimensions must be 320..3840");
  if (
    m.width &&
    m.height &&
    Math.max(m.width, m.height) > 2 * Math.min(m.width, m.height)
  )
    issues.push("Longest side exceeds twice shortest side");
  return {
    file,
    width: m.width,
    height: m.height,
    format: m.format,
    issues,
    valid: issues.length === 0,
    scope:
      "Generic screenshot asset only; form-factor-specific listing counts and placement require manual review.",
  };
}
export async function exportScreenshots(
  ctx: Context,
  files: string[],
  output: string,
) {
  const dest = await safePath(ctx.root, output);
  const reports = await Promise.all(
    files.map((f) => validateScreenshot(ctx, f)),
  );
  if (reports.some((r) => !r.valid))
    throw new AgentError(
      "ASSETS_INVALID",
      "Fix screenshot validation before exporting",
      reports,
    );
  if (ctx.dryRun) return { planned: true, reports };
  await mkdir(dest);
  const entries = [];
  for (const [i, f] of files.entries()) {
    const data = await readFile(await safePath(ctx.root, f));
    const path = `${String(i + 1).padStart(2, "0")}.${reports[i].format === "jpeg" ? "jpg" : "png"}`;
    await writeFile(dest + "/" + path, data, { flag: "wx" });
    entries.push({ path, sha256: hash(data) });
  }
  await writeFile(dest + "/manifest.json", JSON.stringify(entries, null, 2), {
    flag: "wx",
  });
  return { directory: dest, entries };
}
