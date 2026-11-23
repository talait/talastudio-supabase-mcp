import { sqlApp } from './db';
import { cleanName, mimeFor, uploadToClaudeFolder } from './drive';

/**
 * One-time upload addresses: mcp.talastudio.net/upload/<ticket> (made by the upload_attachment tool).
 *
 * Claude never holds the bytes of a chat attachment (it sees a read-out), so the original file is sent by Claude's code
 * sandbox, where the attachment is a real file:  curl -T "<file>" "<address>"  (PUT with Content-Length). The body is
 * streamed straight to Google Drive, never kept in the Worker. Without sandbox network the person opens the same address
 * in a browser and drops the file (GET shows a small form). The ticket itself is the permission: one account, 60
 * minutes, one file; only its hash is in the database.
 */
const MAX_BYTES = 95 * 1024 * 1024; // the Worker accepts request bodies up to 100 MB

type Ticket = { id: number; email: string; name: string; kind: 'input' | 'output'; description: string | null; chat_id: string | null; project: string | null; drive_id: string; drive_root: string };

const parse = <T>(v: unknown): T | null => (v == null ? null : ((typeof v === 'string' ? JSON.parse(v) : v) as T));
const answer = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export async function upload(req: Request, ticket: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(ticket)) return new Response('Not found', { status: 404 });
  if (req.method === 'GET') return page(ticket);
  if (req.method !== 'PUT' && req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, PUT' } });

  const size = Number(req.headers.get('content-length') ?? NaN);
  if (!Number.isFinite(size)) return answer({ error: 'Send the file with its length, e.g. curl -T "<file>" "<this address>".' }, 411);
  if (size <= 0) return answer({ error: 'The file is empty.' }, 400);
  if (size > MAX_BYTES) return answer({ error: `The file is ${(size / 1048576).toFixed(1)} MB; the limit is 95 MB. Put bigger files straight on Google Drive.` }, 413);
  if (!req.body) return answer({ error: 'No file was sent.' }, 400);

  const [{ t }] = (await sqlApp`select mcp.upload_ticket_take(${ticket}) as t`) as unknown as { t: unknown }[];
  const tk = parse<Ticket>(t);
  if (!tk) return answer({ error: 'This upload address has expired or was already used. Ask Claude for a new one (upload_attachment).' }, 410);

  // The browser form sends the real file name; curl keeps the name Claude gave the ticket.
  const fromBrowser = cleanName(decodeURIComponent(req.headers.get('x-file-name') ?? ''));
  const name = fromBrowser || tk.name;
  const mime = mimeFor(name, req.headers.get('content-type'));
  try {
    const { file, folder } = await uploadToClaudeFolder(tk, { name, mime, size, body: req.body, kind: tk.kind, description: tk.description });
    const [{ id }] = (await sqlApp`select mcp.upload_ticket_done(${tk.id}, ${mime}, ${size}, ${tk.drive_id}, ${file.id}, ${file.webViewLink ?? null}) as id`) as unknown as { id: number }[];
    return answer({ saved: file.name, size_bytes: size, mime, folder, link: file.webViewLink ?? null, saved_file_id: id,
      note: 'Saved as the original file. The Drive sync reads it for James and the team within a few minutes.' });
  } catch (e) {
    await sqlApp`select mcp.upload_ticket_release(${tk.id})`.catch(() => undefined);
    return answer({ error: `Upload failed: ${((e as Error).message || 'unknown error').slice(0, 200)}. Try the same command again.` }, 502);
  }
}

async function page(ticket: string): Promise<Response> {
  const [{ t }] = (await sqlApp`select mcp.upload_ticket_peek(${ticket}) as t`) as unknown as { t: unknown }[];
  const tk = parse<{ name: string; email: string; expires_at: string }>(t);
  const shell = (body: string, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Save a file · TalaStudio</title>
<style>
:root{--canvas:#f3f1ee;--surface:#fff;--ink:#1d1b19;--muted:#6b665f;--line:#e2ddd6;--accent:#d4561f;--ok:#1e7a46;--danger:#b42318;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--canvas:#151413;--surface:#1f1d1b;--ink:#f1eee9;--muted:#a59f97;--line:#36322e;--accent:#e2672f;--ok:#5cc28a;--danger:#f97066}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--canvas);color:var(--ink);font:1rem/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{width:100%;max-width:30rem;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:1.4rem;letter-spacing:-.02em;line-height:1.15;margin:0 0 6px}.who{color:var(--muted);margin:0 0 18px}
label.drop{display:block;border:2px dashed var(--line);border-radius:12px;padding:28px 16px;text-align:center;cursor:pointer}
label.drop:hover,label.drop:focus-within{border-color:var(--ink)}input[type=file]{display:block;margin:10px auto 0;max-width:100%}
button{margin-top:18px;min-height:40px;padding:0 18px;border-radius:9px;font:inherit;font-weight:600;cursor:pointer;border:1px solid var(--accent);background:var(--accent);color:#fff}
button:disabled{opacity:.6;cursor:default}button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
#s{margin:14px 0 0;min-height:1.5em}.ok{color:var(--ok)}.err{color:var(--danger)}a{color:inherit}
</style></head><body><main>${body}</main></body></html>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'",
    },
  });
  if (!tk) return shell('<h1>This link has expired</h1><p>Upload links work once and for 60 minutes. Ask Claude for a new one.</p>', 410);
  return shell(`<h1>Save a file to TalaStudio</h1>
<p class="who">For ${esc(tk.email)} · Claude asked for <strong>${esc(tk.name)}</strong></p>
<label class="drop">Choose the file (or drop it here)<input id="f" type="file"></label>
<button id="b" type="button">Save to Drive</button>
<p id="s" role="status" aria-live="polite"></p>
<script>
const f=document.getElementById('f'),b=document.getElementById('b'),s=document.getElementById('s');
b.onclick=async()=>{const file=f.files[0];if(!file){s.className='err';s.textContent='Choose a file first.';return}
b.disabled=true;b.textContent='Saving…';s.className='';s.textContent='';
try{const r=await fetch(location.pathname,{method:'PUT',body:file,headers:{'content-type':file.type||'application/octet-stream','x-file-name':encodeURIComponent(file.name)}});
const j=await r.json();if(!r.ok)throw new Error(j.error||'Upload failed');
s.className='ok';s.innerHTML='Saved: '+(j.link?'<a href="'+encodeURI(j.link)+'" target="_blank" rel="noopener">'+j.saved.replace(/[<>&"]/g,'')+'</a>':j.saved)+'. You can close this page and tell Claude.';b.textContent='Saved'}
catch(e){s.className='err';s.textContent=e.message+'.';b.disabled=false;b.textContent='Save to Drive'}};
</script>`);
}
