# Agent integrations

The tested integration is the MCP protocol itself: the official TypeScript SDK client initializes the stdio server, lists tools, calls project inspection and verifies mutation denial.

The executable contract is:

```sh
android-agent --project /absolute/path/to/app mcp
```

Grant routine mutation capability explicitly with `mcp --allow-mutations`. Destructive confirmations remain separate. The server never accepts a client-supplied project root. No API key is required for deterministic CLI/MCP tooling.

For Claude Code, Codex, Gemini CLI, Gemini Code Assist, VS Code agents, Cursor and Windsurf, configure the above executable and arguments in the client's documented MCP settings. The JSON in README is a generic mcpServers example, not a verified universal configuration file. Each client's feature availability, settings syntax, host permissions and transport support must be checked against its official documentation. No client-specific certification is claimed by this release.

`SKILL.md` provides an optional workflow guide for clients supporting file-based skills. Skill installation/activation is a host-specific step and is not done automatically by this package.
