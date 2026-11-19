// Copy James' tools from the workspace repo (talait/talastudio-supabase) so the MCP server keeps the same tools.
// Usage: npm run sync-james -- ../talastudio-supabase
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.argv[2] ?? '../talastudio-supabase';
const lib = join(repo, 'app', 'src', 'lib');
if (!existsSync(join(lib, 'tools.ts'))) {
  console.error(`Not found: ${join(lib, 'tools.ts')}. Give the path of the talastudio-supabase checkout.`);
  process.exit(1);
}
for (const f of ['tools.ts', 'google.ts']) {
  copyFileSync(join(lib, f), join('src', 'james', f));
  console.log(`copied ${f}`);
}
console.log('Now run: npm run typecheck');
