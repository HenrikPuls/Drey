/**
 * The Mission Control chat for the Drey Assistant (E13-5): the plugin IPC
 * handlers the Assistant's conversation targets call. They forward to the
 * engine's chat service over the loopback invoke channel the plugin already
 * holds -- the same `ChatService` the phone reaches through the gateway --
 * so nothing here opens the gateway, pairs a device or depends on the
 * remote access switch. The validation is the router's: a session file is
 * only ever a `tickets/_meta/chat/*.md` path, a card id only `p-<n>`.
 */
import type { MainPluginContext } from '../../../shared/plugin-api';

type Invoke = (method: string, payload?: unknown) => Promise<unknown>;

const CHAT_FILE_PATTERN = /^tickets\/_meta\/chat\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const PROPOSAL_ID_PATTERN = /^p-\d+$/;
const TICKET_ID_PATTERN = /^T-\d{4,}$/;

/** The reference text of the Vault chip: bounded, the engine adds it to the model's prompt only. */
const CONTEXT_MAX = 12_000;
const contextOf = (payload: unknown): { context?: string } => {
  const value = (payload as Record<string, unknown> | null)?.['context'];
  return typeof value === 'string' && value.trim() !== '' ? { context: value.slice(0, CONTEXT_MAX) } : {};
};

const bad = (what: string): { ok: false; error: string } => ({ ok: false, error: `bad ${what} payload` });

function field(payload: unknown, key: string): string | null {
  const value = (payload as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Registers the `mc*` handlers; `invoke` is the engine client's invoke. */
export function registerChatIpc(ctx: Pick<MainPluginContext, 'ipc'>, invoke: Invoke): void {
  ctx.ipc.handle('mcSessions', () => invoke('chatSessions'));
  ctx.ipc.handle('mcOpen', (payload) => {
    const file = field(payload, 'file');
    return file !== null && CHAT_FILE_PATTERN.test(file) ? invoke('chatOpen', file) : bad('session');
  });
  ctx.ipc.handle('mcStart', (payload) => {
    const text = field(payload, 'text');
    if (text === null) {
      return bad('message');
    }
    // A shape session (E13-9) names the ticket whose plan Paul works on.
    const ticket = field(payload, 'ticket');
    if (ticket !== null && !TICKET_ID_PATTERN.test(ticket)) {
      return bad('ticket');
    }
    return invoke('chatStart', { text, ...(ticket === null ? {} : { ticket }), ...contextOf(payload) });
  });
  ctx.ipc.handle('mcPlanStatus', (payload) => {
    const ticket = field(payload, 'ticket');
    if (ticket === null || !TICKET_ID_PATTERN.test(ticket)) {
      return bad('ticket');
    }
    // The open buffer's text, when the desktop has one (E13-9): its unsaved edits count.
    const text = (payload as Record<string, unknown>)['text'];
    return invoke('chatPlanStatus', typeof text === 'string' ? { ticket, text } : ticket);
  });
  ctx.ipc.handle('mcSend', (payload) => {
    const file = field(payload, 'file');
    const text = field(payload, 'text');
    return file === null || text === null || !CHAT_FILE_PATTERN.test(file)
      ? bad('message')
      : invoke('chatSend', { file, text, ...contextOf(payload) });
  });
  ctx.ipc.handle('mcDecide', (payload) => {
    const file = field(payload, 'file');
    const id = field(payload, 'id');
    const decision = field(payload, 'decision');
    if (file === null || id === null || !CHAT_FILE_PATTERN.test(file) || !PROPOSAL_ID_PATTERN.test(id)) {
      return bad('decision');
    }
    if (decision !== 'confirm' && decision !== 'dismiss') {
      return bad('decision');
    }
    return invoke(decision === 'confirm' ? 'chatConfirm' : 'chatDismiss', { file, id });
  });
  ctx.ipc.handle('mcShapeDecide', (payload) => {
    const file = field(payload, 'file');
    const choice = field(payload, 'choice');
    return file === null || !CHAT_FILE_PATTERN.test(file) || (choice !== 'keep' && choice !== 'split')
      ? bad('split')
      : invoke('chatShapeDecide', { file, choice });
  });
}
