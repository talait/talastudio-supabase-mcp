import { closeClients, requestStore, type Env } from './db';
import { CORS, WORKSPACE_ORIGIN, authServerMetadata, json, resourceMetadata } from './lib';
import { mcpGet, mcpPost } from './mcp';
import { register } from './oauth-register';
import { token } from './oauth-token';

/**
 * TalaStudio MCP server (mcp.talastudio.net): the owners' Claude connector.
 * Only these addresses exist; everything else is 404. The browser login/consent step lives on the workspace
 * (workspace.talastudio.net/oauth/consent, behind Cloudflare Access).
 */
const VERSION = '2026-11-20.5';

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (req.method === 'GET' && p.startsWith('/.well-known/oauth-protected-resource')) {
    return json(resourceMetadata(), 200, { 'Cache-Control': 'public, max-age=300' });
  }
  if (req.method === 'GET' && (p.startsWith('/.well-known/oauth-authorization-server') || p.startsWith('/.well-known/openid-configuration'))) {
    return json(authServerMetadata(), 200, { 'Cache-Control': 'public, max-age=300' });
  }
  if (p === '/oauth/register' && req.method === 'POST') return register(req);
  if (p === '/oauth/token' && req.method === 'POST') return token(req);
  if (p === '/oauth/authorize' && req.method === 'GET') {
    // Consent happens on the workspace, behind Cloudflare Access (Google login); everything is checked again there.
    return new Response(null, { status: 302, headers: { Location: `${WORKSPACE_ORIGIN}/oauth/consent${url.search}`, 'Cache-Control': 'no-store' } });
  }
  if (p === '/mcp') {
    if (req.method === 'POST') return mcpPost(req);
    if (req.method === 'GET') return mcpGet();
    return new Response(null, { status: 405, headers: { ...CORS, Allow: 'POST' } });
  }
  if (p === '/' && req.method === 'GET') return json({ name: 'TalaStudio MCP server', version: VERSION, mcp: `${url.origin}/mcp` });
  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const s = { env };
    return requestStore.run(s, async () => {
      try {
        return await route(req);
      } catch (e) {
        return json({ error: 'server_error', error_description: (e as Error).message?.slice(0, 200) ?? 'failed' }, 500);
      } finally {
        ctx.waitUntil(closeClients(s));
      }
    });
  },
};
