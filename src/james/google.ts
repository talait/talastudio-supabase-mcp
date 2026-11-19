/**
 * Google Drive dari Worker, atas nama akun layanan (service account) yang menjadi anggota
 * Shared Drive TALASTUDIO ASSETS. Tidak memakai login Google pengguna: siapa pun yang lolos
 * Cloudflare Access boleh mengunggah, dan nama pengunggah dicatat di Supabase + di file Drive.
 *
 * Kredensial (secret di dashboard Cloudflare, tidak pernah di repo):
 *   GOOGLE_SA_KEY                = isi JSON kunci service account, atau
 *   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN
 *                                = cadangan bila Shared Drive tidak mengizinkan akun layanan (pakai akun shared@).
 */
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive';
export const FILE_FIELDS = 'id,name,mimeType,size,md5Checksum,sha256Checksum,modifiedTime,parents,driveId,webViewLink';

const cache = globalThis as unknown as { __gTok?: { token: string; exp: number } };

export const googleReady = () =>
  Boolean(process.env.GOOGLE_SA_KEY || (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_REFRESH_TOKEN));

const b64url = (buf: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof buf === 'string' ? new TextEncoder().encode(buf) : new Uint8Array(buf as ArrayBuffer);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function serviceAccountToken(sub?: string, scope = SCOPE): Promise<{ token: string; exp: number }> {
  const key = JSON.parse(process.env.GOOGLE_SA_KEY!) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600, ...(sub ? { sub } : {}) }));
  const pem = key.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const k = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', k, new TextEncoder().encode(`${header}.${claims}`));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${b64url(sig)}` }),
  });
  const j = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!j.access_token) throw new Error(`Google token: ${j.error_description ?? j.error ?? res.status}`);
  return { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
}

async function refreshTokenToken(): Promise<{ token: string; exp: number }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
      refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN!,
    }),
  });
  const j = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!j.access_token) throw new Error(`Google token: ${j.error_description ?? j.error ?? res.status}`);
  return { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
}

export async function googleToken(): Promise<string> {
  if (cache.__gTok && cache.__gTok.exp > Date.now() + 60_000) return cache.__gTok.token;
  if (!googleReady()) throw new Error('Upload is not configured yet: GOOGLE_SA_KEY is not set on the Worker.');
  cache.__gTok = process.env.GOOGLE_SA_KEY ? await serviceAccountToken() : await refreshTokenToken();
  return cache.__gTok.token;
}

/**
 * Token baca-saja atas nama satu akun perusahaan (domain-wide delegation), untuk file yang tidak ada di Shared Drive upload.
 * Hanya bisa bila kunci di GOOGLE_SA_KEY diberi delegasi dengan scope drive.readonly di Admin Console; kalau tidak, error jelas.
 */
const subCache = new Map<string, { token: string; exp: number }>();
export async function googleTokenAs(email: string): Promise<string> {
  const hit = subCache.get(email);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  if (!process.env.GOOGLE_SA_KEY) throw new Error('No service account key on the Worker.');
  try {
    const t = await serviceAccountToken(email, 'https://www.googleapis.com/auth/drive.readonly');
    subCache.set(email, t);
    return t.token;
  } catch (e) {
    throw new Error(`The workspace key may not read Drive as ${email} (domain-wide delegation with drive.readonly is not set for it): ${(e as Error).message.slice(0, 120)}`);
  }
}

async function gfetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await googleToken();
  const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  if (!res.ok && res.status !== 308) {
    const t = await res.text();
    let msg = t.slice(0, 300);
    try { msg = (JSON.parse(t) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* bukan JSON */ }
    throw new Error(`Google Drive ${res.status}: ${msg}`);
  }
  return res;
}

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Cari subfolder bernama `name` di `parentId`; buat kalau belum ada. */
export async function ensureFolder(name: string, parentId: string, driveId: string): Promise<string> {
  const params = new URLSearchParams({
    q: `name = '${q(name)}' and '${q(parentId)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)', pageSize: '5', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    corpora: 'drive', driveId,
  });
  const found = (await (await gfetch(`${DRIVE}/files?${params}`)).json()) as { files?: { id: string }[] };
  if (found.files?.[0]) return found.files[0].id;
  const created = (await (await gfetch(`${DRIVE}/files?supportsAllDrives=true&fields=id`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  })).json()) as { id: string };
  return created.id;
}

/** Mulai sesi upload resumable. URL sesi disimpan di server, bukan dikirim ke browser. */
export async function startResumable(o: {
  name: string; mime: string; size: number; parentId: string; description?: string; appProperties?: Record<string, string>;
}): Promise<string> {
  const res = await gfetch(`${UPLOAD}/files?uploadType=resumable&supportsAllDrives=true&fields=${FILE_FIELDS}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': o.mime || 'application/octet-stream',
      'X-Upload-Content-Length': String(o.size),
    },
    body: JSON.stringify({ name: o.name, parents: [o.parentId], description: o.description, appProperties: o.appProperties }),
  });
  const loc = res.headers.get('location');
  if (!loc) throw new Error('Google Drive did not return an upload session.');
  return loc;
}

export type DriveFile = {
  id: string; name: string; mimeType: string; size?: string; md5Checksum?: string; sha256Checksum?: string;
  modifiedTime: string; parents?: string[]; driveId?: string; webViewLink?: string;
};

/**
 * Kirim satu potongan ke sesi upload. Mengembalikan offset berikutnya, atau file Drive kalau sudah selesai.
 * Body dialirkan langsung (FixedLengthStream di Workers) supaya tidak memakan CPU Worker.
 */
export async function putChunk(session: string, body: ReadableStream<Uint8Array> | ArrayBuffer, start: number, length: number, total: number):
  Promise<{ next: number } | { file: DriveFile }> {
  let payload: BodyInit = body as BodyInit;
  const FLS = (globalThis as unknown as { FixedLengthStream?: new (n: number) => TransformStream }).FixedLengthStream;
  if (body instanceof ReadableStream && FLS) {
    const { readable, writable } = new FLS(length);
    body.pipeTo(writable).catch(() => { /* koneksi browser putus: Google akan menolak potongan ini */ });
    payload = readable as unknown as BodyInit;
  } else if (body instanceof ReadableStream) {
    payload = await new Response(body).arrayBuffer();
  }
  const res = await fetch(session, {
    method: 'PUT',
    headers: { 'Content-Length': String(length), 'Content-Range': `bytes ${start}-${start + length - 1}/${total}` },
    body: payload,
  });
  if (res.status === 308) {
    const range = res.headers.get('range'); // "bytes=0-8388607"
    const end = range ? Number(range.split('-')[1]) : start - 1;
    return { next: end + 1 };
  }
  if (res.status === 200 || res.status === 201) {
    const f = (await res.json()) as DriveFile;
    return { file: f };
  }
  throw new Error(`Google Drive upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function getFile(id: string): Promise<DriveFile> {
  return (await (await gfetch(`${DRIVE}/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=${FILE_FIELDS}`)).json()) as DriveFile;
}
