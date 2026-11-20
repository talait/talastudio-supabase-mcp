import { sql, sqlApp, ownerQuery } from './db';
import { filePreview, runTool, tools as jamesTools } from './james/tools';
import { CORS, MCP_ORIGIN, hideSecretKeys, json, redact } from './lib';
import { saveFile } from './drive';

/**
 * TalaStudio MCP server (Streamable HTTP, JSON responses, stateless) for the owners' Claude accounts.
 * Same tools and data as James (as an admin), plus free read-only SQL over every data schema. Nothing can be changed.
 */

const VERSION = '2026-11-20.5';
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
  {
    name: 'remember',
    title: 'Save to shared memory',
    description: 'Save a durable fact, decision or correction to the shared memory. scope "team" (default) = a team note that James and every Claude connected to TalaStudio read in every conversation (e.g. "Vendor CN GLASS invoices in RMB, not IDR", "EJO approves all PR above Rp10 jt"). scope "me" = the signed-in person\'s own memory (their preferences). One fact per call, in plain words, max 1000 characters. Do not save secrets, passwords or one-off chatter.',
    inputSchema: { type: 'object', properties: { note: { type: 'string' }, scope: { type: 'string', enum: ['team', 'me'] } }, required: ['note'] },
  },
  {
    name: 'forget',
    title: 'Remove from shared memory',
    description: 'Remove a team note (scope "team") or one of the person\'s own notes (scope "me") by its #id from company_context. Only when the user asks or the note is wrong.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' }, scope: { type: 'string', enum: ['team', 'me'] } }, required: ['id'] },
  },
  {
    name: 'save_file',
    title: 'Save a file to Drive',
    description: 'Save a file to Google Drive TALASTUDIO ASSETS/_CLAUDE/<person>/<date> as it is, so the team (and James) can find and open it. Use it for files the user gives you in this chat (kind "input") and for deliverables you make: reports, tables, CSV, drafts, code, images (kind "output"). Send "text" for text files (md, csv, html, json, txt) or "content_base64" for any file. Name it with its extension. Max 20 MB. Returns the Drive link: give it to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name with extension, e.g. "Vendor risk Nov 2026.md".' },
        text: { type: 'string', description: 'Content of a text file.' },
        content_base64: { type: 'string', description: 'Content of any file, base64.' },
        mime: { type: 'string', description: 'Optional media type; guessed from the extension.' },
        kind: { type: 'string', enum: ['input', 'output'], description: 'input = given by the user; output = made by Claude.' },
        description: { type: 'string', description: 'One or two lines: what it is and which question it answers.' },
        chat_key: { type: 'string', description: 'The key returned by save_chat, to tie the file to this conversation.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'save_chat',
    title: 'Finish this turn',
    description: 'Every TalaStudio tool call already saves the user\'s message and your previous answer (fields user_message / previous_answer). Call save_chat as the LAST step of a turn in which you used TalaStudio, with final_answer = the answer you are about to give, word for word, so the conversation is complete. Add a summary when the conversation reaches a result (what was asked, the answer with key numbers and sources, decisions, files). Nothing is overwritten: every message and every summary is kept.',
    inputSchema: {
      type: 'object',
      properties: {
        final_answer: { type: 'string', description: 'Your answer for this turn, word for word.' },
        summary: { type: 'string', description: 'Optional summary of the conversation so far (markdown).' },
        files: { type: 'array', items: { type: 'string' }, description: 'Drive links of files saved in this conversation.' },
      },
      required: ['final_answer'],
    },
  },
];
const WRITE_TOOLS = new Set(['remember', 'forget', 'save_file', 'save_chat']);

// Every tool call carries the conversation so far, so it is saved without relying on a separate call.
const TURN_FIELDS = {
  chat_title: { type: 'string', description: 'Short title of this conversation, the same on every call (e.g. "Vendor risk Nov 2026").' },
  user_message: { type: 'string', description: "The user's latest message, word for word (including what they pasted)." },
  previous_answer: { type: 'string', description: 'Your previous answer in this conversation, word for word (the full text you showed the user last turn). Required: send "" on the first turn of the conversation and on later tool calls within the same turn.' },
};
const withTurn = (schema: Record<string, unknown>) => {
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const req = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return { ...schema, type: 'object', properties: { ...props, ...TURN_FIELDS }, required: [...new Set([...req, 'chat_title', 'user_message', 'previous_answer'])] };
};

function toolList(): Tool[] {
  const fromJames = jamesTools
    .filter((t) => FROM_JAMES.includes(t.name))
    .map((t) => ({
      name: t.name,
      description: String(t.description ?? '').replace(/query_database/g, 'sql_query').replace(/\bthe user\b/g, 'the reader'),
      inputSchema: t.input_schema as unknown as Record<string, unknown>,
    }));
  return [...OWN_TOOLS, ...fromJames].map((t) => ({
    ...t,
    inputSchema: withTurn(t.inputSchema),
    annotations: WRITE_TOOLS.has(t.name)
      ? { readOnlyHint: false, destructiveHint: t.name === 'forget', idempotentHint: false, openWorldHint: t.name === 'save_file' }
      : { ...RO, ...(t.name === 'look_at_file' ? { openWorldHint: true } : {}) },
  }));
}

