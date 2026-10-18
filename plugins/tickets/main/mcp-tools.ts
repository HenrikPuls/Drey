/**
 * The fleet's MCP tools (M85, ADR-0077): the first user of the
 * plugin-tool seam (SDK 1.29) — the assistant and any program connected
 * to Drey's MCP server can drive runs conversationally: status, run,
 * stop, steer, watch. A run is a significant action (an agent works a
 * work repo in its own worktree); the tool descriptions say so.
 */
import type { PluginMcpTool, PluginMcpToolProvider } from '../../../shared/plugin-api';

export interface FleetMcpDeps {
  readonly status: () => Promise<{
    runs: ReadonlyArray<{
      readonly id: string;
      readonly ticketId: string;
      readonly provider: string;
      readonly state: string;
      readonly startedAt: string;
      readonly tokensIn: number;
      readonly tokensOut: number;
      readonly costUsd: number | null;
      readonly gateFailure: string | null;
    }>;
    chain: { readonly configured: boolean; readonly master: string } | null;
  }>;
  readonly run: (input: {
    ticketId: string;
    worker: string | null;
    permissionMode: 'accept-edits' | 'bypass';
  }) => Promise<{ ok: boolean; error?: string; runId?: string }>;
  readonly stop: (runId: string) => Promise<{ ok: boolean; error?: string }>;
  readonly steer: (runId: string, text: string) => Promise<{ ok: boolean; error?: string; rung?: string }>;
  readonly watch: (runId: string) => Promise<string | null>;
}

const TOOLS: readonly PluginMcpTool[] = [
  {
    name: 'fleet_status',
    description:
      'The fleet runner\'s state: every run (id, ticket, provider, state, tokens, cost, gate failure) and the chain\'s master switch.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fleet_run',
    description:
      'Starts an agent run for one ticket (the ticket id, e.g. "T-0007"): the worker works the ticket in its own worktree; on a green machine gate the runner moves the ticket one column right. The optional worker overrides the assignment ("opencode", "claude-code").',
    inputSchema: {
      type: 'object',
      properties: {
        ticket: { type: 'string', description: 'The ticket id (T-0007).' },
        worker: { type: 'string', description: 'Optional worker override (opencode | claude-code).' },
        permissionMode: {
          type: 'string',
          enum: ['accept-edits', 'bypass'],
          description: 'Defaults to accept-edits.',
        },
      },
      required: ['ticket'],
    },
  },
  {
    name: 'fleet_stop',
    description: 'Stops one run through the stop ladder; the ticket stays in its phase.',
    inputSchema: {
      type: 'object',
      properties: { run: { type: 'string', description: 'The run id (R-…).' } },
      required: ['run'],
    },
  },
  {
    name: 'fleet_steer',
    description: 'Sends a message into a live run — a course correction that lands in the ticket\'s Log.',
    inputSchema: {
      type: 'object',
      properties: {
        run: { type: 'string', description: 'The run id (R-…).' },
        text: { type: 'string', description: 'What the worker should do differently.' },
      },
      required: ['run', 'text'],
    },
  },
  {
    name: 'fleet_watch',
    description: 'The recent tail of a run\'s stream (the worker\'s transcript so far).',
    inputSchema: {
      type: 'object',
      properties: { run: { type: 'string', description: 'The run id (R-…).' } },
      required: ['run'],
    },
  },
];

const LIVE: readonly string[] = ['starting', 'running', 'stopping'];

export function createFleetMcpTools(deps: FleetMcpDeps): PluginMcpToolProvider {
  return {
    tools: () => TOOLS,
    call: async (name, args) => {
      switch (name) {
        case 'fleet_status': {
          const { runs, chain } = await deps.status();
          const lines = runs.map((run) => {
            const tokens = run.tokensIn + run.tokensOut;
            return (
              `- ${run.id} ${run.ticketId} (${run.provider}) ${run.state}` +
              `${LIVE.includes(run.state) ? '' : ' (ended)'}` +
              `${tokens > 0 ? `, ${(tokens / 1000).toFixed(1)}k tok` : ''}` +
              `${run.costUsd !== null && run.costUsd > 0 ? `, $${run.costUsd.toFixed(2)}` : ''}` +
              `${run.gateFailure !== null ? `, gate: ${run.gateFailure}` : ''}`
            );
          });
          const chainLine =
            chain === null
              ? 'chain: not configured'
              : `chain: ${chain.configured ? chain.master : 'not configured'}`;
          return { text: [chainLine, ...(lines.length > 0 ? lines : ['(no runs)'])].join('\n') };
        }
        case 'fleet_run': {
          const ticket = typeof args['ticket'] === 'string' ? args['ticket'].trim() : '';
          if (!/^T-\d{4,}$/.test(ticket)) {
            return { text: 'name the ticket as its id (T-0007)', isError: true };
          }
          const worker = typeof args['worker'] === 'string' && args['worker'].trim() !== '' ? args['worker'].trim() : null;
          const permissionMode = args['permissionMode'] === 'bypass' ? 'bypass' : 'accept-edits';
          const result = await deps.run({ ticketId: ticket, worker, permissionMode });
          if (!result.ok) {
            return { text: result.error ?? 'the run refused', isError: true };
          }
          return { text: `run ${result.runId} started for ${ticket}` };
        }
        case 'fleet_stop': {
          const runId = typeof args['run'] === 'string' ? args['run'].trim() : '';
          const result = await deps.stop(runId);
          return result.ok
            ? { text: `run ${runId} stopping` }
            : { text: result.error ?? 'the stop refused', isError: true };
        }
        case 'fleet_steer': {
          const runId = typeof args['run'] === 'string' ? args['run'].trim() : '';
          const text = typeof args['text'] === 'string' ? args['text'].trim() : '';
          if (text === '') {
            return { text: 'the steer message is empty', isError: true };
          }
          const result = await deps.steer(runId, text);
          if (!result.ok) {
            return { text: result.error ?? 'the steer refused', isError: true };
          }
          return { text: `the message reached the worker (${result.rung ?? 'sent'})` };
        }
        case 'fleet_watch': {
          const runId = typeof args['run'] === 'string' ? args['run'].trim() : '';
          const tail = (await deps.watch(runId)) ?? '';
          if (tail === '') {
            return { text: `run ${runId} has no stream (unknown run or nothing yet)` };
          }
          const cut = tail.length > 6000 ? tail.slice(-6000) : tail;
          return { text: cut };
        }
        default:
          return { text: `unknown tool "${name}"`, isError: true };
      }
    },
  };
}
