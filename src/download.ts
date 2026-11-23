import { sql, sqlApp } from './db';
import { googleToken, googleTokenAs } from './james/google';
import { MCP_ORIGIN } from './lib';

/**
 * Originals for Claude's code sandbox (owner decision 23 Nov 2026): a preview shows only the first page of a PDF and
 * a picture of a spreadsheet. open_original hands out a one-time address mcp.talastudio.net/download/<ticket>; the
 * sandbox fetches the original file with curl and reads it with its own tools (every PDF page, exact Excel cells).
 * The ticket is the permission: one account, 30 minutes, 3 downloads, hash only (mcp.download_tickets). HR files are
 * checked before a ticket is made (admins and access.hr only), exactly like look_at_file.
 */
const DRIVE = 'https://www.googleapis.com/drive/v3';
const COMPANY = /@(talaliving\.com|talastudio\.net)$/i;

// Google-native files have no bytes of their own: they are exported to the format Claude's tools read best.
const EXPORT: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.presentation': { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  'application/vnd.google-apps.drawing': { mime: 'image/png', ext: 'png' },
};

type Meta = { name: string; mimeType: string; size?: string; webViewLink?: string };

async function driveFetch(path: string, via: string | null): Promise<{ res: Response; token: string }> {
  let token = await googleToken();
  let res = await fetch(`${DRIVE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  // Not in the upload Shared Drive: read it as the company account that synced it (domain-wide delegation, read-only).
  if (res.status === 404 && via && COMPANY.test(via)) {
    token = await googleTokenAs(via);
    res = await fetch(`${DRIVE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  }
  return { res, token };
}

const hrAllowed = async (email: string) => {
  const [{ ok }] = (await sql`select (ai.hr_documents(${email}, '', 1) ->> 'allowed')::boolean as ok`) as unknown as { ok: boolean | null }[];
  return Boolean(ok);
};

/** Resolve a file id (media.files uuid or Drive id), check HR rights, and make a download ticket. */
export async function openOriginal(token: string, email: string, id: string): Promise<{ name: string; mime: string; size: number | null; link?: string; url: string; exported: boolean }> {
  let driveId = id;
  let via: string | null = null;
  if (/^[0-9a-f-]{36}$/i.test(id)) {
    const [{ r }] = (await sql`select media.file_drive(${id}::uuid) as r`) as unknown as { r: unknown }[];
    const f = (typeof r === 'string' ? JSON.parse(r) : r) as { drive_id?: string; via?: string; restricted?: string } | null;
    if (!f?.drive_id) throw new Error('No Drive file is linked to this id. Use get_item / read_file_text for its stored content.');
    if (f.restricted && !(await hrAllowed(email))) throw new Error('This is an HR document: only admins and HR may open it.');
    driveId = f.drive_id;
    via = f.via ?? null;
  } else if (!/^[\w-]{10,}$/.test(id)) {
    throw new Error('That is not a file id: give a result_id (uuid) from search/get_item/project_open, or a Google Drive file id.');
  } else {
    const [{ hr }] = (await sql`select media.drive_restricted(${id}) as hr`) as unknown as { hr: boolean | null }[];
    if (hr && !(await hrAllowed(email))) throw new Error('This is an HR document: only admins and HR may open it.');
  }
  const { res } = await driveFetch(`/files/${encodeURIComponent(driveId)}?fields=name,mimeType,size,webViewLink&supportsAllDrives=true`, via);
  if (!res.ok) throw new Error(res.status === 404 ? 'The workspace cannot open this Drive file (no access, or deleted).' : `Drive ${res.status}`);
  const m = (await res.json()) as Meta;
  if (m.mimeType === 'application/vnd.google-apps.folder') throw new Error(`${m.name} is a folder, not a file.`);
  const exp = EXPORT[m.mimeType];
  if (m.mimeType.startsWith('application/vnd.google-apps.') && !exp) throw new Error(`${m.name} (${m.mimeType}) cannot be downloaded as a file.`);
  const name = exp ? `${m.name.replace(/\.[A-Za-z0-9]{1,6}$/, '')}.${exp.ext}` : m.name;
  const [{ t }] = (await sqlApp`select mcp.download_ticket_new(${token}, ${driveId}, ${via}, ${name}, ${m.mimeType}, ${exp?.mime ?? null}) as t`) as unknown as { t: unknown }[];
  const { ticket } = (typeof t === 'string' ? JSON.parse(t) : t) as { ticket: string };
  return { name, mime: exp?.mime ?? m.mimeType, size: m.size ? Number(m.size) : null, link: m.webViewLink, url: `${MCP_ORIGIN}/download/${ticket}`, exported: Boolean(exp) };
}

const fail = (msg: string, status: number) => Response.json({ error: msg }, { status, headers: { 'Cache-Control': 'no-store' } });

/** GET /download/<ticket>: stream the original (or the export of a Google-native file) to the caller. */
export async function download(req: Request, ticket: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(ticket)) return new Response('Not found', { status: 404 });
  if (req.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
  const [{ d }] = (await sqlApp`select mcp.download_ticket_take(${ticket}) as d`) as unknown as { d: unknown }[];
  const tk = (d == null ? null : typeof d === 'string' ? JSON.parse(d) : d) as { drive_file: string; via: string | null; name: string; mime: string | null; export_mime: string | null } | null;
  if (!tk) return fail('This download address has expired or was used 3 times. Ask Claude for a new one (open_original).', 410);
  const path = tk.export_mime
    ? `/files/${encodeURIComponent(tk.drive_file)}/export?mimeType=${encodeURIComponent(tk.export_mime)}`
    : `/files/${encodeURIComponent(tk.drive_file)}?alt=media&supportsAllDrives=true`;
  const { res } = await driveFetch(path, tk.via);
  if (!res.ok || !res.body) return fail(`Google Drive answered ${res.status}. Try again, or ask for a new address.`, 502);
  const headers = new Headers({
    'Content-Type': tk.export_mime ?? res.headers.get('content-type') ?? tk.mime ?? 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(tk.name)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  const len = res.headers.get('content-length');
  if (len) headers.set('Content-Length', len);
  return new Response(res.body, { status: 200, headers });
}
