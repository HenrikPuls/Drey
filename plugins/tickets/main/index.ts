/**
 * The Tickets plugin's main entry (ADR-0076, milestone 83; ADR-0088 E2b):
 * the board service, the fleet client and the remote gateway run in the
 * standalone tickets engine — this module is the Drey client wiring: it
 * adopts or spawns the engine, proxies the service surface over the
 * loopback invoke channel behind the unchanged IPC handlers, and keeps
 * the renderer on the same events. The engine outlives Drey; the phone
 * reaches the same engine through the gateway's pairing.
 */
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { dialog } from 'electron';
import type { MainPluginContext, MainPluginModule } from '../../../shared/plugin-api';
import {
  DEFAULT_PRIORITY_CONFIG,
  type PriorityConfig,
  type RepoRef,
  type TicketPriority,
} from '../shared/tickets';
import {
  chainResult,
  parseAnswer,
  parseChainColumn,
  parseChainColumnStop,
  parseChainMaster,
  parseClaim,
  parseCreate,
  parsePermission,
  parseSend,
  parseSendBack,
  parseSetTrack,
  parseStartRun,
  parseStopRun,
  parseTicketId,
  parseTransition,
  parseUnarchive,
} from '../../../packages/tickets-engine/src/core/commands';
import { parseTicketFile, patchHeaderFields, type HeaderPatch } from '../../../packages/tickets-engine/src/core/ticket-files';
import { parseReviewComments, sendBackNoteOf } from '../../../packages/tickets-engine/src/core/review-feedback';
import { personaModelFor } from '../../../packages/tickets-engine/src/core/persona';
import { planWorktreeRemoval } from '../../../packages/tickets-engine/src/core/worktree-removal';
import { captureTidyMessages, parseCaptureTidy } from '../shared/capture-tidy';
import type { AttachmentReply, RefineReply, TicketReply } from '../shared/remote-protocol';
import { hostVaultIdMapper } from './host-vault-id';
import { openTerminalAt } from './open-terminal';
import { startWindowsDictation } from './dictation';
import { createFleetMcpTools } from './mcp-tools';
import { listWorkerModels } from './worker-models';
import { EngineClient } from './engine-client';
import { PathAnnouncer } from './path-announcer';
import { ensureEngine, syncChatConfig, syncStoreConfig } from './engine-lifecycle';
import { TicketDocuments } from './ticket-documents';
import { checkoutOf, readStoreSettings } from '../../../packages/tickets-engine/src/store/store-settings';
import { registerChatIpc } from './chat-ipc';
import { MissionControlHost, createMissionControlView } from './mission-control';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let engineEvents: (() => void) | null = null;
let pathAnnouncer: PathAnnouncer | null = null;
let missionControl: MissionControlHost | null = null;

