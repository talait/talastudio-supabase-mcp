# talastudio-supabase-mcp

- Commit messages in English.
- This Worker serves ONLY `mcp.talastudio.net`: `/mcp`, `/.well-known/oauth-*`, `/.well-known/openid-configuration`, `/oauth/register`, `/oauth/token`, `/oauth/authorize`. Every other path is 404. It has no Cloudflare Access in front, so it never trusts `cf-access-*` headers and never serves workspace pages.
- Company records are read-only. The only writes (owner decision 20 Nov 2026) are the shared context: team/personal notes (`remember`/`forget` via `mcp.note_*`, the same notes James reads), chat summaries (`save_chat` → `ai.documents` source `ai_chat`), and files saved to Drive `TALASTUDIO ASSETS/_CLAUDE/<person>/<date>` (`save_file`, logged in `mcp.saved_files`). Do not add tools that change company records, send, approve or delete without an explicit owner decision.
- Never expose secrets: `core.app_secrets`, `core.settings` (use `mcp.settings_public`), alert webhooks, extension/agent releases, WhatsApp QR/pairing state, upload session URLs, and other people's James chats/notes. Every tool result goes through `redact()`; SQL rows through `hideSecretKeys()`.
- Who may connect: `core.settings` `access.mcp_domains` (company domains) and `access.mcp` (single emails) in Supabase, never hardcoded emails.
- `src/james/tools.ts` and `google.ts` are copies from the workspace repo (`talait/talastudio-supabase`, `app/src/lib/`). Change them there, then `npm run sync-james`.
- Database changes go as migrations in the workspace repo (`supabase/migrations`), not here.
- Pin dependency versions; run `npm run typecheck` and `npx wrangler deploy --dry-run --outdir dist` before pushing.
