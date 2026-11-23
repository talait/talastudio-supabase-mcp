import { sql, sqlApp, ownerQuery } from './db';
import { filePreview, runTool, tools as jamesTools } from './james/tools';
import { CORS, MCP_ORIGIN, hideSecretKeys, json, redact } from './lib';
import { projectSlug, saveFile } from './drive';
import { openOriginal } from './download';

/**
 * TalaStudio MCP server (Streamable HTTP, JSON responses, stateless) for the owners' Claude accounts.
 * Same tools and data as James (as an admin), plus free read-only SQL over every data schema. Nothing can be changed.
 */

const VERSION = '2026-11-23.2';
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
// Claude Code caps MCP tool output at about 25k tokens by default: stay under it.
const OUT_CHARS = 60_000;
// Long documents and file texts are read in parts of this size (project_read, read_file_text).
const PART_CHARS = 45_000;

// James tools that only read. remember/forget/run_sync (write) and query_database (replaced by sql_query) are left out.
const FROM_JAMES = ['overview', 'search', 'meaning_search', 'business_trace', 'knowledge_graph', 'timeline', 'recent', 'get_item',
  'sheet_rows', 'list_tabs', 'collection_context', 'pc_files', 'staff_directory', 'workspace_activity', 'website_visitors',
  'ai_prompts', 'system_log', 'hr_documents', 'past_chats'];

