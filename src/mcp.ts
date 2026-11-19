import { sql, sqlApp, ownerQuery } from './db';
import { filePreview, runTool, tools as jamesTools } from './james/tools';
import { CORS, MCP_ORIGIN, hideSecretKeys, json, redact } from './lib';

/**
 * TalaStudio MCP server (Streamable HTTP, JSON responses, stateless) for the owners' Claude accounts.
 * Same tools and data as James (as an admin), plus free read-only SQL over every data schema. Nothing can be changed.
 */

const VERSION = '2026-11-19.1';
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
// Claude Code caps MCP tool output at about 25k tokens by default: stay under it.
const OUT_CHARS = 60_000;

// James tools that only read. remember/forget/run_sync (write) and query_database (replaced by sql_query) are left out.
const FROM_JAMES = ['overview', 'search', 'meaning_search', 'business_trace', 'knowledge_graph', 'timeline', 'recent', 'get_item',
  'sheet_rows', 'list_tabs', 'collection_context', 'pc_files', 'staff_directory', 'workspace_activity', 'website_visitors',
  'ai_prompts', 'system_log', 'hr_documents', 'past_chats'];

type Tool = { name: string; title?: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const OWN_TOOLS: Tool[] = [
  {
    name: 'company_context',
    title: 'Company context',
    description: 'Call this FIRST in every new conversation. Returns what TalaStudio is, who does what, which spreadsheet/view holds what, team notes, and the columns of every "james" view. Use it to choose where to look before searching or writing SQL.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sql_query',
    title: 'Read-only SQL (all data)',
    description: 'Run ONE read-only SQL SELECT (or WITH … SELECT) over all company data. Unqualified names resolve to the friendly "james" views (see company_context); any other table can be used schema-qualified, e.g. sheets.rows, media.files, media.file_contents, ai.documents, spine.events, biz.refs, kg.facts, product.*, cms.*, hr.documents, core.audit_log, public.ws_activity, mcp.settings_public. Use database_schema to discover tables and columns. Rules: no semicolons, up to 1000 rows (default 200) so aggregate or LIMIT; times are timestamptz in UTC, use (col at time zone \'Asia/Jakarta\') for WIB; jsonb: data ->> \'Column\'; text match: ilike \'%word%\'. Writing is impossible (read-only transaction).',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single SELECT or WITH … SELECT statement.' },
        purpose: { type: 'string', description: 'Short note of what this query checks (kept in the audit log).' },
        max_rows: { type: 'integer', minimum: 1, maximum: 1000, description: 'Row cap, default 200.' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'database_schema',
    title: 'Database tables and columns',
    description: 'List the tables and views you can query with sql_query: name, approximate row count, description and columns with types. Give a filter (part of a schema/table name or a word from the description, e.g. "sheets", "media.file", "payment") to keep it short; without a filter it lists everything.',
    inputSchema: { type: 'object', properties: { filter: { type: 'string' } } },
  },
  {
    name: 'look_at_file',
    title: 'Look at a file',
    description: 'Get the picture of an image, render, drawing or PDF (first page) so you can look at it yourself: colour/finish checks, defects in production photos, what a drawing shows, comparing a render with a sample. id = a file result_id (uuid) from search/timeline/pc_files/get_item, or a Google Drive file id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

function toolList(): Tool[] {
  const fromJames = jamesTools
    .filter((t) => FROM_JAMES.includes(t.name))
    .map((t) => ({
      name: t.name,
      description: String(t.description ?? '').replace(/query_database/g, 'sql_query').replace(/\bthe user\b/g, 'the reader'),
      inputSchema: t.input_schema as unknown as Record<string, unknown>,
    }));
  return [...OWN_TOOLS, ...fromJames].map((t) => ({ ...t, annotations: { ...RO, ...(t.name === 'look_at_file' ? { openWorldHint: true } : {}) } }));
}

const INSTRUCTIONS = `TalaStudio connector (read-only). TalaStudio is the furniture design studio of Tala Living in Jepara, Indonesia. This connector gives the owners the whole company record: Drive files and their extracted contents, every spreadsheet row and its change history, email threads, Google Chat, WhatsApp chats that were allowed in, purchase requests/payments/vendors/projects (business_trace, knowledge_graph), the product catalog and approvals, the website CMS and visitors, social posts, GitHub, team PC files, the Google Workspace audit log, sync health, HR documents (hr_documents) and the AI cost log.

How to work:
- Start with company_context once per conversation, then pick the right source. For a PR/payment/vendor/project start with business_trace; for "who/how many/total/compare" write SQL with sql_query (james views first; schema-qualified tables for anything else; database_schema to discover).
- Investigate like an auditor: check at least two independent sources (e.g. chat + spreadsheet + file), build the timeline, look for counter-evidence, and separate proven facts from guesses. Read the records behind any summary number.
- Dates: the database stores UTC; report in WIB (Asia/Jakarta). Data is collected from 1 Nov 2026 (some sources earlier) and updated automatically; say how fresh the data is when it matters.
- Cite the links returned by the tools. Never invent numbers: every figure comes from a tool result.
- Nothing can be sent, approved or changed through this connector; secrets (keys, tokens, pairing codes) are never shown.`;

async function contextText(): Promise<string> {
  const [[{ s }], notes, know] = await Promise.all([
    sql`select ai.james_schema() as s` as unknown as Promise<{ s: string }[]>,
    sql`select id, note, added_by from ai.james_notes_list(150)` as unknown as Promise<{ id: number; note: string; added_by: string }[]>,
    sql`select title, body from ai.james_knowledge_list()` as unknown as Promise<{ title: string; body: string }[]>,
  ]);
  const now = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', dateStyle: 'full', timeStyle: 'short' }).format(new Date());
  return [
    `Now: ${now} WIB.`,
    '# Company knowledge', know.map((k) => `## ${k.title}\n${k.body.trim()}`).join('\n\n'),
    '# Team notes', notes.map((x) => `#${x.id} ${x.note} (from ${x.added_by.split('@')[0]})`).join('\n') || '(none)',
    '# Views in schema james (unqualified names in sql_query)', String(s ?? ''),
    '# Other schemas (schema-qualified in sql_query; use database_schema for columns)',
    'sheets (rows, tabs, row_changes = every spreadsheet row and its history) · media (files, file_contents, local_files = team PC files, pc_uploads, whatsapp_chats, devices) · ai (documents = emails/chats/posts/commits, chunks, prompt_log, runs = AI cost) · spine (events = every event from every source, event_links) · biz (refs, links, data_issues = purchases/payments/vendors) · kg (entities, facts) · product (catalog: collections, placements, asset_slots/versions, status_history) · cms (website content) · core (people, person_profiles, audit_log, sync_runs, sync_state) · hr (documents) · qa (tests, results, james_exam*) · public (ws_activity = Workspace audit log) · talastudio_visitor_tracker (website visits) · mcp (settings_public, calls = this connector\'s log).',
  ].join('\n\n');
}

class ToolError extends Error {}

async function callTool(name: string, args: Record<string, unknown>, token: string, email: string): Promise<{ content: unknown[]; isError?: boolean }> {
  const text = (v: string) => ({ type: 'text', text: redact(v) });
  switch (name) {
    case 'company_context':
      return { content: [text(await contextText())] };
    case 'sql_query': {
      const q = String(args.sql ?? '').trim().replace(/;\s*$/, '');
      if (!/^(select|with|values)\b/i.test(q.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\()+/, ''))) throw new ToolError('Only a single SELECT (or WITH … SELECT) statement is allowed.');
      if (q.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').includes(';')) throw new ToolError('One statement only: remove the semicolons.');
      if (/\b(pg_sleep|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|lo_get|dblink\w*|set_config|pg_terminate_backend|pg_cancel_backend|http_\w+|net\.\w+)\s*\(/i.test(q)) throw new ToolError('That function is not allowed.');
      const max = typeof args.max_rows === 'number' ? Math.floor(args.max_rows) : 200;
      const rows = (hideSecretKeys(await ownerQuery(token, q, max)) as Record<string, unknown>[]);
      const body = JSON.stringify({ row_count: rows.length, capped: rows.length >= max, rows });
      return { content: [text(body.length > OUT_CHARS ? body.slice(0, OUT_CHARS) + '\n[RESULT CUT OFF: aggregate, select fewer columns or LIMIT.]' : body)] };
    }
    case 'database_schema': {
      const f = typeof args.filter === 'string' && args.filter.trim() ? args.filter.trim() : null;
      const [{ r }] = (await sql`select mcp.owner_schema(${token}, ${f}) as r`) as unknown as { r: unknown }[];
      const v = typeof r === 'string' ? r : JSON.stringify(r);
      return { content: [text(v.length > OUT_CHARS ? v.slice(0, OUT_CHARS) + '\n[CUT OFF: use a filter.]' : v)] };
    }
    case 'look_at_file': {
      const p = await filePreview(String(args.id ?? '').trim(), email);
      return {
        content: [
          text(`File: ${p.name} (${p.mime})${p.link ? `\nLink: ${p.link}` : ''}\n${/pdf|presentation|document/.test(p.mime) ? 'First page preview' : 'Preview image (1600 px)'}:`),
          { type: 'image', data: p.data, mimeType: p.type },
        ],
      };
    }
    default: {
      if (!FROM_JAMES.includes(name)) throw new ToolError(`Unknown tool: ${name}`);
      const r = await runTool(name, args, { email, maxChars: OUT_CHARS });
      return { content: [text(r.text)] };
    }
  }
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const ok = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const err = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handle(m: Rpc, token: string, email: string): Promise<unknown | null> {
  if (!m || typeof m.method !== 'string') return err(m?.id, -32600, 'Invalid request');
  const isNote = m.id === undefined || m.id === null;
  switch (m.method) {
    case 'initialize': {
      const asked = String(m.params?.protocolVersion ?? '');
      return ok(m.id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'talastudio', title: 'TalaStudio', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return ok(m.id, {});
    case 'tools/list': return ok(m.id, { tools: toolList() });
    case 'resources/list': return ok(m.id, { resources: [] });
    case 'resources/templates/list': return ok(m.id, { resourceTemplates: [] });
    case 'prompts/list': return ok(m.id, { prompts: [] });
    case 'tools/call': {
      const name = String(m.params?.name ?? '');
      const args = (m.params?.arguments && typeof m.params.arguments === 'object' ? m.params.arguments : {}) as Record<string, unknown>;
      const t0 = Date.now();
      let res: { content: unknown[]; isError?: boolean };
      let error: string | null = null;
      try { res = await callTool(name, args, token, email); } catch (e) {
        error = (e as Error).message || 'failed';
        res = { content: [{ type: 'text', text: redact(`Error: ${error}`) }], isError: true };
      }
      const logged = JSON.stringify(args).length > 4000 ? { truncated: JSON.stringify(args).slice(0, 4000) } : args;
      await sqlApp`select mcp.log_call(${token}, ${name}, ${sqlApp.json(logged as never)}::jsonb, ${Date.now() - t0}, ${!error}, ${error})`.catch(() => undefined);
      return ok(m.id, res);
    }
    default:
      if (m.method.startsWith('notifications/')) return null;
      return isNote ? null : err(m.id, -32601, `Method not found: ${m.method}`);
  }
}

function unauthorized(desc: string) {
  return new Response(JSON.stringify({ error: 'invalid_token', error_description: desc }), {
    status: 401,
    headers: {
      ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'WWW-Authenticate': `Bearer resource_metadata="${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="${desc}"`,
    },
  });
}

export async function mcpPost(req: Request) {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return unauthorized('Sign in to TalaStudio');
  const [{ e }] = (await sqlApp`select mcp.token_email(${token}) as e`) as unknown as { e: string | null }[];
  if (!e) return unauthorized('Token expired or not allowed');
  let body: unknown;
  try { body = await req.json(); } catch { return json(err(null, -32700, 'Parse error'), 400); }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(m as Rpc, token, e)))).filter((x) => x !== null);
    return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
  }
  const out = await handle(body as Rpc, token, e);
  return out === null ? new Response(null, { status: 202, headers: CORS }) : json(out);
}

export function mcpGet() {
  return new Response('Method not allowed: this server answers POST only (no server-initiated stream).', { status: 405, headers: { ...CORS, Allow: 'POST' } });
}
