// tools.ts (copied from the workspace repo) imports './db'; the Worker's clients live in ../db.
export { sql, sqlApp, readOnlyQuery } from '../db';
