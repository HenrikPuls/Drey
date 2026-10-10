import type { AppConfig } from '../../shared/app-config';
import type { ToolApprovalRequest } from '../../shared/ipc-api';
import type { ToolSpec } from '../../shared/llm';
import type { McpClientManager } from './mcp-client-manager';
import { serverIdOfTool } from './mcp-client-manager';
import { WEB_FETCH_SPEC, WEB_FETCH_TOOL_NAME, runWebFetch } from './web-fetch';

/** Asks the user about one external call; resolves `true` to run it. */
export type ApproveToolCall = (request: Omit<ToolApprovalRequest, 'id'>) => Promise<boolean>;

/**
 * The assistant's EXTERNAL tool set (milestone 63, ADR-0063): the built-in
 * `web_fetch` plus the tools of every connected MCP server, each behind
 * its source's approval rule. The one place that turns `tools` config into
 * what a chat call may reach outside the machine.
 */
export class AssistantToolbox {
  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly clients: McpClientManager,
    private readonly approve: ApproveToolCall,
    private readonly fetchPage: typeof runWebFetch = runWebFetch,
  ) {}

  specs(): ToolSpec[] {
    const tools = this.getConfig().tools;
    return [...(tools.webFetch.enabled ? [WEB_FETCH_SPEC] : []), ...this.clients.toolSpecs()];
  }

  owns(name: string): boolean {
    return name === WEB_FETCH_TOOL_NAME || serverIdOfTool(name) !== null;
  }

  async run(name: string, argsJson: string, signal?: AbortSignal): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(argsJson || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      return `Error: could not parse arguments for ${name}: ${argsJson}`;
    }
    const tools = this.getConfig().tools;

    if (name === WEB_FETCH_TOOL_NAME) {
      if (!tools.webFetch.enabled) {
        return 'Error: web_fetch is turned off.';
      }
      if (
        tools.webFetch.approval === 'ask' &&
        !(await this.approve({ source: 'web', sourceName: 'Web fetch', tool: WEB_FETCH_TOOL_NAME, args }))
      ) {
        return 'The user declined this call.';
      }
      return this.fetchPage(args, signal);
    }

    const serverId = serverIdOfTool(name);
    const server = serverId === null ? null : this.clients.server(serverId);
    if (server === null) {
      return `Error: unknown tool ${name}.`;
    }
    if (
      server.approval === 'ask' &&
      !(await this.approve({
        source: server.id,
        sourceName: server.name,
        tool: this.clients.remoteToolName(name) ?? name,
        args,
      }))
    ) {
      return 'The user declined this call.';
    }
    return this.clients.call(name, args, signal);
  }
}
