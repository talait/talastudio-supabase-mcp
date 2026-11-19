# TalaStudio MCP server

The TalaStudio connector for Claude: a Cloudflare Worker at **`https://mcp.talastudio.net/mcp`** that lets the owners' Claude
accounts read all TalaStudio company data (read-only). Who may connect: every company Google account whose domain is in
Supabase `core.settings` `access.mcp_domains` (talaliving.com, talastudio.net), plus single emails in `access.mcp`.

- Guide for the owners (what it is, how to install): Claude Doc "Konektor TalaStudio untuk Claude".
- Technical notes, rules and admin tasks: [docs/mcp-connector.md](docs/mcp-connector.md).

## What is where

| Piece | Where |
| --- | --- |
| MCP server (`/mcp`), OAuth metadata, `/oauth/register`, `/oauth/token`, `/oauth/authorize` | this repo (Worker `talastudio-supabase-mcp`, domain `mcp.talastudio.net`) |
| Login + consent page (`/oauth/consent`) | workspace repo `talait/talastudio-supabase`, on `workspace.talastudio.net` behind Cloudflare Access |
| Database: schema `mcp` (clients, codes, hashed tokens, call log), `mcp.owner_query`, role `ts_owner_read` | Supabase `sobinutyzhldustwwmmw`; migration in the workspace repo `supabase/migrations/20261119200000_mcp_owner_connector.sql` |
| James' tools (`src/james/tools.ts`, `google.ts`) | copied from the workspace repo `app/src/lib/`; refresh with `npm run sync-james -- ../talastudio-supabase` |

## Tools

`company_context`, `sql_query` (read-only SQL over every data schema), `database_schema`, `look_at_file` (returns the picture),
plus James' read-only tools: overview, search, meaning_search, business_trace, knowledge_graph, timeline, recent, get_item,
sheet_rows, list_tabs, collection_context, pc_files, staff_directory, workspace_activity, website_visitors, ai_prompts,
system_log, hr_documents, past_chats. Nothing writes, sends or approves.

## Deploy

Cloudflare Workers Builds deploys `main` on every push (`npx wrangler deploy`). Bindings: the same Hyperdrive configs as the
workspace (`talastudio-db` = ts_chatbot read, `talastudio-db-app` = ts_app). Secret in the dashboard: `GOOGLE_SA_KEY` (same
value as the workspace Worker) for `look_at_file`.

## Develop

```
npm install
npm run typecheck
npx wrangler dev        # local; database calls need a reachable Postgres in localConnectionString
```
