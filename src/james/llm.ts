// James' look_at_file asks a vision model; the MCP server sends the picture to Claude instead (see mcp.ts look_at_file).
export async function completeOnce(..._args: unknown[]): Promise<string> {
  throw new Error('Not available in the MCP server: use look_at_file, which returns the picture itself.');
}
