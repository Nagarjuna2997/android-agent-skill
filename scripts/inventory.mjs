import { writeFile } from "node:fs/promises";
import { operations } from "../dist/core/registry.js";
const rows = operations.map(({ run: _r, schema, ...o }) => ({
  ...o,
  parameters: Object.keys(schema.shape),
}));
await writeFile(
  "docs/COMMANDS.md",
  "# CLI and MCP inventory\n\nGenerated from the shared operation registry. Each CLI parameter is a named flag; camelCase becomes kebab-case. Common flags appear in `android-agent --help`. The MCP name is the same operation with the listed schema. MCP excludes confirmation issuance, model configuration writes and init.\n\n| CLI | MCP | Parameters | Changes state |\n|---|---|---|---|\n" +
    rows
      .map(
        (o) =>
          `| \`${o.command}\` | \`${o.name}\` | ${o.parameters.join(", ") || "—"} | ${o.mutates ? "yes" : "no"}${o.destructive ? " (confirmation)" : ""} |`,
      )
      .join("\n") +
    "\n\nAdditional CLI-only commands: `mcp [--allow-mutations]`, `runs create --file PLAN`, `runs list`, `runs show --id UUID`, `runs resume --id UUID`. Provider streaming, multimodal and tool-call request support is available through the programmatic adapter; the CLI analysis command sends a project summary.\n",
);
await writeFile(
  "site/commands.js",
  "window.commandInventory = " + JSON.stringify(rows, null, 2) + ";\n",
);