const INSTRUCTIONS = `TalaStudio connector. TalaStudio is the furniture design studio of Tala Living in Jepara, Indonesia. This connector gives the owners the whole company record: Drive files and their extracted contents, every spreadsheet row and its change history, email threads, Google Chat, WhatsApp chats that were allowed in, purchase requests/payments/vendors/projects (business_trace, knowledge_graph), the product catalog and approvals, the website CMS and visitors, social posts, GitHub, team PC files, the Google Workspace audit log, sync health, HR documents (hr_documents) and the AI cost log.

How to work:
- Start with company_context once per conversation, then pick the right source. For a PR/payment/vendor/project start with business_trace; for "who/how many/total/compare" write SQL with sql_query (james views first; schema-qualified tables for anything else; database_schema to discover).
- Investigate like an auditor: check at least two independent sources (e.g. chat + spreadsheet + file), build the timeline, look for counter-evidence, and separate proven facts from guesses. Read the records behind any summary number.
- Dates: the database stores UTC; report in WIB (Asia/Jakarta). Data is collected from 1 Nov 2026 (some sources earlier) and updated automatically; say how fresh the data is when it matters.
- Cite the links returned by the tools. Never invent numbers: every figure comes from a tool result.
- Shared context: every conversation that uses TalaStudio is kept for the team, complete and append-only. Every tool call carries chat_title, user_message (the user's latest message, word for word) and, on the first call of a turn, previous_answer (your previous answer, word for word). End every turn in which you used TalaStudio with save_chat(final_answer = your answer word for word). Save durable facts and decisions with remember (team). Save every file the user gives you and every deliverable you make with save_file (kind input/output; files are never overwritten) and share the link. Do this without being asked; mention it in one short line at most.
- Company records cannot be changed, sent or approved through this connector (only notes, chat summaries and files in _CLAUDE are written); secrets (keys, tokens, pairing codes) are never shown.`;

async function contextText(token: string): Promise<string> {
  const [[{ s }], notes, know, [{ mine }]] = await Promise.all([
    sql`select ai.james_schema() as s` as unknown as Promise<{ s: string }[]>,
    sql`select id, note, added_by from ai.james_notes_list(150)` as unknown as Promise<{ id: number; note: string; added_by: string }[]>,
    sql`select title, body from ai.james_knowledge_list()` as unknown as Promise<{ title: string; body: string }[]>,
    sqlApp`select mcp.my_notes(${token}) as mine` as unknown as Promise<{ mine: unknown }[]>,
  ]);
  const myNotes = ((typeof mine === 'string' ? JSON.parse(mine) : mine) ?? []) as { id: number; note: string }[];
  const now = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', dateStyle: 'full', timeStyle: 'short' }).format(new Date());
  return [
    `Now: ${now} WIB.`,
    '# Company knowledge', know.map((k) => `## ${k.title}\n${k.body.trim()}`).join('\n\n'),
    '# Team notes (shared memory; add with remember, remove with forget scope "team")', notes.map((x) => `#${x.id} ${x.note} (from ${x.added_by.split('@')[0]})`).join('\n') || '(none)',
    '# Your own notes (scope "me")', myNotes.map((x) => `#${x.id} ${x.note}`).join('\n') || '(none)',
    '# Views in schema james (unqualified names in sql_query)', String(s ?? ''),
    '# Other schemas (schema-qualified in sql_query; use database_schema for columns)',
    'sheets (rows, tabs, row_changes = every spreadsheet row and its history) · media (files, file_contents, local_files = team PC files, pc_uploads, whatsapp_chats, devices) · ai (documents = emails/chats/posts/commits, chunks, prompt_log, runs = AI cost) · spine (events = every event from every source, event_links) · biz (refs, links, data_issues = purchases/payments/vendors) · kg (entities, facts) · product (catalog: collections, placements, asset_slots/versions, status_history) · cms (website content) · core (people, person_profiles, audit_log, sync_runs, sync_state) · hr (documents) · qa (tests, results, james_exam*) · public (ws_activity = Workspace audit log) · talastudio_visitor_tracker (website visits) · mcp (settings_public, calls = this connector\'s log).',
  ].join('\n\n');
}

class ToolError extends Error {}

type Turn = { session: string | null; title: string | null; chat: string | null };

