import { sqlApp } from './db';
import { allowedRedirect, json } from './lib';

/** Dynamic client registration (RFC 7591) for the TalaStudio connector. Public clients only (PKCE), Claude or localhost redirects. */

export async function register(req: Request) {
  let b: { client_name?: string; redirect_uris?: unknown };
  try { b = (await req.json()) as typeof b; } catch { return json({ error: 'invalid_client_metadata', error_description: 'JSON body required' }, 400); }
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((x): x is string => typeof x === 'string') : [];
  if (!uris.length) return json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris required' }, 400);
  const bad = uris.find((u) => !allowedRedirect(u));
  if (bad) return json({ error: 'invalid_redirect_uri', error_description: `Redirect not allowed: ${bad}. Only Claude (claude.ai, claude.com) and localhost.` }, 400);
  const name = String(b.client_name ?? 'Claude').slice(0, 120);
  const [{ id }] = (await sqlApp`select mcp.register_client(${name}, (select array_agg(u) from jsonb_array_elements_text(${JSON.stringify(uris)}::jsonb) u)) as id`) as unknown as { id: string }[];
  return json({
    client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris,
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  }, 201);
}