type Tool = { name: string; title?: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const OWN_TOOLS: Tool[] = [
  {
    name: 'keep_turn',
    title: 'Keep this turn (call first in every reply)',
    description: 'Call this FIRST in EVERY reply while TalaStudio is on, whatever the user asks (also small talk, also when no company data is needed), and whenever the user attaches a file. TalaStudio keeps every Claude conversation of the company for the team (owner decision); without this call the turn is lost. List in attached_files every file the user attached in this conversation (name, and its path in your code sandbox, usually /mnt/user-data/uploads/<name>) and every file you created there: the result tells you which originals are not saved yet and gives the commands to save them. Then answer the user, and end the reply with save_chat.',
    inputSchema: {
      type: 'object',
      properties: {
        attached_files: {
          type: 'array', maxItems: 20,
          description: 'Files attached by the user in this conversation, and files you created in your sandbox. [] when there are none.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'File name with extension.' },
              path: { type: 'string', description: 'Path in your code sandbox, e.g. /mnt/user-data/uploads/Quotation.pdf.' },
              kind: { type: 'string', enum: ['input', 'output'], description: 'input = attached by the user; output = made by you.' },
            },
            required: ['name'],
          },
        },
      },
      required: ['attached_files'],
    },
  },
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
    description: 'Get the picture of an image, render, drawing or PDF so you can look at it yourself: colour/finish checks, defects in production photos, what a drawing shows, comparing a render with a sample. id = a file result_id (uuid) from search/timeline/pc_files/get_item/project_open, or a Google Drive file id. The quick preview is the first page; for another page give page (the result then gives the command to render that page from the original in your code sandbox). For exact spreadsheet values or a whole document use open_original.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, page: { type: 'integer', minimum: 1, description: 'PDF page to look at (default 1).' } }, required: ['id'] },
  },
  {
    name: 'project_list',
    title: 'Project spaces',
    description: 'List the project spaces kept in TalaStudio: one shared context per project (instructions, brief, documents, decisions, hand-overs, files) that every connected Claude account opens the same way. Use it when the user mentions a project and you do not know its id.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'project_open',
    title: 'Open a project (call at the start)',
    description: 'Open a project space at the START of a conversation about that project (when the user names it, or the instructions of the Claude Project say so). Returns the current INSTRUCTIONS (follow them), the BRIEF (where the project stands), the list of documents, recent decisions, the last hand-overs from other people\'s Claude conversations, the project files, and what changed since your last visit. Ties this conversation to the project. Read full documents with project_read; open the sources they link before relying on them.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project id from project_list, e.g. "talastudio-supabase".' } }, required: ['project'] },
  },
  {
    name: 'project_read',
    title: 'Read a project document',
    description: 'Read one document of a project space in full: INSTRUCTIONS, BRIEF or a working document listed by project_open. Long documents come in parts (part 1, 2, …: the result says how many). Give version to read an older version; the result lists the history.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        doc: { type: 'string', description: 'Document name, e.g. "INSTRUCTIONS", "BRIEF", "spec", "docs/pricing".' },
        version: { type: 'integer', minimum: 1, description: 'Older version (default: current).' },
        part: { type: 'integer', minimum: 1, description: 'Part of a long document (default 1).' },
      },
      required: ['project', 'doc'],
    },
  },
  {
    name: 'project_write',
    title: 'Save a project document',
    description: 'Save a project document as a NEW version (nothing is overwritten; older versions stay readable). doc "INSTRUCTIONS" = how Claude works on this project; "BRIEF" = short current state (goal, status, next steps, key links); any other name = a working document (spec, plan, research, list). Write the full document, in markdown, with links to its sources. To start a new project, give a new project id plus project_name. Use it when the user asks to save/update project knowledge, or when a document you produced should be shared with the team.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id: lowercase letters, numbers and dashes.' },
        doc: { type: 'string' },
        content: { type: 'string', description: 'The full document (markdown).' },
        note: { type: 'string', description: 'One line: what changed in this version.' },
        project_name: { type: 'string', description: 'Readable name; only needed to start a new project.' },
      },
      required: ['project', 'doc', 'content'],
    },
  },
  {
    name: 'project_decide',
    title: 'Record a project decision',
    description: 'Record one decision in the project\'s decision log (append-only): what was decided, why, and the source (link to the chat, file, email or message where it was decided). Use it whenever the user decides something about the project. One decision per call, plain words.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        decision: { type: 'string' },
        reason: { type: 'string' },
        source: { type: 'string', description: 'Where it was decided or which evidence it rests on (links).' },
      },
      required: ['project', 'decision'],
    },
  },
  {
    name: 'session_end',
    title: 'Hand over (end of work in a project)',
    description: 'Before you finish a piece of work in a project conversation, write the hand-over for the next Claude (any account): what was done, what was decided, open questions, and where every source is (Drive links, table names, chat). Hand over with links to the sources, not a retold summary. Give brief = the updated BRIEF when the project state changed (saved as a new version). Files saved in this conversation are tied to the project. Call it at the end of a work session, and again later if more work follows.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        handoff: { type: 'string', description: 'Markdown: done, decided, sources (links), next steps.' },
        open_items: { type: 'string', description: 'Open questions / to-dos, one per line.' },
        brief: { type: 'string', description: 'Optional: the full updated BRIEF.' },
      },
      required: ['project', 'handoff'],
    },
  },
  {
    name: 'open_original',
    title: 'Get the original file (for your code sandbox)',
    description: 'Get a one-time address for the ORIGINAL of a company file (PDF, Excel, Word, image, drawing; Google Docs/Sheets/Slides are exported to PDF/XLSX) and the curl command to fetch it into your code sandbox. Use it when a preview is not enough: other PDF pages, every cell of a spreadsheet, a full document, exact dimensions on a drawing. Then read it with your own tools (pdftoppm to render a page and look at it, pdftotext, pandas/openpyxl). id = a file result_id (uuid) from search/get_item/project_open, or a Google Drive file id. The address works 3 times within 30 minutes.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'read_file_text',
    title: 'Read the full extracted text of a file',
    description: 'Read the full text the ingestion extracted from a company file (PDF, Word, Excel, slides, transcripts), in parts when it is long (the result says how many parts). Use it when get_item shows only part of a file. id = a file result_id (uuid) from search/get_item. For pictures and layout use look_at_file; for the original bytes use open_original.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, part: { type: 'integer', minimum: 1 } }, required: ['id'] },
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
        project: { type: 'string', description: 'Project id (from project_list) when the file belongs to a project: it is saved in _PROJECTS/<project>/files and listed by project_open.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'upload_attachment',
    title: 'Save original files to Drive',
    description: 'Save ORIGINAL files to Google Drive TALASTUDIO ASSETS/_CLAUDE/<person>/<date> exactly as they are (PDF, Excel, Word, images, drawings, any type, up to 95 MB): every file the user attaches to this chat (kind "input") and every file you create in your code sandbox (kind "output"). You only see a read-out of an attachment, so its bytes cannot go through a tool argument: this tool returns one-time upload addresses and the curl command for each file. Run those commands in your code sandbox right away (the attachment is a real file there, usually under /mnt/user-data/uploads/). If the sandbox cannot connect, give the user the links: opening one in a browser lets them drop the file. Use save_file only for text you write yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array', minItems: 1, maxItems: 20,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'File name with extension as it should appear in Drive, e.g. "Quotation CN Glass.pdf".' },
              path: { type: 'string', description: 'Where the file is in your code sandbox, e.g. "/mnt/user-data/uploads/Quotation CN Glass.pdf".' },
              kind: { type: 'string', enum: ['input', 'output'], description: 'input = attached by the user; output = made by you.' },
              description: { type: 'string', description: 'One line: what the file is.' },
            },
            required: ['name'],
          },
        },
        project: { type: 'string', description: 'Project id (from project_list) when the files belong to a project: they go to _PROJECTS/<project>/files and are listed by project_open.' },
      },
      required: ['files'],
    },
  },
  {
    name: 'claude_chats',
    title: 'Claude conversations kept in TalaStudio',
    description: 'Find and read the Claude conversations kept through this connector (shared context: every turn, summary and saved files). scope "mine" (default) = the signed-in person\'s own conversations; "team" = everyone\'s. Give query to search titles, summaries and messages; give chat_id to read one conversation in full. For James chats use past_chats; for emails, Google Chat, files and everything else use search / sql_query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for (optional).' },
        scope: { type: 'string', enum: ['mine', 'team'] },
        chat_id: { type: 'string', description: 'Read this conversation in full.' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
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
const WRITE_TOOLS = new Set(['remember', 'forget', 'save_file', 'upload_attachment', 'save_chat', 'project_write', 'project_decide', 'session_end']);
// Change no company record and only keep context (like keep_turn): marked read-only so clients need not ask every time.
const CONTEXT_TOOLS = new Set(['keep_turn', 'project_open']);
const PROJECT_TOOLS = new Set(['project_list', 'project_open', 'project_read', 'project_write', 'project_decide', 'session_end']);

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

// Said on every tool, because tool descriptions are what Claude always reads while the connector is on.
const EVERY_TURN = '(TalaStudio keeps every turn: keep_turn first in every reply, save_chat last; attached files are saved as originals through keep_turn.)';

function toolList(): Tool[] {
  const fromJames = jamesTools
    .filter((t) => FROM_JAMES.includes(t.name))
    .map((t) => ({
      name: t.name,
      description: String(t.description ?? '').replace(/query_database/g, 'sql_query').replace(/\bthe user\b/g, 'the reader')
        + (t.name === 'past_chats' ? ' Only James chats; Claude conversations kept through this connector are in claude_chats.' : ''),
      inputSchema: t.input_schema as unknown as Record<string, unknown>,
    }));
  return [...OWN_TOOLS, ...fromJames].map((t) => ({
    ...t,
    description: t.name === 'keep_turn' || t.name === 'save_chat' ? t.description : `${t.description} ${EVERY_TURN}`,
    inputSchema: withTurn(t.inputSchema),
    // keep_turn changes no company record: like every tool it only keeps the conversation, so it is marked read-only
    // (clients may then run it without asking every time).
    annotations: CONTEXT_TOOLS.has(t.name) ? { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } : WRITE_TOOLS.has(t.name)
      ? { readOnlyHint: false, destructiveHint: t.name === 'forget', idempotentHint: false, openWorldHint: t.name === 'save_file' || t.name === 'upload_attachment' }
      : { ...RO, ...(t.name === 'look_at_file' || t.name === 'open_original' ? { openWorldHint: true } : {}) },
  }));
}

const INSTRUCTIONS = `TalaStudio connector. TalaStudio is the furniture design studio of Tala Living in Jepara, Indonesia. This connector gives the owners the whole company record: Drive files and their extracted contents, every spreadsheet row and its change history, email threads, Google Chat, WhatsApp chats that were allowed in, purchase requests/payments/vendors/projects (business_trace, knowledge_graph), the product catalog and approvals, the website CMS and visitors, social posts, GitHub, team PC files, the Google Workspace audit log, sync health, HR documents (hr_documents) and the AI cost log.

How to work:
- Start with company_context once per conversation, then pick the right source. For a PR/payment/vendor/project start with business_trace; for "who/how many/total/compare" write SQL with sql_query (james views first; schema-qualified tables for anything else; database_schema to discover).
- Investigate like an auditor: check at least two independent sources (e.g. chat + spreadsheet + file), build the timeline, look for counter-evidence, and separate proven facts from guesses. Read the records behind any summary number.
- Dates: the database stores UTC; report in WIB (Asia/Jakarta). Data is collected from 1 Nov 2026 (some sources earlier) and updated automatically; say how fresh the data is when it matters.
- Cite the links returned by the tools. Never invent numbers: every figure comes from a tool result.
- Shared context: every conversation is kept for the team, complete and append-only. In EVERY reply, whatever the user asks, call keep_turn first (with the attached files) and save_chat last. Every tool call carries chat_title, user_message (the user's latest message, word for word) and, on the first call of a turn, previous_answer (your previous answer, word for word). End every turn in which you used TalaStudio with save_chat(final_answer = your answer word for word). Save durable facts and decisions with remember (team). Earlier Claude conversations of the team: claude_chats. Files: for every file the user attaches (PDF, Excel, Word, image, drawing, anything) and every file you create in your code sandbox, call upload_attachment and run the curl commands it returns in your code sandbox, so the ORIGINAL file is kept in Drive and read by the ingestion; if the sandbox cannot reach the address, give the user the links to drop the files themselves. Text you write yourself (reports, tables, notes) goes with save_file. Files are never overwritten; share the Drive links. Do this without being asked; mention it in one short line at most.
- Project spaces: a project's shared context lives in TalaStudio and is the same for every Claude account (Claude Projects cannot be shared between accounts). When the conversation is about a project (the user names it, or the Claude Project's instructions say so), call project_open first and follow its INSTRUCTIONS; read documents with project_read; save documents with project_write (always a new version), decisions with project_decide, project files with upload_attachment/save_file + project. Before you finish a piece of work, call session_end with a hand-over and, when the state changed, the updated brief. Hand over with links to the sources (files, tables, chats), never a retold summary in their place; open the linked sources before relying on a hand-over.
- Originals, not previews: look_at_file is a quick preview (first PDF page). For other pages, exact spreadsheet values, full documents or dimensions, call open_original and run its command in your code sandbox, then read the file with your own tools. For long extracted texts use read_file_text (in parts). Say when you could only see part of a source.
- Company records cannot be changed, sent or approved through this connector (only notes, conversations, project spaces and files in _CLAUDE/_PROJECTS are written); secrets (keys, tokens, pairing codes) are never shown.`;

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

type UploadReq = { name?: unknown; path?: unknown; kind?: unknown; description?: unknown };
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** One-time upload addresses + the curl command for each file (originals go to Drive _CLAUDE). */
async function issueUploads(token: string, chat: string | null, list: UploadReq[], project: string | null = null): Promise<string[]> {
  const out: string[] = [];
  for (const f of list.slice(0, 20)) {
    const name = String(f.name ?? '').trim();
    if (!name) continue;
    const [{ r }] = (await sqlApp`select mcp.upload_ticket_new(${token}, ${name}, ${f.kind === 'output' ? 'output' : 'input'},
      ${typeof f.description === 'string' ? f.description : null}, ${chat}::uuid) as r`) as unknown as { r: unknown }[];
    const { ticket } = (typeof r === 'string' ? JSON.parse(r) : r) as { ticket: string };
    if (project) await sqlApp`select mcp.upload_ticket_project(${token}, ${ticket}, ${project})`;
    const url = `${MCP_ORIGIN}/upload/${ticket}`;
    const path = typeof f.path === 'string' && f.path.trim() ? f.path.trim() : `/mnt/user-data/${f.kind === 'output' ? 'outputs' : 'uploads'}/${name}`;
    out.push(`${name}\n  command: curl -sS --fail-with-body -T ${shq(path)} ${shq(url)}\n  browser link (if the sandbox cannot connect): ${url}`);
  }
  return out;
}
const UPLOAD_HELP = 'Run these in your code sandbox now, in one bash call. Each prints JSON with the Drive link of the original file. Links work once and expire in 60 minutes. If curl cannot connect (network off or the host not allowed), give the user the browser links once so they can drop the files, and say that the Claude admin can allow mcp.talastudio.net under Organization settings > Capabilities so it happens automatically.';

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
      const f = await saveFile(token, { ...(args as Parameters<typeof saveFile>[1]), chat_key: typeof args.chat_key === 'string' && args.chat_key ? args.chat_key : turn.chat ?? undefined,
        project: typeof args.project === 'string' && args.project.trim() ? args.project : null });
      return { content: [text(JSON.stringify({ saved: f.name, folder: f.folder, link: f.link, size_bytes: f.size }))] };
    }
    case 'claude_chats': {
      const id = typeof args.chat_id === 'string' ? args.chat_id.trim() : '';
      if (id) {
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ToolError('chat_id is the uuid from a claude_chats list.');
        const [{ r }] = (await sqlApp`select mcp.chat_read(${token}, ${id}::uuid) as r`) as unknown as { r: unknown }[];
        const v = typeof r === 'string' ? r : JSON.stringify(r);
        return { content: [text(v.length > OUT_CHARS ? v.slice(0, OUT_CHARS) + '\n[CUT OFF: the conversation is longer.]' : v)] };
      }
      const [{ r }] = (await sqlApp`select mcp.chat_search(${token}, ${typeof args.query === 'string' ? args.query : null},
        ${args.scope === 'team' ? 'team' : 'mine'}, ${typeof args.limit === 'number' ? Math.floor(args.limit) : 10}) as r`) as unknown as { r: unknown }[];
      const v = typeof r === 'string' ? r : JSON.stringify(r);
      return { content: [text(v === '[]' ? `No ${args.scope === 'team' ? 'team' : 'own'} Claude conversations found${args.query ? ` for "${args.query}"` : ''}.` : v)] };
    }
    case 'upload_attachment': {
      const list = (Array.isArray(args.files) ? args.files : []) as UploadReq[];
      if (!list.length) throw new ToolError('List the files: [{ name, path, kind }].');
      const project = typeof args.project === 'string' && args.project.trim() ? await projectSlug(token, args.project) : null;
      const out = await issueUploads(token, turn.chat, list, project);
      // Not passed through redact(): these are our own one-time addresses, and Claude needs them intact.
      return { content: [{ type: 'text', text: `${project ? `Files go to TALASTUDIO ASSETS/_PROJECTS/${project}/files.\n` : ''}${UPLOAD_HELP}\n\n${out.join('\n\n')}` }] };
    }
    case 'keep_turn': {
      const list = (Array.isArray(args.attached_files) ? args.attached_files : []) as UploadReq[];
      let pending = list;
      if (list.length && turn.chat) {
        const names = list.map((f) => String(f.name ?? '').trim()).filter(Boolean);
        // Arrays go both ways as JSON: through Hyperdrive a text[] parameter or result is not converted.
        const [{ n }] = (await sqlApp`select to_jsonb(mcp.chat_saved_names(${token}, ${turn.chat}::uuid,
          (select coalesce(array_agg(x), '{}') from jsonb_array_elements_text(${sqlApp.json(names)}::jsonb) x))) as n`) as unknown as { n: unknown }[];
        const savedNames = (typeof n === 'string' ? JSON.parse(n) : n) as string[] | null;
        const saved = new Set((Array.isArray(savedNames) ? savedNames : []).map((x) => String(x).toLowerCase()));
        pending = list.filter((f) => !saved.has(String(f.name ?? '').trim().toLowerCase()));
      }
      const parts = [turn.chat ? 'Turn kept for the team.' : 'Noted (send user_message so the turn is kept).'];
      if (list.length && !pending.length) parts.push(`All ${list.length} file(s) are already saved in TalaStudio.`);
      if (pending.length) parts.push(`${pending.length} original file(s) not saved yet. ${UPLOAD_HELP}\n\n${(await issueUploads(token, turn.chat, pending)).join('\n\n')}`);
      parts.push('Now answer the user; end the reply with save_chat (final_answer = your answer word for word).');
      return { content: [{ type: 'text', text: parts.join('\n\n') }] };
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
    case 'project_list': {
      const [{ r }] = (await sqlApp`select mcp.project_list(${token}) as r`) as unknown as { r: unknown }[];
      const v = typeof r === 'string' ? r : JSON.stringify(r);
      return { content: [text(v === '[]' ? 'No project spaces yet. Start one with project_write (project id + project_name), e.g. its INSTRUCTIONS or BRIEF.' : v)] };
    }
    case 'project_open': {
      const [{ r }] = (await sqlApp`select mcp.project_open(${token}, ${String(args.project ?? '')}, ${turn.chat}::uuid) as r`) as unknown as { r: unknown }[];
      const o = (typeof r === 'string' ? JSON.parse(r) : r) as Record<string, unknown> & { instructions?: { text?: string } | null; brief?: { text?: string } | null };
      let v = JSON.stringify(o);
      if (v.length > OUT_CHARS) {
        // Keep the open small enough for every client: long INSTRUCTIONS/BRIEF are cut here and read in full with project_read.
        for (const k of ['instructions', 'brief'] as const) {
          const d = o[k];
          if (d?.text && d.text.length > 15_000) d.text = `${d.text.slice(0, 15_000)}\n[CUT OFF: read the rest with project_read doc "${k.toUpperCase()}".]`;
        }
        v = JSON.stringify(o);
        if (v.length > OUT_CHARS) v = v.slice(0, OUT_CHARS) + '\n[CUT OFF: use project_read for the documents.]';
      }
      return { content: [text(`${v}\n\nFollow the INSTRUCTIONS above. Before relying on a hand-over or decision, open the sources it links. End the work with session_end.`)] };
    }
    case 'project_read': {
      const ver = typeof args.version === 'number' ? Math.floor(args.version) : null;
      const [{ r }] = (await sqlApp`select mcp.project_read(${token}, ${String(args.project ?? '')}, ${String(args.doc ?? '')}, ${ver}::int) as r`) as unknown as { r: unknown }[];
      const o = (typeof r === 'string' ? JSON.parse(r) : r) as Record<string, unknown> & { content: string };
      const parts = Math.max(1, Math.ceil(o.content.length / PART_CHARS));
      const part = Math.min(parts, Math.max(1, typeof args.part === 'number' ? Math.floor(args.part) : 1));
      const body = o.content.slice((part - 1) * PART_CHARS, part * PART_CHARS);
      const { content: _c, ...meta } = o;
      return { content: [text(`${JSON.stringify({ ...meta, chars: o.content.length, part, parts })}\n\n--- ${o.doc} v${o.version}${parts > 1 ? ` (part ${part} of ${parts})` : ''} ---\n${body}${part < parts ? `\n\n[Part ${part} of ${parts}: read part ${part + 1} next.]` : ''}`)] };
    }
    case 'project_write': {
      const [{ r }] = (await sqlApp`select mcp.project_write(${token}, ${String(args.project ?? '')}, ${String(args.doc ?? '')}, ${String(args.content ?? '')},
        ${typeof args.note === 'string' ? args.note : null}, ${typeof args.project_name === 'string' ? args.project_name : null}, ${turn.chat}::uuid) as r`) as unknown as { r: unknown }[];
      const o = (typeof r === 'string' ? JSON.parse(r) : r) as { project: string; doc: string; version: number; project_created: boolean };
      return { content: [text(`${o.project_created ? `Project space "${o.project}" started. ` : ''}Saved ${o.doc} as version ${o.version} in project ${o.project} (older versions stay readable). Every connected Claude sees it with project_open.`)] };
    }
    case 'project_decide': {
      const [{ id }] = (await sqlApp`select mcp.project_decide(${token}, ${String(args.project ?? '')}, ${String(args.decision ?? '')},
        ${typeof args.reason === 'string' ? args.reason : null}, ${typeof args.source === 'string' ? args.source : null}, ${turn.chat}::uuid) as id`) as unknown as { id: number }[];
      return { content: [text(`Decision #${id} recorded in project ${args.project}.`)] };
    }
    case 'session_end': {
      const [{ r }] = (await sqlApp`select mcp.project_session_end(${token}, ${String(args.project ?? '')}, ${turn.chat}::uuid, ${String(args.handoff ?? '')},
        ${typeof args.open_items === 'string' ? args.open_items : null}, ${typeof args.brief === 'string' ? args.brief : null}) as r`) as unknown as { r: unknown }[];
      const o = (typeof r === 'string' ? JSON.parse(r) : r) as { project: string; session: number; brief_version: number | null; files_tied: number };
      return { content: [text(`Hand-over #${o.session} saved in project ${o.project}${o.brief_version ? `; BRIEF is now version ${o.brief_version}` : ''}${o.files_tied ? `; ${o.files_tied} file(s) of this conversation tied to the project` : ''}. The next Claude that opens the project sees it.`)] };
    }
    case 'open_original': {
      const o = await openOriginal(token, email, String(args.id ?? '').trim());
      const dest = `/tmp/${o.name.replace(/[^\w.() -]+/g, '_')}`;
      const tips = /pdf/.test(o.mime) ? `pdfinfo for the page count; pdftoppm -png -r 110 -f N -l N ${shq(dest)} /tmp/page to render page N, then look at the PNG; pdftotext -layout for the text.`
        : /sheet|excel|csv/.test(o.mime) ? 'Read every sheet with pandas (pd.read_excel(path, sheet_name=None)) or openpyxl for formulas and formatting.'
        : /^image\//.test(o.mime) ? 'Look at it at full resolution with your file viewer.' : 'Read it with the tool that fits the format.';
      // Not passed through redact(): our own one-time address, Claude needs it intact.
      return { content: [{ type: 'text', text: `${o.name} (${o.mime}${o.size ? `, ${(o.size / 1048576).toFixed(1)} MB` : ''}${o.exported ? ', exported from Google' : ''})${o.link ? `\nDrive: ${o.link}` : ''}\nRun in your code sandbox:\n\ncurl -sS --fail-with-body -o ${shq(dest)} ${shq(o.url)}\n\nThen: ${tips}\nThe address works 3 times within 30 minutes. If the sandbox cannot connect, say so and use look_at_file / read_file_text instead.` }] };
    }
    case 'read_file_text': {
      const id = String(args.id ?? '').trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ToolError('id is a file result_id (uuid) from search/get_item.');
      const rows = (await ownerQuery(token, `select f.title, f.mime, f.data ->> 'path' as path, c.content_kind, c.summary, c.text, length(c.text) as chars
        from media.files f join media.file_contents c on c.file_id = f.id and c.is_current where f.id = '${id}' and f.deleted_at is null
        order by length(c.text) desc nulls last`, 5)) as { title: string; mime: string; path: string | null; content_kind: string; summary: string | null; text: string | null; chars: number | null }[];
      if (!rows.length || !rows[0].text) throw new ToolError('No extracted text for this file (not read yet, a picture, or an HR document). Try look_at_file or open_original.');
      const t0 = rows[0].text;
      const parts = Math.max(1, Math.ceil(t0.length / PART_CHARS));
      const part = Math.min(parts, Math.max(1, typeof args.part === 'number' ? Math.floor(args.part) : 1));
      return { content: [text(`${JSON.stringify({ file: rows[0].title, mime: rows[0].mime, path: rows[0].path, kind: rows[0].content_kind, chars: t0.length, part, parts })}\n\n${t0.slice((part - 1) * PART_CHARS, part * PART_CHARS)}${part < parts ? `\n\n[Part ${part} of ${parts}: read part ${part + 1} next.]` : ''}`)] };
    }
    case 'look_at_file': {
      const page = typeof args.page === 'number' ? Math.floor(args.page) : 1;
      if (page > 1) {
        // Drive previews only show page 1: render the asked page from the original in Claude's sandbox.
        const o = await openOriginal(token, email, String(args.id ?? '').trim());
        if (!/pdf/.test(o.mime)) throw new ToolError(`${o.name} is not a PDF (${o.mime}); look_at_file without page shows it.`);
        const f = `/tmp/ts_${Date.now().toString(36)}.pdf`;
        return { content: [{ type: 'text', text: `${o.name}: page ${page} is rendered from the original in your code sandbox. Run this in one bash call, then look at the PNG (e.g. with your file viewer):\n\ncurl -sS --fail-with-body -o ${shq(f)} ${shq(o.url)} && pdftoppm -png -r 110 -f ${page} -l ${page} ${shq(f)} /tmp/page_${page} && ls /tmp/page_${page}*.png\n\n(pdfinfo ${shq(f)} gives the page count. The address works 3 times within 30 minutes. If the sandbox cannot connect, say so: the user can open ${o.link ?? 'the file in Drive'}.)` }] };
      }
      const p = await filePreview(String(args.id ?? '').trim(), email);
      return {
        content: [
          text(`File: ${p.name} (${p.mime})${p.link ? `\nLink: ${p.link}` : ''}\n${/pdf|presentation|document/.test(p.mime) ? 'First page preview (other pages: look_at_file with page; whole file: open_original)' : 'Preview image (1600 px; full resolution: open_original)'}:`),
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
      // First project test (23 Nov): Claude.ai loads tools on demand, so a Claude not told about a project never found
      // project_open. Results of a conversation not tied to a project name the project spaces.
      if (!PROJECT_TOOLS.has(name) && name !== 'save_chat' && !error && Array.isArray(res.content)) {
        try {
          const [{ h }] = (await sqlApp`select mcp.project_hint(${token}, ${turn.chat}::uuid) as h`) as unknown as { h: string | null }[];
          if (h) res.content.push({ type: 'text', text: `[TalaStudio project spaces: ${h}. If this conversation is about one of them, call project_open with its id first: it holds that project's instructions, brief, decisions, documents and hand-overs.]` });
        } catch { /* a hint must not break the tool */ }
      }
      // First real use (20 Nov): Claude sent the user's messages but never its own answers. Every result reminds it
      // to finish the turn with save_chat, so the last answer is kept too.
      if (name !== 'save_chat' && name !== 'keep_turn' && Array.isArray(res.content)) {
        res.content.push({ type: 'text', text: '[TalaStudio keeps this conversation: end this reply with save_chat (final_answer = your full answer). If the user attached files that are not saved yet, list them in keep_turn first.]' });
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
