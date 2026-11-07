/**
 * req-96: a stand-alone fake desk behind the Mission Control shell e2e.
 * It serves the built app (`dist/mission-control/browser`) and answers the
 * handful of GET routes the shell needs to boot ready — an English demo
 * board, two personas, three chat sessions — plus an `/api/events` stream
 * that stays open. No engine, no vault, no Electron: the spec drives a
 * stock Chromium at phone and iPad sizes, which is all the shell rules
 * (panes, orientation, the menu root, back buttons) depend on.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { NOTES_FIXTURE, isNotesPath, notesReply } from './mission-control-fake-notes';
import * as BOARDS from './mission-control-fake-boards';

const APP_DIR = path.resolve('dist/mission-control/browser');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

const card = (id: string, phase: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  phase,
  meta: { id, title, priority: 'normal', claimedBy: null, persona: null, ...extra },
  blocked: [],
});

const board = {
  vaultName: 'drey-tickets',
  checkpoints: ['plan-review'],
  columns: [
    { phase: { id: 'inbox', title: 'Inbox' }, tickets: [card('T-0055', 'inbox', 'Export the board as CSV')] },
    { phase: { id: 'plan', title: 'Shaping' }, tickets: [card('T-0053', 'plan', 'Phase chip moves the ticket', { priority: 'high', persona: 'pia' })] },
    { phase: { id: 'prioritized', title: 'Prioritized' }, tickets: [] },
    {
      phase: { id: 'build', title: 'Building' },
      tickets: [
        card('T-0052', 'build', 'Fold duplicate phase folders', { priority: 'high', claimedBy: 'fleet@desk', persona: 'tom' }),
        card('T-0050', 'build', 'Blocked-by chips on cards'),
      ],
    },
    { phase: { id: 'review', title: 'Ready to try' }, tickets: [card('T-0049', 'review', 'Settings page for repositories')] },
    { phase: { id: 'done', title: 'Done' }, tickets: [card('T-0048', 'done', 'Run telemetry')] },
  ],
};

const needs = [
  {
    kind: 'question',
    ticketId: 'T-0052',
    title: 'Fold duplicate phase folders',
    summary: 'Two folders of one phase exist (inbox, 10-inbox). Fold them into 10-inbox?',
    runId: 'run-1',
    questions: [
      {
        key: 'q0',
        question: 'Two folders of one phase exist (inbox, 10-inbox). Fold them into 10-inbox?',
        options: [{ label: 'Fold' }, { label: 'Keep both' }],
        multiple: false,
      },
    ],
  },
  { kind: 'checkpoint', ticketId: 'T-0053', title: 'Phase chip moves the ticket', summary: 'The plan waits for your review.' },
];

const personas = [
  { id: 'pia', title: 'Pia', role: 'Planner', worker: 'opencode', model: 'zai/glm-5.3', pool: ['opencode'], color: '#8ecbef', phases: ['plan'] },
  { id: 'tom', title: 'Tom', role: 'Builder', worker: 'claude-code', model: 'claude-sonnet-5-5', pool: ['claude-code'], color: '#93c47f', phases: ['build'] },
];

const fleet = {
  runs: [
    { id: 'run-1', ticketId: 'T-0052', persona: 'tom', provider: 'claude-code', state: 'running', phase: 'build', startedAt: '2026-11-06T09:00:00Z', endedAt: null, tokensIn: 48_213, tokensOut: 6_120, costUsd: 0.42 },
  ],
  chain: { configured: true, master: 'run', columns: { build: 'playing' } },
};

const sessions = [
  { file: 'tickets/_meta/chat/a.md', title: 'Dark mode for the PDF export', createdAt: '2026-11-06T08:00:00Z', updatedAt: '2026-11-06T09:40:00Z', pending: 1 },
  { file: 'tickets/_meta/chat/b.md', title: 'Why is T-0050 blocked?', createdAt: '2026-11-05T15:00:00Z', updatedAt: '2026-11-05T15:20:00Z', pending: 0 },
  { file: 'tickets/_meta/chat/c.md', title: 'Plan the release notes', createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:30:00Z', pending: 0 },
];

const sessionA = {
  file: sessions[0]!.file,
  title: sessions[0]!.title,
  createdAt: sessions[0]!.createdAt,
  messages: [
    { role: 'owner', text: 'New ticket: dark mode for the PDF export', at: '2026-11-06T09:39:00Z', thought: null },
    { role: 'mission', text: 'I can create that ticket. Confirm and it lands in the inbox.', at: '2026-11-06T09:40:00Z', thought: null },
  ],
  proposals: [
    { id: 'p-1', kind: 'createTicket', title: 'Dark mode for the PDF export', summary: 'Export the PDF with the dark theme when the owner asks for it.', state: 'open' },
  ],
};

const ticket = (id: string) => {
  const found = board.columns.flatMap((c) => c.tickets).find((t) => t.id === id);
  if (found === undefined) {
    return { ok: false, error: 'not found' };
  }
  return {
    ok: true,
    card: found,
    text: `---\nid: ${id}\n---\n\n## Description\n\nThe phase chip is **display only**: a tap opens the move menu, it never moves the ticket itself.\n\n## Plan\n\nReuse the board's move list.\n\n### Acceptance criteria\n\n- [x] The chip opens the move menu\n- [ ] One commit per move\n`,
    revision: '1',
  };
};

const ROUTES: Record<string, () => unknown> = {
  '/api/me': () => ({ ok: true, device: { name: 'iPad', readOnly: NOTES_FIXTURE.readOnly } }),
  '/api/board': () => board,
  '/api/needs': () => needs,
  '/api/personas': () => personas,
  '/api/fleet': () => fleet,
  '/api/chat/sessions': () => sessions,
  [`/api/chat/sessions/${encodeURIComponent(sessionA.file)}`]: () => sessionA,
  '/api/settings': () => ({ ok: true }),
};

export interface FakeDeskOptions {
  /** The device `/api/me` describes (default: writable). */
  readonly readOnly?: boolean;
  /** `POST /api/chain/autopilot` answers with this refusal code instead of taking the change (req-95b). */
  readonly refuseAutopilot?: 'read_only' | 'bad_resume_at' | 'runner_down';
  /** Serves the phone boards' sample (10a–10t) in place of the demo data: the fidelity spec's state. */
  readonly boards?: boolean;
  /** With `boards`: the iPad boards' overlay (5b-5i, 10e-10s). */
  readonly pad?: boolean;
}

