import { sqlApp } from './db';
import { json, s256 } from './lib';

/** OAuth token endpoint: authorization_code (with PKCE) and refresh_token (rotating). */

async function form(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('application/json')) return Object.fromEntries(Object.entries((await req.json()) as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')]));
  return Object.fromEntries(new URLSearchParams(await req.text()));
}

const fail = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);

export async function token(req: Request) {
  let f: Record<string, string>;
  try { f = await form(req); } catch { return fail('invalid_request', 'Unreadable body'); }
  // Some clients send client_id in HTTP Basic even as public clients.
  let clientId = f.client_id ?? '';
  const basic = /^Basic\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
  if (!clientId && basic) { try { clientId = decodeURIComponent(atob(basic[1]).split(':')[0]); } catch { /* ignore */ } }
  if (!clientId) return fail('invalid_client', 'client_id required', 401);
  try {
    let r: unknown;
    if (f.grant_type === 'authorization_code') {
      if (!f.code || !f.redirect_uri || !f.code_verifier) return fail('invalid_request', 'code, redirect_uri and code_verifier are required');
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(f.code_verifier)) return fail('invalid_grant', 'Bad code_verifier');
      [{ r }] = (await sqlApp`select mcp.exchange_code(${f.code}, ${clientId}, ${f.redirect_uri}, ${await s256(f.code_verifier)}) as r`) as unknown as { r: unknown }[];
    } else if (f.grant_type === 'refresh_token') {
      if (!f.refresh_token) return fail('invalid_request', 'refresh_token required');
      [{ r }] = (await sqlApp`select mcp.refresh(${f.refresh_token}, ${clientId}) as r`) as unknown as { r: unknown }[];
    } else return fail('unsupported_grant_type', 'Use authorization_code or refresh_token');
    const t = (typeof r === 'string' ? JSON.parse(r) : r) as Record<string, unknown>;
    return json({ access_token: t.access_token, token_type: 'Bearer', expires_in: t.expires_in, refresh_token: t.refresh_token, scope: 'talastudio' }, 200, { Pragma: 'no-cache' });
  } catch (e) {
    const m = (e as Error).message ?? '';
    return fail('invalid_grant', m.replace(/^.*invalid_grant:\s*/, '').slice(0, 200) || 'Grant rejected');
  }
}
