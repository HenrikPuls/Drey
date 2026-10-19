/**
 * The plugin-tool seam on Drey's own MCP server (SDK 1.29, M85,
 * ADR-0077): the program-facing twin of the per-call chat tools
 * (`ctx.llm.chat(options.tools)`). A plugin registers one provider; its
 * tools appear beside the base vault tools for every program connected
 * to the server — the tickets plugin's `fleet_*` tools are the first
 * user.
 *
 * The shapes mirror the server's `McpToolDef`/`McpToolResult` (the
 * server owns those; the SDK stays free of the electron imports). Tool
 * names are the plugin's own (`fleet_run`) — prefix them so they cannot
 * collide with `vault_*` or another plugin's tools; the earlier
 * registration wins over a later duplicate, and the collision is logged.
 */

/** One tool as MCP `tools/list` returns it (JSON Schema). */
export interface PluginMcpTool {
  /** Full wire name, e.g. `fleet_run`. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
  };
}

/** What a call answers: one text block, optionally flagged as an error. */
export interface PluginMcpToolResult {
  readonly text: string;
  readonly isError?: boolean;
}

/** The plugin-side half of the seam. */
export interface PluginMcpToolProvider {
  /** The current tool list — read fresh on every `tools/list`. */
  readonly tools: () => readonly PluginMcpTool[];
  /** Runs one tool by wire name. A failed call is `isError` text the model can act on. */
  readonly call: (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<PluginMcpToolResult>;
}