/** The answers of the board sample, by path; undefined = not a sample route. */
function boardsRoute(pathname: string, pad: boolean): unknown {
  const estimate = /^\/api\/estimate\/([^/]+)\/([^/]+)\//.exec(pathname);
  if (estimate !== null) {
    return (pad ? BOARDS.PAD_ESTIMATES : BOARDS.ESTIMATES)[`${estimate[1]}/${estimate[2]}`] ?? { ok: false, error: 'no basis' };
  }
  const ticket = /^\/api\/tickets\/([^/]+)(\/parts|\/plan)?$/.exec(pathname);
  if (ticket !== null) {
    const id = decodeURIComponent(ticket[1]!);
    if (ticket[2] === '/parts') {
      return id === 'T-0130' ? (pad ? BOARDS.PAD_PARTS_130 : BOARDS.PARTS_130) : id === 'T-0121' ? BOARDS.PARTS_121 : { ok: false, error: 'no parts' };
    }
    if (ticket[2] === '/plan') {
      return id === 'T-0130' ? (pad ? BOARDS.PAD_PLAN_130 : BOARDS.PLAN_130) : { ok: true, version: null, edits: 0, summary: null, marks: [] };
    }
    const found = (pad ? BOARDS.PAD_BOARD : BOARDS.BOARD).columns.flatMap((c) => c.tickets).find((t) => t.id === id);
    return found === undefined ? { ok: false, error: 'not found' } : { ok: true, card: found, text: (pad ? BOARDS.PAD_TICKET_TEXT[id] : undefined) ?? BOARDS.TICKET_TEXT[id] ?? `---\nid: ${id}\n---\n`, revision: '1' };
  }
  if (pad && /^\/api\/tickets\/T-0130\/flow\/\d+$/.test(pathname)) {
    return BOARDS.PAD_FLOW_130;
  }
  const diff = /^\/api\/tickets\/([^/]+)\/diff$/.exec(pathname);
  if (pad && diff !== null) {
    return decodeURIComponent(diff[1]!) === 'T-0121' ? BOARDS.PAD_DIFF_121 : { files: [], truncated: false };
  }
  const personaPage = /^\/api\/personas\/[^/]+\/(improvements|thread|memory)$/.exec(pathname);
  if (pad && personaPage !== null) {
    return { improvements: BOARDS.PAD_PERSONA_IMPROVEMENTS, thread: BOARDS.PAD_PERSONA_THREAD, memory: BOARDS.PAD_PERSONA_MEMORY }[personaPage[1] as 'improvements' | 'thread' | 'memory'];
  }
  const session = /^\/api\/chat\/sessions\/(.+)$/.exec(pathname);
  if (session !== null) {
    const file = decodeURIComponent(session[1]!);
    return file === BOARDS.SESSION_PROPOSAL.file ? BOARDS.SESSION_PROPOSAL : { ...BOARDS.SESSION_CHAT, file };
  }
  switch (pathname) {
    case '/api/board':
      return pad ? BOARDS.PAD_BOARD : BOARDS.BOARD;
    case '/api/needs':
      return BOARDS.NEEDS;
    case '/api/personas':
      return pad ? BOARDS.PAD_PERSONAS : BOARDS.PERSONAS;
    case '/api/fleet':
      return BOARDS.FLEET;
    case '/api/chat/sessions':
      return BOARDS.SESSIONS;
    case '/api/settings':
      return BOARDS.SETTINGS;
    case '/api/me':
      return { ok: true, device: { name: 'iPhone', readOnly: false } };
    default:
      return undefined;
  }
}

