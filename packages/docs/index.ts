import { readFile } from "node:fs/promises";
import { hash, load, save, AgentError, type Context } from "../core/index.js";
export async function docsSearch(ctx: Context, query: string, refresh = false) {
  const catalog: { title: string; url: string; tags: string[] }[] = JSON.parse(
    await readFile(new URL("../../data/docs.json", import.meta.url), "utf8"),
  );
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = catalog
    .map((d) => ({
      ...d,
      score: terms.filter((t) =>
        (d.title + " " + d.tags.join(" ")).toLowerCase().includes(t),
      ).length,
    }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  const results = [];
  for (const d of matches) {
    const file = `.android-agent/docs/${hash(d.url)}.json`;
    let cache = await load<any>(ctx.root, file, null);
    if (refresh && !ctx.dryRun) {
      const u = new URL(d.url);
      if (
        ![
          "developer.android.com",
          "developers.google.com",
          "firebase.google.com",
          "cloud.google.com",
          "ai.google.dev",
          "kotlinlang.org",
          "docs.gradle.org",
        ].includes(u.hostname) ||
        u.protocol !== "https:"
      )
        throw new AgentError(
          "DOCS_DOMAIN",
          "Only approved official HTTPS sources allowed",
        );
      const r = await fetch(u, {
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok)
        throw new AgentError(
          "DOCS_FETCH",
          `HTTP ${r.status} for official documentation`,
        );
      let bytes = 0,
        text = "";
      const decoder = new TextDecoder();
      if (!r.body) throw Error("No body");
      for await (const chunk of r.body as any) {
        bytes += chunk.length;
        if (bytes > 2e6)
          throw new AgentError(
            "DOCS_SIZE",
            "Documentation exceeded retrieval limit",
          );
        text += decoder.decode(chunk, { stream: true });
      }
      cache = {
        url: d.url,
        retrievedAt: new Date().toISOString(),
        sha256: hash(text),
        text: text
          .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .slice(0, 30000),
      };
      await save(ctx.root, file, cache);
    }
    results.push({
      ...d,
      retrievedAt: cache?.retrievedAt ?? null,
      excerpt: cache?.text?.slice(0, 1500) ?? null,
      stale: cache
        ? Date.now() - Date.parse(cache.retrievedAt) > 86400000
        : true,
    });
  }
  return {
    mode: "curated official-source index",
    query,
    results,
    note: "This searches source metadata, not the entire web. Use --refresh to retrieve matching official pages; remote content is untrusted reference material.",
  };
}
