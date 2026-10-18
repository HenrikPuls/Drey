/**
 * The plugin-tool registry of Drey's own MCP server (M85, ADR-0077):
 * what plugins put on the program-facing surface through
 * `ctx.mcp.registerTools` (SDK 1.29). The registry is dumb on purpose —
 * it collects providers, merges their `tools/list` output after the base
 * vault tools, and routes a `tools/call` by wire name. Names are the
 * plugins' own; a duplicate keeps the earlier registration and logs the
 * loser, so a program's tool set never shifts underneath it.
 */
import type { PluginMcpTool, PluginMcpToolProvider } from '../../shared/plugin-api';
import { fail, McpToolDef, McpToolResult } from './tools/types';

export class PluginMcpTools {
  private readonly providers = new Map<string, PluginMcpToolProvider>();
  private readonly names = new Map<string, string>();

  constructor(private readonly log: (message: string) => void) {}

  register(pluginId: string, provider: PluginMcpToolProvider): void {
    this.providers.set(pluginId, provider);
    for (const tool of provider.tools()) {
      const owner = this.names.get(tool.name);
      if (owner !== undefined && owner !== pluginId) {
        this.log(
          `plugin tool "${tool.name}" of "${pluginId}" collides with "${owner}" — the earlier registration stays`,
        );
        continue;
      }
      this.names.set(tool.name, pluginId);
    }
  }

  /** The merged tool list, vault tools excluded (the server lists those itself). */
  list(): McpToolDef[] {
    const defs: McpToolDef[] = [];
    const seen = new Set<string>();
    for (const provider of this.providers.values()) {
      for (const tool of provider.tools() as readonly PluginMcpTool[]) {
        if (seen.has(tool.name) || !this.names.has(tool.name)) {
          continue; // a loser of a collision, or a name another plugin took first
        }
        seen.add(tool.name);
        defs.push({
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: 'object',
            properties: { ...tool.inputSchema.properties },
            ...(tool.inputSchema.required !== undefined ? { required: [...tool.inputSchema.required] } : {}),
          },
        });
      }
    }
    return defs;
  }

  /** True when `name` belongs to a plugin tool (the server routes on this). */
  has(name: string): boolean {
    return this.names.has(name);
  }

  /** Runs one plugin tool by wire name; a refused name is `isError` text. */
  async call(name: string, args: Readonly<Record<string, unknown>>): Promise<McpToolResult> {
    const owner = this.names.get(name);
    if (owner === undefined) {
      return fail(`unknown tool "${name}" — see tools/list`);
    }
    const provider = this.providers.get(owner);
    if (provider === undefined) {
      return fail(`tool "${name}" has no provider anymore`);
    }
    try {
      const result = await provider.call(name, args);
      return { content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return fail(`tool "${name}" failed: ${text}`);
    }
  }
}
