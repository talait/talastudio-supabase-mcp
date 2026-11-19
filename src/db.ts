import { AsyncLocalStorage } from 'node:async_hooks';
import postgres from 'postgres';

/**
 * Database clients per request (Workers rule: a connection may not be shared across requests), through Hyperdrive:
 * HYPERDRIVE     = role ts_chatbot (read; same Hyperdrive config as the workspace, "talastudio-db")
 * HYPERDRIVE_APP = role ts_app (writes only through mcp.* / ai.* functions; caching off, "talastudio-db-app")
 */
export type Env = {
  HYPERDRIVE: { connectionString: string };
  HYPERDRIVE_APP: { connectionString: string };
  MCP_HOST?: string;
  WORKSPACE_ORIGIN?: string;
};
type Store = { env: Env; read?: postgres.Sql; app?: postgres.Sql };
export const requestStore = new AsyncLocalStorage<Store>();

const opts = { max: 5, fetch_types: false, prepare: false, idle_timeout: 5, connect_timeout: 10 } as const;
function store(): Store {
  const s = requestStore.getStore();
  if (!s) throw new Error('Database used outside a request');
  return s;
}
const readClient = () => { const s = store(); return (s.read ??= postgres(s.env.HYPERDRIVE.connectionString, opts)); };
const appClient = () => { const s = store(); return (s.app ??= postgres(s.env.HYPERDRIVE_APP.connectionString, { ...opts, max: 3 })); };

/** Tagged-template client that resolves to this request's connection (also forwards sql.json, sql.begin, …). */
function lazy(get: () => postgres.Sql): postgres.Sql {
  return new Proxy(function () { /* target only */ } as unknown as postgres.Sql, {
    apply: (_t, _this, args: unknown[]) => (get() as unknown as (...a: unknown[]) => unknown)(...args),
    get: (_t, p) => {
      const c = get() as unknown as Record<string | symbol, unknown>;
      const v = c[p];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(c) : v;
    },
  });
}
export const sql = lazy(readClient);
export const sqlApp = lazy(appClient);

/** Close this request's connections once the response is out. */
export async function closeClients(s: Store) {
  await Promise.all([s.read?.end({ timeout: 5 }), s.app?.end({ timeout: 5 })].map((p) => p?.catch(() => undefined)));
}

/** James' query_database: READ ONLY transaction, james views only, 10 s. */
export async function readOnlyQuery(text: string, maxRows = 200): Promise<Record<string, unknown>[]> {
  let rows: Record<string, unknown>[] = [];
  await readClient().begin('read only', async (tx) => {
    await tx.unsafe(`set local statement_timeout = '10s'`);
    await tx.unsafe(`set local search_path = james`);
    rows = (await tx.unsafe(`select * from (${text}\n) as james_q limit ${Math.max(1, Math.min(500, maxRows))}`)) as unknown as Record<string, unknown>[];
  });
  return rows;
}

/**
 * Owners' free SQL: READ ONLY transaction on the read login, run by mcp.owner_query with the rights of ts_owner_read
 * (every data schema, minus secrets and other people's James chats). Needs a valid connector token.
 */
export async function ownerQuery(token: string, text: string, maxRows = 200): Promise<Record<string, unknown>[]> {
  let rows: Record<string, unknown>[] = [];
  await readClient().begin('read only', async (tx) => {
    const [{ r }] = (await tx`select mcp.owner_query(${token}, ${text}, ${Math.max(1, Math.min(1000, maxRows))}) as r`) as unknown as { r: unknown }[];
    const v = typeof r === 'string' ? JSON.parse(r) : r;
    rows = Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  });
  return rows;
}
