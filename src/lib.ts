import { sqlApp } from './db';

/**
 * Konektor TalaStudio untuk Claude (remote MCP) — hanya untuk akun di core.settings 'access.mcp' (owner: ejo@, evin@).
 * - mcp.talastudio.net (TANPA Cloudflare Access, karena server Claude yang memanggil): /mcp, metadata OAuth, /oauth/register,
 *   /oauth/token, /oauth/authorize, dilayani Worker ini (src/index.ts); semua alamat lain 404.
 * - workspace.talastudio.net/oauth/consent (DI BELAKANG Cloudflare Access): owner login Google lewat Access, lalu menekan
 *   "Izinkan"; baru di situ kode sekali pakai dibuat untuk akun yang sedang login.
 * Token hanya disimpan sebagai hash (skema mcp). Semua tool baca saja; setiap panggilan dicatat di mcp.calls.
 */
export const MCP_HOST = (process.env.MCP_HOST ?? 'mcp.talastudio.net').toLowerCase();
export const MCP_ORIGIN = `https://${MCP_HOST}`;
export const MCP_RESOURCE = `${MCP_ORIGIN}/mcp`;
export const WORKSPACE_ORIGIN = process.env.WORKSPACE_ORIGIN ?? 'https://workspace.talastudio.net';
export const MCP_SCOPE = 'talastudio';

/** Kode hanya boleh dikirim ke Claude (claude.ai / claude.com) atau ke aplikasi di komputer sendiri (Claude Code, localhost). */
export function allowedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:' && /^(?:[\w-]+\.)*(claude\.ai|claude\.com)$/i.test(u.hostname)) return true;
    if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return true;
  } catch { /* bukan URL */ }
  return false;
}

export type McpClient = { client_id: string; name: string | null; redirect_uris: string[] };

/**
 * Klien OAuth: hasil registrasi dinamis (client_id ts_…), atau "Client ID Metadata Document" (client_id = URL https
 * yang berisi JSON klien, mis. identitas resmi Claude). Dokumen dicek: client_id sama, redirect diizinkan.
 */
export async function resolveClient(clientId: string): Promise<McpClient | null> {
  if (!clientId) return null;
  if (/^https:\/\//i.test(clientId)) {
    try {
      const r = await fetch(clientId, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const doc = (await r.json()) as { client_id?: string; client_name?: string; redirect_uris?: unknown };
      const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((x): x is string => typeof x === 'string' && allowedRedirect(x)) : [];
      if (doc.client_id !== clientId || !uris.length) return null;
      await sqlApp`select mcp.save_cimd_client(${clientId}, ${String(doc.client_name ?? new URL(clientId).hostname)}, (select array_agg(u) from jsonb_array_elements_text(${JSON.stringify(uris)}::jsonb) u))`;
      return { client_id: clientId, name: doc.client_name ?? new URL(clientId).hostname, redirect_uris: uris };
    } catch { return null; }
  }
  const [{ c }] = (await sqlApp`select mcp.client_get(${clientId}) as c`) as unknown as { c: unknown }[];
  const v = (typeof c === 'string' ? JSON.parse(c) : c) as McpClient | null;
  return v?.client_id ? v : null;
}

const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function s256(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

export const authServerMetadata = () => ({
  issuer: MCP_ORIGIN,
  authorization_endpoint: `${MCP_ORIGIN}/oauth/authorize`,
  token_endpoint: `${MCP_ORIGIN}/oauth/token`,
  registration_endpoint: `${MCP_ORIGIN}/oauth/register`,
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  scopes_supported: [MCP_SCOPE],
  client_id_metadata_document_supported: true,
  service_documentation: `${WORKSPACE_ORIGIN}/`,
});

export const resourceMetadata = () => ({
  resource: MCP_RESOURCE,
  authorization_servers: [MCP_ORIGIN],
  bearer_methods_supported: ['header'],
  scopes_supported: [MCP_SCOPE],
  resource_name: 'TalaStudio',
});

export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};
export const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...CORS, 'Cache-Control': 'no-store', ...extra } });

/** Nilai yang tampak seperti kunci/token tidak pernah keluar lewat konektor, apa pun sumbernya. */
const SECRET_VALUES: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI/Anthropic style keys
  /\bsk_(live|test)_[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}/g, // Google access token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abpors]-[A-Za-z0-9-]{10,}/g,
  /https:\/\/[^\s"'\\]*[?&](upload_id|key|token|sig|signature|X-Amz-Signature)=[^\s"'\\]+/gi, // signed URLs, webhooks, upload sessions
];
const SECRET_KEY = /^(password|passwd|kata_?sandi|secret|client_secret|api_?key|private_?key|access_?token|refresh_?token|id_?token|pairing_?code|qr|otp|pin|session_url|upload_session)$/i;

export function redact(text: string): string {
  let t = text;
  for (const re of SECRET_VALUES) t = t.replace(re, '[hidden]');
  return t;
}
export function hideSecretKeys(v: unknown, depth = 0): unknown {
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => hideSecretKeys(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEY.test(k) ? '[hidden]' : hideSecretKeys(x, depth + 1)]));
}
