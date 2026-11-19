# talastudio-supabase-mcp

- Commit messages in English.
- This Worker serves ONLY `mcp.talastudio.net`: `/mcp`, `/.well-known/oauth-*`, `/.well-known/openid-configuration`, `/oauth/register`, `/oauth/token`, `/oauth/authorize`. Every other path is 404. It has no Cloudflare Access in front, so it never trusts `cf-access-*` headers and never serves workspace pages.
- Everything is read-only. Do not add tools that write, send, approve or delete without an explicit owner decision.
- Never expose secrets: `core.app_secrets`, `core.settings` (use `mcp.settings_public`), alert webhooks, extension/agent releases, WhatsApp QR/pairing state, upload session URLs, and other people's James chats/notes. Every tool result goes through `redact()`; SQL rows through `hideSecretKeys()`.
- Who may connect: `core.settings` `access.mcp` in Supabase, never hardcoded emails.
- `src/james/tools.ts` and `google.ts` are copies from the workspace repo (`talait/talastudio-supabase`, `app/src/lib/`). Change them there, then `npm run sync-james`.
- Database changes go as migrations in the workspace repo (`supabase/migrations`), not here.
- Pin dependency versions; run `npm run typecheck` and `npx wrangler deploy --dry-run --outdir dist` before pushing.
