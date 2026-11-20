import { sqlApp } from './db';
import { ensureFolder, putChunk, startResumable } from './james/google';

/**
 * Files from Claude chats go to Drive TALASTUDIO ASSETS/_CLAUDE/<person>/<YYYY-MM-DD WIB>/ as they are (no conversion),
 * uploaded by the workspace service account, then logged in mcp.saved_files. The Drive sync picks them up like any
 * other file in the Shared Drive, so their content becomes searchable for James and everyone. Files are never
 * overwritten: saving the same name again makes a new file next to the old one.
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

export const cleanName = (n: unknown) => String(n ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 180);
export function mimeFor(name: string, given?: string | null): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  return (given && /^[\w.+-]+\/[\w.+-]+$/.test(given) && given !== 'application/octet-stream' ? given : MIME[ext]) ?? given ?? 'application/octet-stream';
}

/** Upload bytes (or a stream of known length) to _CLAUDE/<person>/<YYYY-MM-DD WIB>/ in the upload Shared Drive. */
export async function uploadToClaudeFolder(target: { email: string; drive_id: string; drive_root: string }, o: {
  name: string; mime: string; size: number; body: ReadableStream<Uint8Array> | ArrayBuffer; kind: 'input' | 'output'; description?: string | null;
}) {
  if (!target?.drive_id || !target.drive_root) throw new Error('The upload folder is not configured (upload.drive_id / upload.drive_root).');
  const person = target.email.split('@')[0];
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
  let parent = target.drive_root;
  for (const f of ['_CLAUDE', person, day]) parent = await ensureFolder(f, parent, target.drive_id);
  const session = await startResumable({
    name: o.name, mime: o.mime, size: o.size, parentId: parent,
    description: `${o.kind === 'input' ? 'Given to Claude by' : 'Made by Claude for'} ${target.email} through the TalaStudio connector.${o.description ? `\n${o.description.slice(0, 1500)}` : ''}`,
    appProperties: { ts_source: 'claude_connector', ts_by: target.email.slice(0, 100), ts_kind: o.kind },
  });
  const r = await putChunk(session, o.body, 0, o.size, o.size);
  if (!('file' in r)) throw new Error('Google Drive did not finish the upload.');
  return { file: r.file, folder: `TALASTUDIO ASSETS/_CLAUDE/${person}/${day}` };
}

export async function saveFile(token: string, a: {
  name: string; text?: string; content_base64?: string; mime?: string; kind?: string; description?: string; chat_key?: string;
}): Promise<SavedFile> {
  const name = cleanName(a.name);
  if (!name) throw new Error('Give the file a name with its extension, e.g. "vendor-risk.md".');
  let bytes: Uint8Array;
  if (typeof a.content_base64 === 'string' && a.content_base64.trim()) {
    const b64 = a.content_base64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    const bin = atob(b64);
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } else if (typeof a.text === 'string' && a.text.length) {
    bytes = new TextEncoder().encode(a.text);
  } else throw new Error('Send the file content: "text" for text files, or "content_base64" for any file.');
  if (bytes.byteLength > MAX_BYTES) throw new Error(`The file is ${(bytes.byteLength / 1048576).toFixed(1)} MB; the limit is 20 MB. For bigger or binary files use upload_attachment.`);
  const mime = mimeFor(name, a.mime);
  const kind = a.kind === 'input' ? 'input' : 'output';

  const [{ t }] = (await sqlApp`select mcp.upload_target(${token}) as t`) as unknown as { t: unknown }[];
  const target = (typeof t === 'string' ? JSON.parse(t) : t) as { email: string; drive_id: string; drive_root: string };
  const { file: f, folder } = await uploadToClaudeFolder(target, {
    name, mime, size: bytes.byteLength, kind, description: a.description,
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  });
  const [{ id }] = (await sqlApp`select mcp.file_saved(${token}, ${kind}, ${name}, ${mime}, ${bytes.byteLength}, ${target.drive_id},
    ${f.id}, ${f.webViewLink ?? null}, ${a.description ?? null}, ${a.chat_key ?? null}) as id`) as unknown as { id: number }[];
  return { id, name: f.name, link: f.webViewLink, drive_file: f.id, folder, size: bytes.byteLength };
}