async function callTool(name: string, args: Record<string, unknown>, token: string, email: string, turn: Turn): Promise<{ content: unknown[]; isError?: boolean }> {
  const text = (v: string) => ({ type: 'text', text: redact(v) });
  switch (name) {
    case 'company_context':
      return { content: [text(await contextText(token))] };
    case 'remember': {
      const scope = args.scope === 'me' ? 'me' : 'team';
      const [{ id }] = (await sqlApp`select mcp.note_add(${token}, ${String(args.note ?? '')}, ${scope}) as id`) as unknown as { id: number }[];
      return { content: [text(scope === 'me' ? `Saved to your own memory as #${id}.` : `Saved as team note #${id}: James and every connected Claude will see it.`)] };
    }
    case 'forget': {
      const scope = args.scope === 'me' ? 'me' : 'team';
      const [{ ok }] = (await sqlApp`select mcp.note_remove(${token}, ${Number(args.id)}, ${scope}) as ok`) as unknown as { ok: boolean }[];
      return { content: [text(ok ? `Note #${args.id} removed.` : `No ${scope} note #${args.id} found.`)] };
    }
    case 'save_file': {
      const f = await saveFile(token, args as Parameters<typeof saveFile>[1]);
      return { content: [text(JSON.stringify({ saved: f.name, folder: f.folder, link: f.link, size_bytes: f.size }))] };
    }
    case 'save_chat': {
      const files = Array.isArray(args.files) ? (args.files as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 50) : [];
      const summary = [String(args.summary ?? '').trim(), files.length ? `Files:\n${files.map((l) => `- ${l}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
      const [{ c }] = (await sqlApp`select mcp.chat_finish(${token}, ${turn.session}, ${turn.title}, ${turn.chat}::uuid,
        ${String(args.final_answer ?? '')}, ${summary || null}) as c`) as unknown as { c: string }[];
      return { content: [text(JSON.stringify({ saved: true, chat_id: c, note: 'Conversation saved (append-only); James and the team can search it.' }))] };
    }
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

async function handle(m: Rpc, token: string, email: string, session: string | null): Promise<unknown | null> {
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
      const raw = (m.params?.arguments && typeof m.params.arguments === 'object' ? m.params.arguments : {}) as Record<string, unknown>;
      const { chat_title, user_message, previous_answer, ...args } = raw;
      const turn: Turn = { session, title: typeof chat_title === 'string' ? chat_title.slice(0, 200) : null, chat: null };
      // Save the conversation first (append-only); a failure here never blocks the tool.
      if (name !== 'save_chat' && (user_message || previous_answer)) {
        try {
          const [{ c }] = (await sqlApp`select mcp.chat_log(${token}, ${session}, ${turn.title}, ${typeof user_message === 'string' ? user_message : null},
            ${typeof previous_answer === 'string' ? previous_answer : null}, ${name}, null) as c`) as unknown as { c: string | null }[];
          turn.chat = c;
        } catch { /* logging must not break the tool */ }
      }
      const t0 = Date.now();
      let res: { content: unknown[]; isError?: boolean };
      let error: string | null = null;
      try { res = await callTool(name, args, token, email, turn); } catch (e) {
        error = (e as Error).message || 'failed';
        res = { content: [{ type: 'text', text: redact(`Error: ${error}`) }], isError: true };
      }
      // File contents are not copied into the call log (the file itself is on Drive and in mcp.saved_files).
      const slim = name === 'save_chat' ? { ...args, final_answer: `[${String(args.final_answer ?? '').length} chars]` } : name === 'save_file' ? { ...args, text: args.text ? `[${String(args.text).length} chars]` : undefined, content_base64: args.content_base64 ? `[${String(args.content_base64).length} chars]` : undefined } : args;
      const logged = JSON.stringify(slim).length > 4000 ? { truncated: JSON.stringify(slim).slice(0, 4000) } : slim;
      await sqlApp`select mcp.log_call(${token}, ${name}, ${sqlApp.json(logged as never)}::jsonb, ${Date.now() - t0}, ${!error}, ${error})`.catch(() => undefined);
      // First real use (20 Nov): Claude sent the user's messages but never its own answers. Every result reminds it
      // to finish the turn with save_chat, so the last answer is kept too.
      if (name !== 'save_chat' && Array.isArray(res.content)) {
        res.content.push({ type: 'text', text: '[TalaStudio keeps this conversation: before you finish this reply, call save_chat with final_answer = your full answer.]' });
      }
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
  // A session id groups the tool calls of one Claude conversation (the client sends it back on every request).
  const msgs = (Array.isArray(body) ? body : [body]) as Rpc[];
  const isInit = msgs.some((m) => m?.method === 'initialize');
  const session = req.headers.get('mcp-session-id') || (isInit ? crypto.randomUUID() : null);
  const sid: Record<string, string> = isInit && session ? { 'Mcp-Session-Id': session } : {};
  if (Array.isArray(body)) {
    const out = (await Promise.all(msgs.map((m) => handle(m, token, e, session)))).filter((x) => x !== null);
    return out.length ? json(out, 200, sid) : new Response(null, { status: 202, headers: { ...CORS, ...sid } });
  }
  const out = await handle(body as Rpc, token, e, session);
  return out === null ? new Response(null, { status: 202, headers: { ...CORS, ...sid } }) : json(out, 200, sid);
}

export function mcpGet() {
  return new Response('Method not allowed: this server answers POST only (no server-initiated stream).', { status: 405, headers: { ...CORS, Allow: 'POST' } });
}