const plugin: MainPluginModule = {
  async deactivate() {
    // The engine outlives Drey (the phone may still be on it) — only the
    // event stream unsubscribes here. The Mission Control window is ours,
    // it closes with the plugin.
    missionControl?.dispose();
    missionControl = null;
    engineEvents?.();
    engineEvents = null;
    pathAnnouncer?.dispose();
    pathAnnouncer = null;
  },

  async activate(ctx: MainPluginContext) {
    // The tickets engine (ADR-0088, E2b): the board service, the fleet
    // client and the remote gateway run in the standalone engine process;
    // Drey is a native client of it over the loopback invoke channel, and
    // so is the phone through the gateway's pairing. Adopt a live engine
    // or spawn one; never stop it.
    const endpoints = await ensureEngine(ctx, ctx.log);
    const client = new EngineClient(endpoints);
    // D-1: the assistant LLM settings reach the engine at activation (above)
    // AND whenever Settings -> Assistant changes them -- the chat reads them
    // per turn, so a change applies to the next question.
    const chatSignature = (llm: ReturnType<typeof ctx.appConfig.get>['llm']): string =>
      JSON.stringify([llm.enabled, llm.provider, llm.baseUrl, llm.apiKey, llm.model]);
    let pushedChat = chatSignature(ctx.appConfig.get().llm);
    ctx.appConfig.onChange((config) => {
      // Unrelated config writes (a spell-check word, a layout) change nothing here.
      if (chatSignature(config.llm) === pushedChat) {
        return;
      }
      pushedChat = chatSignature(config.llm);
      void syncChatConfig(client, config.llm).catch((error: unknown) => ctx.log(`engine chat config sync failed: ${messageOf(error)}`, 'warn'));
    });
    const board = client.board();
    const fleet = client.fleet();
    const remoteService = client.remote();
    const defaultWorker = ((await ctx.config.get<string>('defaultWorker')) ?? '').trim() || 'opencode';
    // The vault's priority vocabulary (pipeline.md's `priorities:`), as
    // the engine's board service reads it. The header/headerEdit parsers
    // and setPriority need it without rebuilding the board, so it is
    // cached here: prefetched once at activation, then refreshed from
    // every board fetch the renderer makes (a pipeline.md change always
    // announces `board-changed` first, so the next fetch re-arms the cache).
    let priorities: PriorityConfig = DEFAULT_PRIORITY_CONFIG;
    void board
      .snapshot()
      .then((snap) => {
        priorities = snap.priorities;
      })
      .catch(() => undefined);
    // D-3: the engine is a separate process and Drey's watcher is off by
    // default -- the engine reports the files it wrote, and this tells the
    // vault layer (Files tree, indexes, open tabs) in one batched round.
    pathAnnouncer = new PathAnnouncer({
      listVaults: () => ctx.vault.listVaults(),
      announce: (payload) => ctx.vault.announceChanges(payload),
      log: ctx.log,
    });
    const announcer = pathAnnouncer;
    engineEvents = client.onEvent(
      (what) => {
        ctx.ipc.emit(what === 'board' ? 'board-changed' : what === 'fleet' ? 'fleet-changed' : 'remote-changed');
      },
      undefined,
      (event) => announcer.add(event),
    );
    void fleet.startPolling();
    void board.worktreeBootSweep().catch((error: unknown) => ctx.log(`engine boot sweep: ${messageOf(error)}`, 'warn'));
    ctx.ipc.handle('remoteStatus', () => remoteService.status());
    ctx.ipc.handle('remoteConfigure', async (payload) => {
      const p = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
      return remoteService.configure({
        ...(typeof p['enabled'] === 'boolean' ? { enabled: p['enabled'] } : {}),
        ...(typeof p['mode'] === 'string' ? { mode: p['mode'] } : {}),
        ...(typeof p['lanAddress'] === 'string' || p['lanAddress'] === null ? { lanAddress: p['lanAddress'] as string | null } : {}),
        ...(typeof p['port'] === 'number' ? { port: p['port'] } : {}),
        ...(typeof p['publicUrl'] === 'string' || p['publicUrl'] === null ? { publicUrl: p['publicUrl'] as string | null } : {}),
        ...(typeof p['allowBypass'] === 'boolean' ? { allowBypass: p['allowBypass'] } : {}),
      });
    });
    ctx.ipc.handle('remotePair', (payload) => {
      const p = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
      const name = typeof p['name'] === 'string' && p['name'] !== '' ? p['name'] : 'Phone';
      // The proxy passes the FIRST argument only — the name travels as the
      // bare string the engine's 'pair' tolerates.
      return remoteService.pair(name, p['readOnly'] === true);
    });
    ctx.ipc.handle('remotePairCancel', () => remoteService.cancelPairing());
    ctx.ipc.handle('remoteRevoke', async (payload) => {
      const id = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)['id'] : undefined;
      return typeof id === 'string' ? remoteService.revoke(id) : remoteService.status();
    });

    // Mission Control in a Drey window (E5c, concept §3.5.4 — the same web
    // app in a Drey window): the Work panel's ⋯ row asks here; main takes a
    // local client from the engine (registered as a device directly, no
    // pairing) and opens the gateway URL with `#token=` appended — or
    // answers honestly that the remote is off.
    const mcHost = new MissionControlHost({
      localClient: () => remoteService.localClient({ name: 'Drey' }),
      createView: () => createMissionControlView((line) => ctx.log(line, 'warn')),
    });
    missionControl = mcHost;
    ctx.ipc.handle('openMissionControl', () => mcHost.open());

    // The engine hosts the vault as `standalone`; the renderer speaks Drey's
    // vault ids (documents.open, the editor surface) -- translate here.
    const withHostVaultId = hostVaultIdMapper({
      listVaults: () => ctx.vault.listVaults(),
      hasBoard: async (vaultId) => {
        try {
          await ctx.vault.read('tickets/_meta/pipeline.md', { vaultId });
          return true;
        } catch {
          return false;
        }
      },
    });

    // Ticket documents of a dricket store in the editor (E14-4c): the checkout is a
    // vault, its tickets/ tree is routed -- the editor save goes through the engine
    // (dk put --if-version), every other write of it is refused by the base.
    const engineConfig = <T,>(key: string): Promise<T | undefined> => client.invoke('configGet', { key }) as Promise<T | undefined>;
    const documents = new TicketDocuments({
      vaults: () => ctx.vault.listVaults(),
      checkout: async () => {
        const settings = await readStoreSettings(engineConfig);
        return settings.backend === 'dricket' ? checkoutOf(settings) : null;
      },
      locate: (id) => board.ticketDocument({ id }),
      saveDocument: (input) => board.saveDocument(input),
      registerCheckout: async (checkout) => {
        const answer = await dialog.showMessageBox({
          type: 'question',
          title: 'Tickets',
          message: 'Add the ticket checkout as a vault?',
          detail: `${checkout}\n\nTicket documents open in the editor from this folder. They stay read-only except for saving a ticket, which goes through dricket.`,
          buttons: ['Add vault', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
        });
        if (answer.response !== 0) {
          return false;
        }
        await ctx.vault.register(checkout);
        return true;
      },
      modifiedMs: async (absolutePath) => (await fsp.stat(absolutePath)).mtimeMs,
    });
    ctx.vault.routeDocuments(documents.route);
    void documents.refresh().catch(() => undefined);
    ctx.ipc.handle('ticketDocument', (payload) => {
      const id = typeof payload === 'object' && payload !== null ? (payload as { id?: unknown }).id : undefined;
      return typeof id === 'string' ? documents.open(id) : { ok: false, error: 'bad ticket document payload' };
    });
    ctx.ipc.handle('board', async () => {
      await syncStoreConfig(client, ctx).catch(() => undefined);
      void documents.refresh().catch(() => undefined);
      const snap = await board.refresh();
      priorities = snap.priorities;
      return withHostVaultId(snap);
    });

    ctx.ipc.handle('create', async (payload) => {
      const cmd = parseCreate(payload);
      return cmd.ok ? board.createTicket(cmd.value) : cmd;
    });

    // One Win+H press for the create modal's mic button (req-75 W5b,
    // T-0071) — the OS's dictation, never speech recognition of our own.
    ctx.ipc.handle('dictate', () => startWindowsDictation(process.platform, execFile));

    // The create modal's Tidy up button (req-75 W5c, T-0072): one
    // model call shapes a captured idea into a title and a
    // description, on demand — the raw words ride the create as a Log
    // line. The call runs here, never in the renderer, and carries no
    // timeout (ADR-0014); the button stays disabled while it runs.
    ctx.ipc.handle('tidyCapture', async (payload) => {
      const p = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
      const text = typeof p['text'] === 'string' ? p['text'].trim() : '';
      if (text === '') {
        return { ok: false, error: 'There is no text to tidy up.' };
      }
      if (!ctx.llm.enabled()) {
        return { ok: false, error: 'The language model is turned off.' };
      }
      let reply: string;
      try {
        reply = (await ctx.llm.chat(captureTidyMessages(text), { temperature: 0.2 })).text;
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const tidied = parseCaptureTidy(reply, text);
      return tidied === null
        ? { ok: false, error: "The model's reply could not be read — the text is unchanged." }
        : { ok: true, title: tidied.title, description: tidied.description };
    });

    ctx.ipc.handle('transition', async (payload) => {
      const cmd = parseTransition(payload);
      return cmd.ok ? board.transition(cmd.value) : cmd;
    });

    // The ticket header in the editor (req-62): it shows the buffer's
    // frontmatter, not the file on disk, so it asks with the block itself.
    ctx.ipc.handle('header', (payload) => {
      const p = payload as { path?: unknown; frontmatter?: unknown };
      if (typeof p.path !== 'string' || typeof p.frontmatter !== 'string') {
        return { ok: false, error: 'bad header payload' };
      }
      return { ok: true, ...parseTicketFile(`${p.frontmatter}\n`, p.path, priorities) };
    });

    ctx.ipc.handle('headerEdit', (payload) => {
      const p = payload as { path?: unknown; frontmatter?: unknown; patch?: unknown };
      if (typeof p.path !== 'string' || typeof p.frontmatter !== 'string' || typeof p.patch !== 'object' || p.patch === null) {
        return { ok: false, error: 'bad header edit payload' };
      }
      const raw = p.patch as Record<string, unknown>;
      const patch: HeaderPatch = {
        ...(typeof raw['title'] === 'string' ? { title: raw['title'] } : {}),
        ...(typeof raw['priority'] === 'string' ? { priority: raw['priority'] as TicketPriority } : {}),
        ...(typeof raw['repo'] === 'string' ? { repo: raw['repo'] } : {}),
        ...(Array.isArray(raw['repos']) && raw['repos'].every((r): r is string => typeof r === 'string')
          ? { repos: raw['repos'] }
          : {}),
        ...(typeof raw['worker'] === 'string' ? { worker: raw['worker'] } : {}),
      };
      try {
        const frontmatter = patchHeaderFields(p.frontmatter, patch, priorities);
        return { ok: true, frontmatter, ...parseTicketFile(`${frontmatter}\n`, p.path, priorities) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    ctx.ipc.handle('claim', async (payload) => {
      const cmd = parseClaim(payload);
      return cmd.ok ? board.setClaim(cmd.value) : cmd;
    });

    ctx.ipc.handle('setPriority', async (payload) => {
      const p = (payload ?? {}) as { id?: unknown; priority?: unknown };
      if (typeof p.id !== 'string' || !priorities.order.includes(p.priority as TicketPriority)) {
        return { ok: false, error: 'bad priority payload' };
      }
      return board.setPriority({ id: p.id, priority: p.priority as TicketPriority });
    });

    // The Work row menu's Track › pick (req-75 W1b).
    ctx.ipc.handle('setTrack', async (payload) => {
      const cmd = parseSetTrack(payload);
      return cmd.ok ? board.setTrack(cmd.value) : cmd;
    });

    // The settings dialog's writer: one phase's pool keys, one commit (M85).
    ctx.ipc.handle('columns', async (payload) => {
      const p = payload as {
        phase?: unknown;
        worker?: unknown;
        model?: unknown;
        prompt?: unknown;
      };
      if (typeof p.phase !== 'string' || p.phase.trim() === '') {
        return { ok: false, error: 'bad columns payload' };
      }
      return board.setColumnConfig({
        phase: p.phase,
        ...(p.worker !== undefined ? { worker: typeof p.worker === 'string' ? p.worker : null } : {}),
        ...(p.model !== undefined ? { model: typeof p.model === 'string' ? p.model : null } : {}),
        ...(p.prompt !== undefined ? { prompt: typeof p.prompt === 'string' ? p.prompt : null } : {}),
      });
    });

    // The prompts the columns name, editable from the settings page (req-46).
    ctx.ipc.handle('prompts', () => board.listPrompts());
    ctx.ipc.handle('promptSave', async (payload) => {
      const p = payload as { ref?: unknown; text?: unknown; reset?: unknown };
      if (typeof p.ref !== 'string') {
        return { ok: false, error: 'bad prompt payload' };
      }
      if (p.reset !== true && typeof p.text !== 'string') {
        return { ok: false, error: 'bad prompt payload' };
      }
      return board.savePrompt({
        ref: p.ref,
        ...(typeof p.text === 'string' ? { text: p.text } : {}),
        ...(p.reset === true ? { reset: true } : {}),
      });
    });
    ctx.ipc.handle('promptRestore', () => board.restoreShippedPrompts());
    ctx.ipc.handle('openFolder', async (payload) => {
      const p = payload as { which?: unknown };
      return board.openTicketsFolder(p.which === 'prompts' ? 'prompts' : 'tickets');
    });

    // The repositories registry, edited from the settings page (req-72):
    // the listing, its structured save, the folder picker and the scan
    // behind "Add from folder".
    ctx.ipc.handle('reposListing', () => board.listRepos());
    ctx.ipc.handle('reposSave', async (payload) => {
      const p = payload as { repos?: unknown };
      if (!Array.isArray(p.repos)) {
        return { ok: false, error: 'bad repos payload' };
      }
      const repos: RepoRef[] = [];
      for (const raw of p.repos) {
        const r = raw as Record<string, unknown>;
        if (typeof r['name'] !== 'string' || typeof r['url'] !== 'string') {
          return { ok: false, error: 'bad repos payload' };
        }
        const str = (key: string): string | null => (typeof r[key] === 'string' && (r[key] as string).trim() !== '' ? (r[key] as string).trim() : null);
        repos.push({
          name: r['name'].trim(),
          url: r['url'].trim(),
          branch: str('branch'),
          policy: str('policy'),
          path: str('path'),
          worker: str('worker'),
          worktrees: str('worktrees'),
          launch: str('launch'),
          instructions: str('instructions'),
          ...(Array.isArray(r['link']) && r['link'].every((l): l is string => typeof l === 'string') && r['link'].length > 0 ? { link: r['link'] as string[] } : {}),
        });
      }
      return board.saveRepos(repos);
    });
    ctx.ipc.handle('pickFolder', () => board.pickFolder());
    ctx.ipc.handle('scanRepos', async (payload) => {
      const p = payload as { folder?: unknown };
      if (typeof p.folder !== 'string' || p.folder.trim() === '') {
        return { ok: false, error: 'bad scan payload' };
      }
      return board.scanRepos(p.folder);
    });

    // The projects (req-72): the tickets vaults that carry a board, and
    // the switch between them (one config key, the board follows).
    ctx.ipc.handle('projects', () => board.listProjects());
    ctx.ipc.handle('switchProject', async (payload) => {
      const p = payload as { id?: unknown };
      if (typeof p.id !== 'string') {
        return { ok: false, error: 'bad switch payload' };
      }
      return board.switchProject(p.id);
    });

    // Sortable columns and the folder numbering (req-50).
    ctx.ipc.handle('folders', () => board.folderStatus());
    ctx.ipc.handle('numberFolders', () => board.numberFolders());
    ctx.ipc.handle('reorderPhases', async (payload) => {
      const p = payload as { order?: unknown };
      if (!Array.isArray(p.order) || !p.order.every((id): id is string => typeof id === 'string')) {
        return { ok: false, error: 'bad reorder payload' };
      }
      return board.reorderPhases(p.order);
    });

    ctx.ipc.handle('editPhase', async (payload) => {
      const p = payload as { op?: unknown; title?: unknown; phase?: unknown; afterId?: unknown };
      if (p.op === 'add' && typeof p.title === 'string') {
        return board.editPhase({ op: 'add', title: p.title, afterId: typeof p.afterId === 'string' ? p.afterId : null });
      }
      if (p.op === 'rename' && typeof p.phase === 'string' && typeof p.title === 'string') {
        return board.editPhase({ op: 'rename', phase: p.phase, title: p.title });
      }
      if (p.op === 'remove' && typeof p.phase === 'string') {
        return board.editPhase({ op: 'remove', phase: p.phase });
      }
      return { ok: false, error: 'bad phase edit payload' };
    });

    // The model picker's list: what the worker CLI offers (req-46).
    ctx.ipc.handle('models', async (payload) => {
      const p = payload as { worker?: unknown };
      return listWorkerModels(typeof p.worker === 'string' ? p.worker : defaultWorker);
    });

    ctx.ipc.handle('archive', async (payload) => {
      const cmd = parseTicketId(payload, 'archive');
      return cmd.ok ? board.archive(cmd.value) : cmd;
    });

    // --- the Ready card (req-75 W3) -------------------------------------
    // Launch this version / Accept and merge / Send back…, and the
    // `## Changes` + story data its page reads from the ticket file.
    ctx.ipc.handle('launchVersion', async (payload) => {
      const cmd = parseTicketId(payload, 'launch');
      return cmd.ok ? board.launchVersion(cmd.value) : cmd;
    });

    ctx.ipc.handle('acceptTicket', async (payload) => {
      const cmd = parseTicketId(payload, 'accept');
      return cmd.ok ? board.acceptTicket(cmd.value) : cmd;
    });

    ctx.ipc.handle('sendBack', async (payload) => {
      // E13-7: the Review tab's line comments ride along as structured
      // feedback (the Ready card sends none); they stand in for a note.
      const raw = (payload ?? {}) as Record<string, unknown>;
      const comments = parseReviewComments(raw['comments']);
      const note = sendBackNoteOf(typeof raw['note'] === 'string' ? raw['note'] : '', comments.length);
      const cmd = parseSendBack(comments.length > 0 ? { ...raw, note } : payload);
      return cmd.ok ? board.sendBack(comments.length > 0 ? { ...cmd.value, comments } : cmd.value) : cmd;
    });

    ctx.ipc.handle('changes', async (payload) => {
      const cmd = parseTicketId(payload, 'changes');
      return cmd.ok
        ? board.changesOf(cmd.value.id)
        : { changes: null, story: [], totals: { minutes: null, tokens: null }, planApproved: null, result: null, launchable: false };
    });

    // The ticket document (E13-6): the personas for the header strip's chain,
    // and the run estimate for the gate now waiting, on the model its
    // persona is set to (E11-4) -- null below three similar runs.
    ctx.ipc.handle('personas', async () => {
      const list = await board.listPersonas();
      return list.map((p) => ({ id: p.id, title: p.title, color: p.color, role: p.role }));
    });
    ctx.ipc.handle('estimate', async (payload) => {
      const p = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
      if (typeof p['gate'] !== 'string' || typeof p['persona'] !== 'string') {
        return { estimate: null };
      }
      const persona = (await board.listPersonas()).find((candidate) => candidate.id === p['persona']);
      if (persona === undefined) {
        return { estimate: null };
      }
      const model = personaModelFor(persona, null).model;
      return { estimate: await board.estimateOf({ gate: p['gate'], persona: persona.id, model }) };
    });

    // T-0042: a move out of tickets/archive/ performed as the board
    // treatment (archive -> <phase> stamp, Log, one commit).
    ctx.ipc.handle('unarchive', async (payload) => {
      const cmd = parseUnarchive(payload);
      return cmd.ok ? board.unarchive(cmd.value) : cmd;
    });

    // T-0042: "Remove worktree" on _worktrees/<id> (dormant until T-0044
    // creates the folder): the pure planner decides, git executes.
    ctx.ipc.handle('removeWorktree', async (payload) => {
      const p = payload as { folder?: unknown };
      const folder = typeof p.folder === 'string' ? p.folder.trim() : '';
      if (folder === '') {
        return { ok: false, error: 'bad removeWorktree payload' };
      }
      return board.removeWorktree(folder);
    });

    // --- the fleet (M84, ADR-0075) -------------------------------------
    ctx.ipc.handle('fleetStatus', async () => ({
      runs: await fleet.runs(),
      chain: await fleet.chainStatus(),
    }));

    ctx.ipc.handle('fleetStart', async (payload) => {
      const cmd = parseStartRun(payload);
      return cmd.ok ? board.startRun(cmd.value) : cmd;
    });

    ctx.ipc.handle('fleetStop', async (payload) => {
      const cmd = parseStopRun(payload);
      return cmd.ok ? fleet.stop(cmd.value.runId, cmd.value.reason) : cmd;
    });

    ctx.ipc.handle('fleetSend', async (payload) => {
      const cmd = parseSend(payload);
      return cmd.ok ? fleet.send(cmd.value.runId, cmd.value.text) : cmd;
    });

    ctx.ipc.handle('fleetAttach', async (payload) => {
      const p = payload as { runId?: unknown; name?: unknown; data?: unknown };
      if (typeof p.runId !== 'string' || typeof p.name !== 'string' || typeof p.data !== 'string') {
        return { ok: false, error: 'bad fleet attach payload' };
      }
      return fleet.attach(p.runId, p.name, p.data);
    });

    ctx.ipc.handle('fleetControl', async (payload) => {
      const p = payload as { action?: unknown; runId?: unknown };
      if (
        typeof p.runId !== 'string' ||
        (p.action !== 'takeover' &&
          p.action !== 'interrupt' &&
          p.action !== 'softpause' &&
          p.action !== 'release' &&
          p.action !== 'resume')
      ) {
        return { ok: false, error: 'bad fleet control payload' };
      }
      return fleet.control(p.action, p.runId);
    });

    ctx.ipc.handle('fleetPermission', async (payload) => {
      const cmd = parsePermission(payload);
      return cmd.ok ? fleet.answerPermission(cmd.value.runId, cmd.value.decision) : cmd;
    });

    ctx.ipc.handle('fleetAnswer', async (payload) => {
      const cmd = parseAnswer(payload);
      return cmd.ok ? fleet.answerQuestion(cmd.value.runId, cmd.value.answers) : cmd;
    });

    ctx.ipc.handle('fleetStream', async (payload) => {
      const p = payload as { runId?: unknown };
      if (typeof p.runId !== 'string') {
        return { text: '' };
      }
      return { text: (await fleet.stream(p.runId)) ?? '' };
    });

    ctx.ipc.handle('fleetLog', async () => ({ text: (await fleet.log()) ?? '' }));

    // --- worktree cleanup (T-0044, ADR-0080) --------------------------
    // Everything through real git (worktree remove/prune); the branch
    // stays. The boot sweep migrates the legacy base, ensures the
    // .gitignore entry and lists orphans (never auto-deletes them).
    ctx.ipc.handle('worktreeRemove', async (payload) => {
      const p = payload as { id?: unknown; force?: unknown };
      if (typeof p.id !== 'string') {
        return { ok: false, error: 'bad worktree remove payload' };
      }
      return board.removeWorktreeForTicket({ id: p.id, force: p.force === true });
    });

    // The thread's Changes-so-far box (req-75 W4a): the ticket's worktree
    // against its base ref, committed and uncommitted, as one file list.
    ctx.ipc.handle('worktreeChanges', async (payload) => {
      const p = payload as { id?: unknown };
      if (typeof p.id !== 'string') {
        return { files: [] };
      }
      return { files: await board.worktreeChangesOf(p.id) };
    });

    // The Review tab (E13-7): the ticket branch's unified diff and, for the
    // "Whole file" view, one file as it stands on the branch -- the same
    // board-service calls Mission Control's proof card reaches over HTTP, here
    // over the engine's invoke channel (`ticketDiff` / `ticketFile`; positional
    // arguments there, one object here).
    ctx.ipc.handle('reviewDiff', async (payload) => {
      const cmd = parseTicketId(payload, 'review diff');
      return cmd.ok ? client.invoke('ticketDiff', { id: cmd.value.id }) : { files: [], truncated: false };
    });
    ctx.ipc.handle('reviewFile', async (payload) => {
      const p = (payload ?? {}) as { id?: unknown; path?: unknown };
      return typeof p.id === 'string' && typeof p.path === 'string'
        ? client.invoke('ticketFile', { id: p.id, path: p.path })
        : { ok: false, error: 'bad review file payload' };
    });

    ctx.ipc.handle('worktreesCleanup', async () => board.worktreeCleanup());

    ctx.ipc.handle('worktreesStatus', async () => board.worktreesStatus());

    // --- the chain (M85, ADR-0077) -------------------------------------
    ctx.ipc.handle('chainStatus', async () => fleet.chainStatus());

    ctx.ipc.handle('chainMaster', async (payload) => {
      const cmd = parseChainMaster(payload);
      return cmd.ok ? chainResult(await fleet.setMaster(cmd.value.mode)) : cmd;
    });

    ctx.ipc.handle('chainColumn', async (payload) => {
      const cmd = parseChainColumn(payload);
      return cmd.ok ? chainResult(await fleet.setColumn(cmd.value.phase, cmd.value.mode)) : cmd;
    });

    ctx.ipc.handle('chainColumnStop', async (payload) => {
      const cmd = parseChainColumnStop(payload);
      return cmd.ok ? chainResult(await fleet.stopColumn(cmd.value.phase)) : cmd;
    });

    ctx.ipc.handle('chainAbort', async () => chainResult(await fleet.abortAll()));

    // --- the team (E13-8, E12-4): the remote port's own reads and controls ---
    // The Team tab and the Capacity band show what the phone shows, so they
    // ask the engine's port (through the invoke allowlist), not a copy.
    const str = (payload: unknown, key: string): string | null => {
      const value = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)[key] : undefined;
      return typeof value === 'string' && value !== '' ? value : null;
    };
    ctx.ipc.handle('personas', () => client.invoke('personas'));
    // The Board's "plan to approve": a ticket's parts that are no tickets yet.
    ctx.ipc.handle('planParts', (payload) => {
      const id = str(payload, 'id');
      return id === null ? { ok: false, error: 'bad plan parts payload' } : client.invoke('planParts', id);
    });
    ctx.ipc.handle('personaPause', (payload) => {
      const persona = str(payload, 'persona');
      const paused = (payload as { paused?: unknown } | null)?.paused;
      return persona === null || typeof paused !== 'boolean'
        ? { ok: false, error: 'bad persona pause payload' }
        : client.invoke('chainPersonaPause', { persona, paused });
    });
    ctx.ipc.handle('handoffRun', (payload) => {
      const runId = str(payload, 'runId');
      return runId === null ? { ok: false, error: 'bad hand-off payload' } : client.invoke('handoffRun', { runId });
    });
    ctx.ipc.handle('personaThread', (payload) => {
      const persona = str(payload, 'persona');
      return persona === null ? { ok: false, error: 'bad persona payload' } : client.invoke('personaThread', persona);
    });
    ctx.ipc.handle('personaThreadAppend', (payload) => {
      const persona = str(payload, 'persona');
      const text = str(payload, 'text');
      return persona === null || text === null
        ? { ok: false, error: 'bad persona message payload' }
        : client.invoke('personaThreadAppend', { persona, text });
    });
    registerChatIpc(ctx, (method, payload) => client.invoke(method, payload));
    // The Flow tab (E13-11) and the Settings page's engine half (E13-12):
    // the engine's own flow calls and `videos.*` settings, one channel each.
    for (const method of ['flow', 'flowEdit', 'flowDraft', 'flowSave', 'settingsRead', 'settingsPatch']) {
      ctx.ipc.handle(method, (payload) => client.invoke(method, payload));
    }
    ctx.ipc.handle('personaMemory', (payload) => {
      const persona = str(payload, 'persona');
      return persona === null ? { ok: false, error: 'bad persona payload' } : client.invoke('personaMemory', persona);
    });
    ctx.ipc.handle('personaMemoryAppend', (payload) => {
      const persona = str(payload, 'persona');
      const text = str(payload, 'text');
      return persona === null || text === null
        ? { ok: false, error: 'bad memory payload' }
        : client.invoke('personaMemoryAppend', { persona, text });
    });
    ctx.ipc.handle('personaMemoryPin', (payload) => {
      const persona = str(payload, 'persona');
      const p = (payload ?? {}) as { index?: unknown; pinned?: unknown };
      return persona === null || typeof p.index !== 'number' || typeof p.pinned !== 'boolean'
        ? { ok: false, error: 'bad memory pin payload' }
        : client.invoke('personaMemoryPin', { persona, index: p.index, pinned: p.pinned });
    });

    // T-0004: open the ticket's work checkout in the OS terminal — the
    // directory where `.\dev.ps1` (or the repo's own build) runs.
    ctx.ipc.handle('openRepoFolder', async (payload) => {
      const p = payload as { repo?: unknown };
      if (typeof p.repo !== 'string' || p.repo.trim() === '') {
        return { ok: false, error: 'this ticket names no repository' };
      }
      const snap = await board.snapshot();
      const repo = snap.repos.find((r) => r.name === p.repo) ?? null;
      if (repo === null) {
        return { ok: false, error: `"${p.repo}" is not in _meta/repos.md` };
      }
      if (repo.path === null) {
        return {
          ok: false,
          error: `"${repo.name}" has no local path in _meta/repos.md — add a "path:" entry`,
        };
      }
      try {
        await openTerminalAt(repo.path);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    });

    ctx.ipc.handle('initialize', async (payload) => {
      const p = payload as { vaultId?: unknown };
      return board.initialize(typeof p.vaultId === 'string' ? p.vaultId : null);
    });

    // The fleet's MCP tools (M85, SDK 1.29): the assistant and any
    // program on Drey's MCP server can drive runs conversationally.
    ctx.mcp.registerTools(
      createFleetMcpTools({
        status: async () => ({
          runs: await fleet.runs(),
          chain: await fleet.chainStatus(),
        }),
        run: (input) =>
          board.startRun({
            ticketId: input.ticketId,
            workerChoice: input.worker,
            permissionMode: input.permissionMode,
            // The MCP tool asks no handover — a fresh run (T-0049 wire default).
            handover: null,
            interactive: null,
          }),
        stop: (runId) => fleet.stop(runId, null),
        steer: (runId, text) => fleet.send(runId, text),
        watch: (runId) => fleet.stream(runId),
      }),
    );

    // Everything that can change the board: external rounds, saves of
    // ticket files, our own announces (the debounced emit coalesces).
    ctx.vault.onChanged((event) => board.onVaultEvent(event));
    ctx.save.onNoteSaved((event) => {
      if (event.path.startsWith('tickets/')) {
        board.announceChanged();
      }
    });
  },
};

export default plugin;
