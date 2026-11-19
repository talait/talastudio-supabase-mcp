import type Anthropic from '@anthropic-ai/sdk';
import { sql, sqlApp, readOnlyQuery } from './db';

const COLLECTIONS = ['doheny', 'zuma', 'palisades', 'beechwood', 'calabasas'];

export const tools: Anthropic.Tool[] = [
  {
    name: 'search',
    description:
      'Cari di SEMUA data TalaStudio: file Drive (render, DWG, Blender, PDF, gambar), baris spreadsheet, email, pesan Google Chat (semua grup & DM), post sosial (Buffer/Metricool), desain Canva, GitHub (commit, PR, issue, README). ' +
      'Pakai 2-5 kata kunci inti, bukan kalimat panjang. Coba sinonim Indonesia/Inggris bila hasil sedikit (mis. nakas = night table, meja tv = tv unit).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Kata kunci, mis. "zuma tv unit"' },
        collection: { type: 'string', enum: COLLECTIONS, description: 'Batasi ke satu koleksi (opsional)' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['query'],
    },
  },
  {
    name: 'timeline',
    description:
      'Semua yang bertanggal dalam rentang tanggal (WIB): jadwal post sosial, baris sheet dengan kolom tanggal, email, pesan Google Chat, commit. Pakai untuk pertanyaan "apa jadwal tanggal 11", "minggu ini ada apa".',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD (opsional, default = from)' },
        query: { type: 'string', description: 'Filter kata kunci (opsional), mis. "linkedin"' },
      },
      required: ['from'],
    },
  },
  {
    name: 'recent',
    description: 'Daftar item terbaru. kind: email_thread, chat, social_post, social_idea, commit, pull_request, issue, repo, design, file, atau jenis file (render, ai_render, drawing_dwg, model_3d, video, spreadsheet, document). source gchat = Google Chat, whatsapp = WhatsApp nomor kantor, calendar = acara kalender (kind calendar_event).',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        source: { type: 'string', enum: ['drive', 'email', 'gchat', 'whatsapp', 'calendar', 'buffer', 'metricool', 'canva', 'github', 'upload_app'] },
        status: { type: 'string', description: 'mis. draft, scheduled, sent, error' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: 'website_visitors',
    description: 'Pengunjung situs talastudio.net (pelacak pengunjung): ringkasan (jumlah kunjungan, negara, halaman teratas, link/post pelacak) dan daftar kunjungan terbaru.',
    input_schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } } },
  },
  {
    name: 'workspace_activity',
    description: 'Audit log Google Workspace: siapa melakukan apa dan kapan (Drive, Gmail, Chat, login, admin). Bisa difilter app (drive, gmail, chat, login, admin, calendar, meet, token) dan kata kunci (nama orang, email, judul dokumen).',
    input_schema: { type: 'object', properties: { app: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 300 } } },
  },
  {
    name: 'pc_files',
    description: 'File kerja dari PC tim (drafter, render server) yang ditangkap agen TalaStudio: DWG, Blender (dengan isi objek/material), render, AI render, PDF, BOM. Berisi path asli di PC, pemilik, nama terstruktur di Drive, koleksi, kode produk, status. query = kata kunci path/nama, kode produk, atau koleksi (opsional). Juga daftar PC dan statusnya.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 300 } } },
  },
  {
    name: 'ai_prompts',
    description: 'Log prompt AI tim (ChatGPT, Gemini, AI Studio, Claude): prompt, hasil, gambar yang dihasilkan, disetujui atau tidak, nilai 1–5, komentar, koleksi. Pakai untuk menilai prompt mana yang berhasil dan menyusun prompt berikutnya. query opsional.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 300 } } },
  },
  {
    name: 'staff_directory',
    description: 'Direktori akun Google Workspace (talaliving.com, talastudio.net): nama, email, aktif/ditangguhkan, kapan Gmail/Drive/Kalender akun itu terakhir disinkron. query = nama atau email (opsional). Juga status WhatsApp nomor kantor.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: 'system_log',
    description: 'Log sistem TalaStudio: riwayat sync (sumber, status, jumlah, error), event, dan perubahan tabel (audit, sebelum→sesudah). kind: sync, event, audit, atau kosong untuk semua.',
    input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['sync', 'event', 'audit'] }, limit: { type: 'integer', minimum: 1, maximum: 200 } } },
  },
  {
    name: 'sheet_rows',
    description: 'Ambil baris spreadsheet lengkap (semua kolom), bisa difilter rentang tanggal, kata kunci, atau judul tab. Pakai list_tabs dulu bila belum tahu tab mana.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string' },
        date_to: { type: 'string' },
        query: { type: 'string' },
        tab_title: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
  },
  {
    name: 'list_tabs',
    description: 'Find synced spreadsheets/tabs by name (tolerant: "webtracker" finds WEBSITE TRACKER), best match first, with columns. Check the data map in the system prompt first.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: 'get_item',
    description: 'Buka isi lengkap satu hasil (pakai result_type dan result_id dari search/timeline/recent).',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['file', 'document', 'sheet_row'] },
        id: { type: 'string' },
      },
      required: ['type', 'id'],
    },
  },
  {
    name: 'hr_documents',
    description: 'HR documents (payslips, payroll, attendance/leave, KTP/KK, BPJS). Their content is not in search or the views; only this tool reads it, and only for admins and HR (the tool checks the signed-in user). If it says not allowed, tell the user these are HR documents shown to admins and HR only, without hinting at their content.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Words to match in title, path or text, e.g. a name or month. Empty = latest.' } } },
  },
  {
    name: 'look_at_file',
    description: 'Look at an image, render, drawing or PDF yourself (its picture; PDFs and multi-page files: first page). Use it when the stored description is not enough: colour/finish checks, defects in production photos, what a drawing shows, comparing a render with a sample. id = a file result_id (uuid) from search/timeline/pc_files, or a Google Drive file id. question = what to check in the picture.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' }, question: { type: 'string' } },
      required: ['id', 'question'],
    },
  },
  {
    name: 'collection_context',
    description: 'Semua yang terkait satu koleksi: file, render, gambar kerja, linimasa.',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string', enum: COLLECTIONS } },
      required: ['key'],
    },
  },
  {
    name: 'query_database',
    description: 'Run one read-only SQL SELECT on the "james" views (listed in the system prompt). Use it for counting, grouping, ranking, comparing, filtering by date/person/chat, joining sources, or any question the other tools cannot answer directly. One statement, no semicolons; results are capped at 200 rows, so aggregate or LIMIT. Times are timestamptz: use (col at time zone \'Asia/Jakarta\') for local dates. Text match: ilike \'%word%\'. jsonb: data ->> \'Column\'.',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single SELECT (or WITH … SELECT) statement.' },
        purpose: { type: 'string', description: 'Short note IN ENGLISH (always, whatever language the user writes) of what this query checks, shown to the user as a progress step, e.g. "Counting skipped files by type and owner".' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'remember',
    description: 'Save a fact when the user asks you to remember/note something. scope "me" = about this user only (their role, projects, preferences, how they want answers; shown only in their chats). scope "team" = a company fact for everyone (e.g. "ZM codes are the Zuma collection").',
    input_schema: {
      type: 'object',
      properties: { note: { type: 'string', description: 'The fact, one clear sentence.' }, scope: { type: 'string', enum: ['me', 'team'] } },
      required: ['note', 'scope'],
    },
  },
  {
    name: 'forget',
    description: 'Remove a saved note by id when the user asks. Personal notes are listed under "About this user", team notes under "Team notes"; pass the matching scope.',
    input_schema: { type: 'object', properties: { id: { type: 'number' }, scope: { type: 'string', enum: ['me', 'team'] } }, required: ['id', 'scope'] },
  },
  {
    name: 'run_sync',
    description: 'Ask the sync engine on the office PC to run now (same as the "Sync now" button; it starts within about 30 seconds). Use when the user asks to continue, retry, refresh or re-run something, or after you found a source that is behind or a reading queue that stopped. sources: any of people, drive, sheets, gmail, calendar, chat, github, reader (reads file contents: the queue in file_reading), digest (daily summaries); empty = everything. It only requests the run: check sync_runs / file_reading afterwards for the result.',
    input_schema: { type: 'object', properties: { sources: { type: 'array', items: { type: 'string', enum: ['people', 'drive', 'sheets', 'gmail', 'calendar', 'chat', 'github', 'reader', 'digest'] } } } },
  },
  {
    name: 'past_chats',
    description: 'Search this user\'s own earlier conversations with you (their questions and your answers). Use when they refer to something discussed before ("like last time", "the list you gave me yesterday"). query = keywords, or empty for the latest messages.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } },
  },
  {
    name: 'meaning_search',
    description:
      'Pencarian berdasarkan MAKNA (bukan kata persis) di isi file, email dan pesan chat: menemukan yang membahas hal yang sama walau kata-katanya beda atau bahasanya campur (mis. "keluhan kualitas finishing" menemukan email "the lacquer is peeling"). ' +
      'Pakai bila search (kata kunci) tidak menemukan apa-apa atau pertanyaannya berupa konsep/masalah. Tulis query sebagai satu kalimat pendek yang menjelaskan apa yang dicari. ' +
      'Isi query_en dengan kalimat yang sama dalam bahasa Inggris (wajib bila query bukan bahasa Inggris): model makna paling kuat di bahasa Inggris, dan hasil kedua bahasa digabung.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        query_en: { type: 'string', description: 'The same search sentence in English (required when query is not English).' },
        limit: { type: 'integer', minimum: 1, maximum: 30 },
      },
      required: ['query'],
    },
  },
  {
    name: 'business_trace',
    description:
      'Lacak satu urusan bisnis dari awal sampai akhir: baris PR (pr-26-08-20_01-L10), dokumen PR (pr-26-08-20_01 atau PR/12-JUL-2026-01), batch bayar (pay-…), transfer (trx-…), nomor TS-SO/QT/PO/INQ/SMP, atau nama vendor/proyek (mis. "HADI GLASS", "STANDARD"). ' +
      'Mengembalikan ringkasan (nominal, dibayar, status, jumlah dokumen/bukti) dan linimasa berurutan: diajukan → disetujui → dibayar → diterima, plus email/chat/file yang menyebut nomor itu. ' +
      'Pakai untuk "kenapa…", "sudah dibayar belum", "apa yang terjadi dengan…", "kenapa vendor X komplain". Item berstatus "suggested" adalah dugaan yang belum dikonfirmasi manusia: sebut sebagai dugaan.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Nomor (pr-…, pay-…, trx-…, PR/…, TS-…) atau nama vendor/proyek' },
        limit: { type: 'integer', minimum: 1, maximum: 300 },
      },
      required: ['query'],
    },
  },
  {
    name: 'knowledge_graph',
    description:
      'Graf pengetahuan: cari ORANG, VENDOR, PROYEK, ORGANISASI PEMBELI atau nomor bisnis yang disebut dalam pertanyaan dan kembalikan ringkasannya (total dibayar per vendor, apa saja yang diminta seseorang, vendor dalam satu batch, email dengan satu perusahaan) plus fakta bertanggal di sekitarnya dan hasil gabungan kata kunci+makna+graf. ' +
      'Pakai untuk pertanyaan yang melompat lebih dari satu langkah: "berapa total ke vendor X", "apa saja yang diminta Putri", "pay-… dibayar ke siapa saja", "email dengan Target Furniture". ' +
      'Isi at (YYYY-MM-DD) untuk menanyakan keadaan pada tanggal tertentu ("status pr-… per 5 Sept"): yang dikembalikan hanya fakta yang berlaku saat itu. Fakta dengan invalid_at sudah tidak berlaku.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Pertanyaan atau nama/nomor yang dicari' },
        at: { type: 'string', description: 'Opsional: tanggal YYYY-MM-DD untuk keadaan pada waktu itu (butuh nomor/nama persis di query)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'overview',
    description: 'Ringkasan isi basis data: jumlah per jenis/sumber, koleksi, status sinkron. Pakai untuk "data apa saja yang kamu punya".',
    input_schema: { type: 'object', properties: {} },
  },
];

