import { describe, expect, it } from 'vitest';
import { createFleetMcpTools, type FleetMcpDeps } from './mcp-tools';

/**
 * The fleet's MCP tools (M85): the assistant's conversational surface
 * over runs — status, run, stop, steer, watch — against faked deps.
 */

function deps(over: Partial<FleetMcpDeps> = {}): FleetMcpDeps {
  return {
    status: async () => ({
      runs: [
        {
          id: 'R-001',
          ticketId: 'T-0007',
          provider: 'opencode',
          state: 'running',
          startedAt: '2026-10-18T12:00:00Z',
          tokensIn: 1200,
          tokensOut: 300,
          costUsd: 0.42,
          gateFailure: null,
        },
      ],
      chain: { configured: true, master: 'run' },
    }),
    run: async () => ({ ok: true, runId: 'R-002' }),
    stop: async () => ({ ok: true }),
    steer: async () => ({ ok: true, rung: 'inject' }),
    watch: async () => 'the stream tail',
    ...over,
  };
}

const provider = (): ReturnType<typeof createFleetMcpTools> => createFleetMcpTools(deps());

describe('the fleet MCP tools', () => {
  it('names the five tools with full wire names', () => {
    expect(provider().tools().map((t) => t.name)).toEqual([
      'fleet_status',
      'fleet_run',
      'fleet_stop',
      'fleet_steer',
      'fleet_watch',
    ]);
  });

  it('fleet_status summarizes the chain and the runs', async () => {
    const result = await provider().call('fleet_status', {});
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('chain: run');
    expect(result.text).toContain('- R-001 T-0007 (opencode) running');
    expect(result.text).toContain('1.5k tok');
    expect(result.text).toContain('$0.42');
  });

  it('fleet_run validates the ticket id and passes the choice through', async () => {
    const bad = await provider().call('fleet_run', { ticket: 'nope' });
    expect(bad.isError).toBe(true);
    let seen: { ticketId: string; worker: string | null; permissionMode: string } | null = null;
    const provider2 = createFleetMcpTools(
      deps({
        run: async (input) => {
          seen = input;
          return { ok: true, runId: 'R-9' };
        },
      }),
    );
    const good = await provider2.call('fleet_run', { ticket: 'T-0007', worker: 'claude-code' });
    expect(good.text).toContain('R-9');
    expect(seen).toEqual({ ticketId: 'T-0007', worker: 'claude-code', permissionMode: 'accept-edits' });
  });

  it('a refusal comes back as isError text', async () => {
    const refusing = createFleetMcpTools(
      deps({ run: async () => ({ ok: false, error: 'no acceptance criteria' }) }),
    );
    const result = await refusing.call('fleet_run', { ticket: 'T-0007' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('no acceptance criteria');
  });

  it('fleet_stop, fleet_steer and fleet_watch reach their deps', async () => {
    const calls: string[] = [];
    const recording = createFleetMcpTools(
      deps({
        stop: async (runId) => {
          calls.push(`stop:${runId}`);
          return { ok: true };
        },
        steer: async (runId, text) => {
          calls.push(`steer:${runId}:${text}`);
          return { ok: true, rung: 'inject' };
        },
        watch: async (runId) => {
          calls.push(`watch:${runId}`);
          return 'tail';
        },
      }),
    );
    await recording.call('fleet_stop', { run: 'R-1' });
    const steer = await recording.call('fleet_steer', { run: 'R-1', text: 'focus' });
    const watch = await recording.call('fleet_watch', { run: 'R-1' });
    expect(calls).toEqual(['stop:R-1', 'steer:R-1:focus', 'watch:R-1']);
    expect(steer.text).toContain('inject');
    expect(watch.text).toBe('tail');
  });
});
