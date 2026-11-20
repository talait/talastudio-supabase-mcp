import { sqlApp } from './db';
import { ensureFolder, putChunk, startResumable } from './james/google';

/**
 * Files from Claude chats go to Drive TALASTUDIO ASSETS/_CLAUDE/<person>/<YYYY-MM-DD WIB>/ as they are (no conversion),
 * uploaded by the workspace service account, then logged in mcp.saved_files. The Drive sync picks them up like any
 * other file in the Shared Drive, so their content becomes searchable for James and everyone.
 */
const MAX_BYTES = 20 * 1024 * 1024;

const MIME: Record<string, string> = {
  md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
  html: 'text/html', htm: 'text/html', xml: 'application/xml', svg: 'image/svg+xml', pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  dwg: 'image/vnd.dwg', dxf: 'image/vnd.dxf', zip: 'application/zip',
};

export type SavedFile = { id: number; name: string; link?: string; drive_file: string; folder: string; size: number };

export async function saveFile(token: string, a: {
  name: string; text?: string; content_base64?: string; mime?: string; kind?: string; description?: string; chat_key?: string;
}): Promise<SavedFile> {
  const name = String(a.name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 180);
  if (!name) throw new Error('Give the file a name with its extension, e.g. "vendor-risk.md".');
  let bytes: Uint8Array;
  if (typeof a.content_base64 === 'string' && a.content_base64.trim()) {
    const b64 = a.content_base64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    const bin = atob(b64);
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } else if (typeof a.text === 'string' && a.text.length) {
    bytes = new TextEncoder().encode(a.text);
  } else throw new Error('Send the file content: "text" for text files, or "content_base64" for any file.');
  if (bytes.byteLength > MAX_BYTES) throw new Error(`The file is ${(bytes.byteLength / 1048576).toFixed(1)} MB; the limit is 20 MB.`);
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  const mime = (a.mime && /^[\w.+-]+\/[\w.+-]+$/.test(a.mime) ? a.mime : MIME[ext]) ?? 'application/octet-stream';

  const [{ t }] = (await sqlApp`select mcp.upload_target(${token}) as t`) as unknown as { t: unknown }[];
  const target = (typeof t === 'string' ? JSON.parse(t) : t) as { email: string; drive_id: string; drive_root: string };
  if (!target?.drive_id || !target.drive_root) throw new Error('The upload folder is not configured (upload.drive_id / upload.drive_root).');
  const person = target.email.split('@')[0];
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
  let parent = target.drive_root;
  for (const f of ['_CLAUDE', person, day]) parent = await ensureFolder(f, parent, target.drive_id);

  const kind = a.kind === 'input' ? 'input' : 'output';
  const session = await startResumable({
    name, mime, size: bytes.byteLength, parentId: parent,
    description: `${kind === 'input' ? 'Given to Claude by' : 'Made by Claude for'} ${target.email} through the TalaStudio connector.${a.description ? `\n${a.description.slice(0, 1500)}` : ''}`,
    appProperties: { ts_source: 'claude_connector', ts_by: target.email.slice(0, 100), ts_kind: kind },
  });
  const r = await putChunk(session, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 0, bytes.byteLength, bytes.byteLength);
  if (!('file' in r)) throw new Error('Google Drive did not finish the upload.');
  const f = r.file;
  const [{ id }] = (await sqlApp`select mcp.file_saved(${token}, ${kind}, ${name}, ${mime}, ${bytes.byteLength}, ${target.drive_id},
    ${f.id}, ${f.webViewLink ?? null}, ${a.description ?? null}, ${a.chat_key ?? null}) as id`) as unknown as { id: number }[];
  return { id, name: f.name, link: f.webViewLink, drive_file: f.id, folder: `TALASTUDIO ASSETS/_CLAUDE/${person}/${day}`, size: bytes.byteLength };
}