export type Source = { title: string; url: string };

const MAX_CHARS = 14000;
const clip = (v: unknown, max = MAX_CHARS) => {
  const s = JSON.stringify(v);
  return s.length > max
    ? s.slice(0, max) + '…\n[RESULT CUT OFF: only the first part is shown. Do not conclude that something is missing; narrow the search or count/filter with query_database.]'
    : s;
};
/** Kolom kata sandi/PIN/OTP/token di spreadsheet tidak dikirim ke model. */
const SECRET_KEY = /(password|passwd|kata sandi|sandi|passcode|\bpin\b|otp|secret|token|api key)/i;
function hideSecrets(d: unknown): unknown {
  let o = d;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return d; } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  return Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([k]) => !SECRET_KEY.test(k)));
}
const n = (v: unknown, d: number) => (typeof v === 'number' && v > 0 ? Math.floor(v) : d);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function toolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'search': return `Searching "${input.query}"`;
    case 'timeline': return `Checking the schedule ${input.from}${input.to ? ' – ' + input.to : ''}`;
    case 'recent': return `Looking at the latest ${input.kind ?? 'items'}`;
    case 'sheet_rows': return 'Reading spreadsheet rows';
    case 'list_tabs': return 'Listing spreadsheets';
    case 'get_item': return 'Opening details';
    case 'look_at_file': return 'Looking at the file';
    case 'hr_documents': return 'Checking HR documents';
    case 'collection_context': return `Opening the ${input.key} collection`;
    case 'overview': return 'Reviewing the data overview';
    case 'website_visitors': return 'Checking website visitors';
    case 'workspace_activity': return 'Checking Workspace activity';
    case 'system_log': return 'Reading the system log';
    case 'staff_directory': return 'Checking the staff directory';
    case 'pc_files': return 'Looking at files from team PCs';
    case 'ai_prompts': return 'Reading the AI prompt log';
    case 'query_database': return typeof input.purpose === 'string' && input.purpose.trim() ? String(input.purpose).slice(0, 80) : 'Querying the database';
    case 'remember': return input.scope === 'me' ? 'Saving to your memory' : 'Saving a team note';
    case 'forget': return 'Removing a note';
    case 'past_chats': return 'Looking through earlier chats';
    case 'run_sync': return 'Asking the sync engine to run';
    case 'business_trace': return `Tracing ${String(input.query ?? '').slice(0, 40)}`;
    case 'meaning_search': return `Searching by meaning "${String(input.query ?? '').slice(0, 40)}"`;
    case 'knowledge_graph': return `Checking the knowledge graph for "${String(input.query ?? '').slice(0, 40)}"`;
    default: return name;
  }
}