/** Starts the fake desk on a free port; resolves to its origin and a stop function. */
export async function startFakeDesk(
  options: FakeDeskOptions = {},
): Promise<{ origin: string; stop: () => Promise<void>; autopilotWrites: () => readonly unknown[] }> {
  if (options.boards === true) {
    NOTES_FIXTURE.files.clear();
    for (const [path, file] of BOARDS.NOTES) {
      NOTES_FIXTURE.files.set(path, { ...file });
    }
    NOTES_FIXTURE.vault = 'drey-notes';
  } else {
    NOTES_FIXTURE.reset();
    NOTES_FIXTURE.vault = 'Main vault';
  }
  const autopilotWrites: unknown[] = [];
  const chain: Record<string, unknown> = { ...fleet.chain, autopilot: { state: 'on' } };
  if (!fs.existsSync(path.join(APP_DIR, 'index.html'))) {
    throw new Error(`Mission Control is not built: ${APP_DIR} — run npm run build:mission-control first`);
  }
  const streams = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(': open\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (options.boards === true && (req.method === 'GET' || req.method === 'HEAD')) {
      const answer = url.pathname === '/api/fleet' ? { ...BOARDS.FLEET, chain: { ...BOARDS.FLEET.chain, ...(chain['autopilotSet'] === true ? { autopilot: chain['autopilot'] } : {}) } } : boardsRoute(url.pathname, options.pad === true);
      if (answer !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer));
        return;
      }
    }
    if (url.pathname === '/api/chain/autopilot' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw === '' ? '{}' : raw) as { state?: string };
        autopilotWrites.push(body);
        if (options.refuseAutopilot !== undefined) {
          const code = options.refuseAutopilot;
          res.writeHead(code === 'read_only' ? 403 : 200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: code === 'read_only' ? 'this device is paired read-only' : code, code }));
          return;
        }
        chain['autopilot'] = body;
        chain['autopilotSet'] = true;
        chain['master'] = body.state === 'on' ? 'run' : 'halted';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: chain }));
      });
      return;
    }
    if (isNotesPath(url.pathname)) {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = chunks.length === 0 ? {} : (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        } catch {
          body = {};
        }
        const reply = notesReply(req.method ?? 'GET', url, body);
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const ticketMatch = /^\/api\/tickets\/([^/]+)$/.exec(url.pathname);
      const route =
        ticketMatch !== null
          ? () => ticket(decodeURIComponent(ticketMatch[1]!))
          : url.pathname === '/api/fleet'
            ? () => ({ ...fleet, chain })
            : url.pathname === '/api/me'
              ? () => ({ ok: true, device: { name: 'iPad', readOnly: options.readOnly === true || NOTES_FIXTURE.readOnly } })
              : ROUTES[url.pathname];
      if (route === undefined || (req.method !== 'GET' && req.method !== 'HEAD')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `no fake route for ${req.method} ${url.pathname}` }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(route()));
      return;
    }
    // The built app: a file when it exists, index.html for everything else.
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(APP_DIR, rel);
    const target = file.startsWith(APP_DIR) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(APP_DIR, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' });
    fs.createReadStream(target).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    autopilotWrites: () => autopilotWrites,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const stream of streams) {
          stream.end();
        }
        server.close(() => resolve());
      }),
  };
}
