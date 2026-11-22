@AGENTS.md

## Claude Code

- `AGENTS.md` is the shared guide for Claude Code, Codex and Antigravity. Put project facts there; keep only Claude Code specifics here.
- `.claude/rules` and `.claude/skills` are symlinks to `.agents/rules` and `.agents/skills`, so all three tools share one copy. Edit the files under `.agents/`.
- `.mcp.json` connects Cloudflare Code Mode as `cloudflare-api` (tools `search`, `execute`, `docs`), authenticated with `CLOUDFLARE_API_TOKEN`. `.claude/settings.json` approves it and sets the shared permissions.
- Personal, uncommitted preferences go in `CLAUDE.local.md`, which is git-ignored.