/** Pemeriksaan ringan sebelum query James dijalankan (penjaga utamanya tetap transaksi READ ONLY + peran baca). */
export function checkSql(q: string): string | null {
  const s = q.trim().replace(/;\s*$/, '');
  // A query may open with comments or a parenthesis: "(select …) union (select …)", "-- note\nselect …".
  const head = s.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\()+/, '');
  if (!/^(select|with|values)\b/i.test(head)) return 'Only a single SELECT (or WITH … SELECT) statement is allowed.';
  // Titik koma di dalam teks ('a;b') atau komentar bukan pemisah perintah.
  if (s.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').includes(';')) return 'Only one statement is allowed: remove the semicolons.';
  const bare = s.replace(/'(?:[^']|'')*'/g, "''");
  if (/\b(?!james\b)[a-z_][a-z0-9_]*\s*\.\s*[a-z_][a-z0-9_]*\s*\(/i.test(bare) || /"[^"]+"\s*\.\s*("[^"]+"|\w+)\s*\(/.test(bare)) return 'Only the james views (and plain SQL functions) can be used here; functions of other schemas are not allowed.';
  if (/\b(pg_sleep|pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export|dblink|set_config|pg_terminate_backend|pg_cancel_backend)\b/i.test(s)) return 'That function is not allowed.';
  if (/\b(insert|update|delete|merge|alter|drop|create|grant|revoke|truncate|copy|vacuum|lock)\s/i.test(s.replace(/'[^']*'/g, "''"))) return 'Only reading is allowed.';
  return null;
}

/** James melihat gambarnya sendiri: thumbnail Drive besar (halaman pertama untuk PDF) dibaca model vision dengan pertanyaannya. */
export async function filePreview(id: string, email?: string | null): Promise<{ name: string; mime: string; link?: string; type: string; data: string }> {
  if (!id) throw new Error('Give the file id.');
  let driveId = id;
  let via: string | null = null;
  if (/^[0-9a-f-]{36}$/i.test(id)) {
    const [{ r }] = await sql`select media.file_drive(${id}::uuid) as r`;
    const f = (typeof r === 'string' ? JSON.parse(r) : r) as { drive_id?: string; via?: string; restricted?: string } | null;
    if (!f?.drive_id) throw new Error('No Drive file is linked to this id. Use the stored description from get_item instead.');
    if (f.restricted) {
      const [{ ok }] = await sql`select (ai.hr_documents(${email ?? ''}, '', 1) ->> 'allowed')::boolean as ok`;
      if (!ok) throw new Error('This is an HR document: only admins and HR may open it.');
    }
    driveId = f.drive_id;
    via = f.via ?? null;
  } else if (!/^[\w-]{10,}$/.test(id)) throw new Error('That is not a file id.');
  else {
    const [{ hr }] = await sql`select media.drive_restricted(${id}) as hr`;
    if (hr) {
      const [{ ok }] = await sql`select (ai.hr_documents(${email ?? ''}, '', 1) ->> 'allowed')::boolean as ok`;
      if (!ok) throw new Error('This is an HR document: only admins and HR may open it.');
    }
  }
  const { googleToken, googleTokenAs } = await import('./google');
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveId)}?fields=name,mimeType,thumbnailLink,webViewLink&supportsAllDrives=true`;
  let token = await googleToken();
  let meta = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  // Bukan di Shared Drive upload: coba baca atas nama akun yang menyinkronkan file ini (data.via).
  if (meta.status === 404 && via && /@(talaliving\.com|talastudio\.net)$/i.test(via)) {
    token = await googleTokenAs(via);
    meta = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!meta.ok) throw new Error(meta.status === 404 ? `The workspace cannot open this Drive file (no access${via ? ` even as ${via}` : ''}, or deleted). Use the stored description from get_item.` : `Drive ${meta.status}`);
  const m = (await meta.json()) as { name: string; mimeType: string; thumbnailLink?: string; webViewLink?: string };
  if (!m.thumbnailLink) throw new Error(`Drive has no preview for ${m.name} (${m.mimeType}). Use the stored description from get_item.`);
  const img = await fetch(m.thumbnailLink.replace(/=s\d+$/, '=s1600'), { headers: { Authorization: `Bearer ${token}` } });
  if (!img.ok) throw new Error(`Preview download failed (${img.status}).`);
  const type = (img.headers.get('content-type') ?? 'image/jpeg').split(';')[0];
  const data = Buffer.from(await img.arrayBuffer()).toString('base64');
  return { name: m.name, mime: m.mimeType, link: m.webViewLink, type, data };
}

async function lookAtFile(id: string, question: string, email?: string | null): Promise<Record<string, unknown>> {
  const { name, mime, link, type, data } = await filePreview(id, email);
  const m = { name, mimeType: mime, webViewLink: link };
  const { completeOnce } = await import('./llm');
  const seen = await completeOnce(
    'You look at one company file (furniture renders, drawings, production photos, documents) for a colleague. Answer the question from what is visible only. Be specific about colours, finishes, materials, dimensions and text you can read; say plainly what cannot be judged from the picture (e.g. exact colour on screen vs real sample).',
    [{ type: 'image', source: { type: 'base64', media_type: type as 'image/jpeg', data } }, { type: 'text', text: `File: ${m.name} (${m.mimeType}).\nQuestion: ${question}` }],
    1200,
  );
  return { file: m.name, mime: m.mimeType, link: m.webViewLink, looked_at: /pdf|presentation|document/.test(m.mimeType) ? 'first page preview' : 'preview image (1600 px)', answer: seen };
}

export async function runTool(name: string, input: Record<string, unknown>, ctx: { email?: string | null; chatId?: string | null; maxChars?: number } = {}): Promise<{ text: string; sources: Source[] }> {
  // Akun uji (ujian James dari PC kantor): tidak boleh menulis catatan tim atau menjalankan sync.
  if (/^qa-(bot|member)@/i.test(ctx.email ?? '') && ['remember', 'forget', 'run_sync'].includes(name)) {
    return { text: 'This is a test account: notes and sync requests are disabled here. Answer without them.', sources: [] };
  }
  let rows: Record<string, unknown>[] | unknown = [];
  switch (name) {
    case 'query_database': {
      const q = String(input.sql ?? '').trim().replace(/;\s*$/, '');
      const bad = checkSql(q);
      if (bad) throw new Error(bad);
      const r = await readOnlyQuery(q, 200);
      rows = { row_count: r.length, capped: r.length >= 200, rows: r };
      break;
    }
    case 'remember': {
      const note = str(input.note);
      if (!note || note.length < 3) throw new Error('The note is empty.');
      if (input.scope === 'me') {
        if (!ctx.email) throw new Error('Personal notes need a signed-in account.');
        const [{ id }] = await sqlApp`select ai.james_user_note_add(${ctx.email}, ${note.slice(0, 600)}, ${ctx.chatId ?? null}::uuid, 'user') as id`;
        return { text: `Saved to this user's memory as #${id}. Only they see it.`, sources: [] };
      }
      const [{ id }] = await sqlApp`select ai.james_note_add(${ctx.email ?? 'unknown'}, ${note.slice(0, 1000)}) as id`;
      return { text: `Saved as team note #${id}. It will be in every future conversation.`, sources: [] };
    }
    case 'forget': {
      if (input.scope === 'me') {
        const [{ ok }] = await sqlApp`select ai.james_user_note_remove(${ctx.email ?? ''}, ${Number(input.id)}::bigint) as ok`;
        return { text: ok ? `Personal note #${input.id} removed.` : `No active personal note #${input.id}.`, sources: [] };
      }
      const [{ ok }] = await sqlApp`select ai.james_note_remove(${ctx.email ?? 'unknown'}, ${Number(input.id)}::bigint) as ok`;
      return { text: ok ? `Team note #${input.id} removed.` : `No active team note #${input.id}.`, sources: [] };
    }
    case 'run_sync': {
      const OK = ['people', 'drive', 'sheets', 'gmail', 'calendar', 'chat', 'github', 'reader', 'digest'];
      const sources = (Array.isArray(input.sources) ? input.sources : []).map(String).filter((x) => OK.includes(x));
      const by = `${ctx.email ?? 'workspace'} (via James)`;
      try {
        // Daftar sumber dikirim sebagai JSON lalu diubah ke text[] di SQL (koneksi ini tidak mengirim array secara langsung).
        if (sources.length) await sqlApp`select core.sync_request_sources(${by}, array(select jsonb_array_elements_text(${JSON.stringify(sources)}::jsonb)))`;
        else await sqlApp`select core.sync_request_now(${by})`;
      } catch {
        return { text: 'The request could not be sent from here. Do not quote any error. Tell the user in plain words that you could not start it yourself and that IT can press "Sync now" on the Sync page.', sources: [] };
      }
      return { text: `Requested: the sync engine will run ${sources.length ? sources.join(', ') : 'all sources'} within about 30 seconds. This is only the request; the result appears in sync_runs (and file_reading for the reader).`, sources: [] };
    }
    case 'past_chats': {
      if (!ctx.email) return { text: 'Chat history is not available without a signed-in account.', sources: [] };
      rows = await sqlApp`select chat_title, role, content, created_at from ai.james_chat_search(${ctx.email}, ${str(input.query)}, ${n(input.limit, 20)})`;
      break;
    }
    case 'search':
      rows = await sql`select result_type, result_id, title, snippet, keys, location, at
                       from ai.search(${String(input.query)}, ${n(input.limit, 15)}, ${str(input.collection) ? 'collection' : null}, ${str(input.collection)})`;
      break;
    case 'timeline':
      rows = await sql`select result_type, result_id, day, at, title, detail, source, location
                       from ai.timeline(${String(input.from)}::date, ${str(input.to)}::date, ${str(input.query)}, 150)`;
      break;
    case 'recent':
      rows = await sql`select * from ai.recent(${str(input.kind)}, ${str(input.source)}, ${str(input.status)}, ${n(input.limit, 15)})`;
      break;
    case 'sheet_rows':
      rows = ((await sql`select spreadsheet, tab, row_number, row_date, data, url
                       from ai.sheet_rows(${str(input.date_from)}::date, ${str(input.date_to)}::date, ${str(input.query)}, null, ${str(input.tab_title)}, ${n(input.limit, 60)})`) as unknown as { data: unknown }[])
        .map((x) => ({ ...x, data: hideSecrets(x.data) }));
      break;
    case 'list_tabs': {
      // Pencarian toleran ("webtracker" → WEBSITE TRACKER), urut dari yang paling cocok. Daftar panjang tanpa kolom supaya tidak terpotong.
      const q = str(input.query);
      const r = (await sql`select spreadsheet, tab, columns, date_column, row_count, last_synced_at, url, score from ai.list_tabs2(${q}, ${q ? 25 : 100})`) as unknown as Record<string, unknown>[];
      rows = r.length > 12 ? r.map(({ columns: _c, ...x }) => x) : r;
      if (q && !r.length) rows = { matches: [], note: `No tab name matches "${q}". Try another word, or query_database on sheet_rows/the data map before saying it does not exist.` };
      break;
    }
    case 'get_item': {
      const id = String(input.id ?? '').trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new Error(`get_item needs the result_id (a uuid) from search/timeline/sheet_rows, not "${id.slice(0, 80)}". To find a file by its name, use search with the name.`);
      }
      if (input.type === 'file') rows = (await sql`select ai.get_file(${id}::uuid) as item`)[0]?.item;
      else if (input.type === 'document') rows = (await sql`select ai.get_document(${id}::uuid) as item`)[0]?.item;
      else rows = (await sql`select ai.get_sheet_row(${id}::uuid) as item`)[0]?.item;
      break;
    }
    case 'hr_documents': {
      rows = (await sql`select ai.hr_documents(${ctx.email ?? ''}, ${str(input.query) ?? null}, 20) as r`)[0]?.r;
      break;
    }
    case 'look_at_file': {
      rows = await lookAtFile(String(input.id ?? '').trim(), str(input.question) ?? 'Describe what you see.', ctx.email);
      break;
    }
    case 'collection_context':
      rows = (await sql`select ai.entity_context(${String(input.key)}, 'collection', 40) as ctx`)[0]?.ctx;
      break;
    case 'overview':
      rows = { overview: (await sql`select ai.overview() as o`)[0]?.o, data_as_of: (await sql`select ai.data_as_of() as d`)[0]?.d };
      break;
    case 'meaning_search': {
      const [{ ep }] = await sql`select ai.embed_endpoint() as ep`;
      const e = (typeof ep === 'string' ? JSON.parse(ep) : ep) as { url?: string; key?: string } | null;
      if (!e?.url || !e.key) return { text: 'Meaning search is not set up yet. Use search instead.', sources: [] };
      const embed = async (text: string) => {
        const r = await fetch(e.url!, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${e.key}` },
          body: JSON.stringify({ mode: 'query', text: text.slice(0, 1500) }) }).catch(() => null);
        const j = r && r.ok ? ((await r.json().catch(() => null)) as { embedding?: number[] } | null) : null;
        return j?.embedding?.length ? j.embedding : null;
      };
      // Model makna (gte-small) kuat di bahasa Inggris dan lemah di bahasa Indonesia: cari dengan kedua kalimat, gabung dengan RRF.
      const texts = [String(input.query ?? ''), String(input.query_en ?? '')].map((t) => t.trim()).filter((t, i, a) => t && a.indexOf(t) === i);
      const vecs = (await Promise.all(texts.map(embed))).filter((v): v is number[] => !!v);
      if (!vecs.length) return { text: 'Meaning search is unavailable right now. Use search with keywords instead.', sources: [] };
      const [{ st }] = await sql`select ai.embed_status() as st`;
      const lim = n(input.limit, 12);
      type Hit = { result_type: string; result_id: string; title: string; snippet: string; source: string; location: string | null; at: string | null; similarity: number };
      const lists = await Promise.all(vecs.map((v) => sql`select result_type, result_id, title, snippet, source, location, at, round(similarity::numeric, 3) as similarity
                                                           from ai.semantic_search(${JSON.stringify(v)}, ${Math.min(30, lim * 2)})` as unknown as Promise<Hit[]>));
      const score = new Map<string, { h: Hit; s: number }>();
      for (const list of lists) list.forEach((h, i) => {
        const k = `${h.result_type}:${h.result_id}`;
        const cur = score.get(k) ?? { h, s: 0 };
        cur.s += 1 / (60 + i);
        if (Number(h.similarity) > Number(cur.h.similarity)) cur.h = h;
        score.set(k, cur);
      });
      const hits = [...score.values()].sort((a, b) => b.s - a.s).slice(0, lim).map((x) => x.h);
      rows = { coverage: st, searched_with: texts, results: hits, note: 'similarity 1 = identical meaning; below about 0.80 is usually only loosely related' };
      break;
    }
    case 'business_trace': {
      const q = String(input.query ?? '').trim();
      const [{ s }] = await sql`select biz.summary(${q}) as s`;
      const items = await sql`select at, item, kind, code, left(text, 700) as text, source, location, status, confidence
                              from biz.timeline(${q}, ${n(input.limit, 120)})`;
      rows = (Array.isArray(s) && s.length) || (items as unknown[]).length
        ? { summary: s, timeline: items, data_as_of: (await sql`select ai.data_as_of() as d`)[0]?.d, note: 'status "suggested" = dugaan, belum dikonfirmasi manusia' }
        : { summary: [], timeline: [], note: `Tidak ada nomor/vendor/proyek yang cocok dengan "${q}". Coba nomor lengkap atau nama vendor persis seperti di PURCHASE-PAYMENT TRACKER, atau cari dengan search.` };
      break;
    }
    case 'knowledge_graph': {
      const q = String(input.query ?? '').trim().slice(0, 500);
      const at = str(input.at);
      if (at && /^\d{4}-\d{2}-\d{2}$/.test(at)) {
        const ents = (await sql`select key from kg.match_entities(${q}, 5) order by score desc limit 3`) as unknown as { key: string }[];
        const asOf: { key: string; facts: unknown }[] = [];
        for (const e of ents) {
          asOf.push({ key: e.key, facts: await sql`select fact, pred, value, valid_at, invalid_at from kg.facts_at(${e.key}, (${at}::date + 1)::timestamptz)` });
        }
        rows = { as_of: at, entities: asOf, note: 'only facts that were true on that date' };
      } else {
        const [{ c, d, p }] = await sql`select kg.context(${q}, ${n(input.limit, 12)}) as c, ai.data_as_of() as d, kg.person_requests(${q}) as p`;
        // Pertanyaan "apa saja yang diminta X": daftar permintaan orang itu ditaruh paling depan supaya tidak terpotong.
        rows = p ? { person_requests: p, data_as_of: d, ...(c as object) } : { ...(c as object), data_as_of: d };
      }
      break;
    }
    case 'website_visitors': {
      const [{ s }] = await sql`select ai.visitor_summary() as s`;
      const list = await sql`select * from ai.visitor_list(${n(input.limit, 40)})`;
      rows = { summary: s, visits: list };
      break;
    }
    case 'pc_files': {
      const devices = await sql`select host, owner, agent_version, last_seen, files, uploaded, queued, failed from ai.pc_devices()`;
      const files = await sql`select host, owner, path, drive_name, kind, collection, product, status, modified_at, location, summary from ai.pc_files(${str(input.query)}, ${n(input.limit, 60)})`;
      rows = { devices, files };
      break;
    }
    case 'ai_prompts':
      rows = await sql`select app, role, left(text, 1500) as text, images, captured_by, approved, score, comment, collection, created_at, conversation_url
                       from ai.prompt_list(${str(input.query)}, ${n(input.limit, 60)})`;
      break;
    case 'staff_directory': {
      const people = await sql`select * from ai.people_list(${str(input.query)})`;
      const [{ w }] = await sql`select ai.whatsapp_status() - 'qr' as w`;
      rows = { people, whatsapp: w };
      break;
    }
    case 'system_log':
      rows = await sql`select at, kind, source, title, status, left(detail, 600) as detail from ai.system_log(${str(input.kind)}, ${n(input.limit, 60)})`;
      break;
    case 'workspace_activity': {
      const [{ s }] = await sql`select ai.ws_summary() as s`;
      const list = await sql`select at, app, event_name, actor, doc_title, location from ai.ws_activity_list(${str(input.app)}, ${str(input.query)}, ${n(input.limit, 80)})`;
      rows = { summary: s, events: list };
      break;
    }
    default:
      return { text: `Unknown tool ${name}`, sources: [] };
  }
  return { text: clip(rows ?? 'not found', ctx.maxChars), sources: collectSources(rows) };
}

function collectSources(v: unknown): Source[] {
  const out: Source[] = [];
  const visit = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(visit);
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      const url = (o.location ?? o.url ?? o.external_url) as string | undefined;
      const title = (o.title ?? o.tab ?? o.spreadsheet) as string | undefined;
      if (typeof url === 'string' && url.startsWith('http') && title) out.push({ title: String(title).slice(0, 90), url });
      for (const k of ['files', 'items', 'timeline', 'results']) if (k in o) visit(o[k]);
    }
  };
  visit(v);
  return out.slice(0, 12);
}
