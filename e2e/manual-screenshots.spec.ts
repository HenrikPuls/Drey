import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { test, expect, type Page, type ElectronApplication } from './fixtures/drey';

/**
 * NOT a regression suite: this drives the built app through the same
 * fixtures to capture the screenshots embedded in docs/manual/manual.md (the
 * user manual). Opt-in only, so CI and the normal e2e run skip it:
 *
 *   . .\env.ps1
 *   $env:DREY_MANUAL_SHOTS = '1'
 *   npm run e2e:run -- manual-screenshots
 *
 * Prerequisite: `npm run build` (fresh dist-electron + dist/drey/browser).
 * Output: docs/manual/img/*.png (committed with the manual).
 *
 * The demo vault is English throughout — notes, file and folder names,
 * tags, templates and prompts (CLAUDE.md language convention: nothing in
 * a screenshot that ships is German).
 */

const RUN = !!process.env['DREY_MANUAL_SHOTS'];
test.skip(!RUN, 'set DREY_MANUAL_SHOTS=1 — screenshot capture for docs/manual/manual.md');

const OUT = path.resolve(__dirname, '..', 'docs', 'manual', 'img');
if (RUN) {
  fs.mkdirSync(OUT, { recursive: true });
}

/** One consistent window size for every shot in the manual. */
const WIDTH = 1600;
const HEIGHT = 1000;

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(OUT, name) });
}

async function prep(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.getURL().startsWith('app://')) {
        win.setContentSize(size.width, size.height);
      }
    }
  }, { width: WIDTH, height: HEIGHT });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(250);
  // The manual ships in the Anthrazit theme (the fresh-install default,
  // ADR-0057 later change) -- fail loudly if a shot would land in another.
  // Polled: the saved config (and with it the theme) applies a beat after
  // the first paint.
  await expect
    .poll(
      async () => page.evaluate(() => document.documentElement.dataset['theme'] ?? ''),
      { timeout: 10_000 },
    )
    .toBe('anthrazit');
}

/**
 * Only the given left-dock panel is open; Calendar+Files fold away.
 * Milestone 69: a closed panel lives on only as its icon in the dock's
 * strip (`Show X`), an open one is `Hide X` with `aria-pressed` -- the
 * collapsed panel headers of ADR-0019 are gone.
 */
async function soloPanel(page: Page, title: string): Promise<void> {
  const strip = page.locator('app-dock[side="left"] app-dock-strip');
  for (const other of ['Calendar', 'Files']) {
    const hide = strip.locator(`button[aria-label="Hide ${other}"]`);
    if ((await hide.count()) && (await hide.getAttribute('aria-pressed')) === 'true') {
      await hide.click();
    }
  }
  // The panel may already be open (the git plugin expands itself when it
  // picks up a repository) -- only click when its Show button exists.
  const show = strip.locator(`button[aria-label="Show ${title}"]`);
  if (await show.count()) {
    await show.click();
  }
  await page.waitForTimeout(150);
}

/** Opens the folder's tree node only when actually collapsed (clicks toggle). */
async function ensureFolderOpen(page: Page, folder: string): Promise<void> {
  const node = page.locator('app-dock[side="left"] .node.folder', { hasText: folder }).first();
  const twist = node.locator('app-icon.twist');
  const style = (await twist.getAttribute('style')) ?? '';
  if (!style.includes('rotate')) {
    await node.click();
    await page.waitForTimeout(150);
  }
}

/** Opens a vault file from the Files tree, expanding folders on the way. */
async function openFile(
  page: Page,
  relPath: string,
  opts: { folders?: string[] } = {},
): Promise<void> {
  const expandFiles = page.locator(
    'app-dock[side="left"] app-dock-strip button[aria-label="Show Files"]',
  );
  if (await expandFiles.count()) {
    await expandFiles.click();
  }
  // Let the freshly mounted tree settle before reading its folder state.
  await expect(page.locator('app-files-panel .node.folder').first()).toBeVisible();
  await page.waitForTimeout(150);
  for (const folder of opts.folders ?? []) {
    await ensureFolderOpen(page, folder);
  }
  const file = page
    .locator('app-dock[side="left"] .node.file', { hasText: path.basename(relPath) })
    .first();
  await expect(file).toBeVisible();
  await file.click();
  await expect(page.locator('app-editor .cm-content')).toBeVisible();
  await page.waitForTimeout(150);
}

// ---------------------------------------------------------------------------
// The demo vault: realistic English notes exercising tags, tasks with due
// date + priority, wikilinks, tables, code blocks, daily entries, templates.
// ---------------------------------------------------------------------------

const DEMO: Record<string, string> = {
  'daily/2026-10-13.md': [
    '---',
    'title: Daily 2026-10-13',
    '---',
    '',
    '# 2026-10-13',
    '',
    '## 09:12',
    '',
    'First coffee, then clearing the #inbox: two open points from the relaunch got stuck.',
    '',
    '## 13:40',
    '',
    'The editorial team asked about the image rights — checked against [[Website-Relaunch]], looks fine.',
    '',
    '## 18:05',
    '',
    'A short sail before dinner: only practised tacking in the harbour basin. #knowledge/sailing',
    '',
  ].join('\n'),

  'Projects/Website-Relaunch.md': [
    '---',
    'title: Website-Relaunch',
    '---',
    '',
    '# Website-Relaunch #project/relaunch',
    '',
    'Status stays green, go-live in two weeks. The dependencies are listed in [[Drey-Roadmap]].',
    '',
    '## Open tasks',
    '',
    '- [ ] Clear the image rights with the editorial team 📅 2026-10-16 ⏫',
    '- [ ] Check the redirect table from the old system 📅 2026-10-18',
    '- [ ] Send the footer texts to the editorial team #web',
    '- [x] Set up the staging environment',
    '',
    '## Notes',
    '',
    'The new colour scheme follows the app\'s Anthrazit theme — calm surfaces, one blue as the accent.',
    'The start page stays single-column; assets live under `assets/` and are bundled at build time.',
    '',
  ].join('\n'),

  'Projects/Drey-Roadmap.md': [
    '# Drey-Roadmap #project',
    '',
    'My personal list of things to build out in the vault.',
    '',
    '## Next steps',
    '',
    '- [ ] Try the vault search in everyday use 🔽',
    '- [ ] Bring a weekly review block into the daily note 📅 2026-10-14',
    '- [x] Create a Git repository for the vault',
    '',
    '## References',
    '',
    '- [[Website-Relaunch]] — the sister project',
    '- [[Sailing-Terms]] — balance at the weekend',
    '',
  ].join('\n'),

  'Knowledge/Sailing-Terms.md': [
    '---',
    'title: Sailing: terms',
    '---',
    '',
    '# Sailing-Terms #knowledge/sailing',
    '',
    'A small collection, so I stop mixing up the terms.',
    '',
    '## Bow & stern',
    '',
    'The bow is the front end of the boat, the stern the back end.',
    '',
    '## Manoeuvres',
    '',
    'In a tack the boat turns its bow through the wind, in a gybe its stern.',
    'The gybe is the more dangerous manoeuvre — the boom swings across.',
    '',
  ].join('\n'),

  'Knowledge/Markdown-Cheatsheet.md': [
    '# Markdown-Cheatsheet',
    '',
    'A few building blocks that look especially good in Live Preview.',
    '',
    '## Text',
    '',
    '**Bold**, *italic*, `inline code`, ~~struck through~~ and a [link](https://drey.lariscus.de).',
    'Inline #tags become pills, [[Sailing-Terms]] opens the target note on click.',
    '',
    '> Quotes are indented and set apart in colour — good for excerpts from mails.',
    '',
    '## Table',
    '',
    '| Block | Syntax | Note |',
    '| --- | --- | --- |',
    '| Task | `- [ ]` | due with `📅` + date |',
    '| Tag | `#tag` | renders as a pill |',
    '| Wikilink | `[[Target]]` | creates a missing note |',
    '',
    '## Code',
    '',
    '```ts',
    'const vaults = await api.vault.list();',
    '```',
    '',
  ].join('\n'),

  'templates/daily.md': [
    '# {{date}}',
    '',
    '## Morning',
    '',
    '- ',
    '',
    '## Afternoon',
    '',
    '- ',
    '',
  ].join('\n'),

  'templates/standup.md': '## Standup\n\n- Yesterday:\n- Today:\n- Blockers:\n',

  'templates/prompts/day-review.md': [
    '# Day review',
    '> Sums up the day in three sentences and names loose ends.',
    '',
    'Sum up my day in three sentences. Point out loose ends at the end.',
    '',
  ].join('\n'),
};

// ---------------------------------------------------------------------------
// A tiny OpenAI-compatible mock (GET /v1/models, streamed POST
// /v1/chat/completions) so the assistant chat shows a real turn without a
// local model. Wire shape per electron/llm/providers/openai-compat.ts.
// Fixed port: the URL must be known when `test.use` registers the config.
// ---------------------------------------------------------------------------

const MOCK_LLM_PORT = 27319;
const MOCK_LLM_BASE_URL = `http://127.0.0.1:${MOCK_LLM_PORT}/v1`;

const CHAT_REPLY = [
  'A short overview of the relaunch: the image rights are the only risk with a deadline (16 Oct),',
  'the redirect table has time. The staging environment has been up since Monday.',
  'Recommendation: clear the image rights today — the rest is housekeeping.',
].join(' ');

function mockLlmHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? '';
  if (req.method === 'GET' && url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'drey-demo-model' }] }));
    return;
  }
  if (req.method === 'POST' && url.endsWith('/chat/completions')) {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      // The assistant streams plain asks (SSE) but runs tool-capable turns
      // non-streamed -- answer both wire shapes.
      if (!raw.includes('"stream":true')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: CHAT_REPLY } }],
            usage: { prompt_tokens: 42, completion_tokens: 87 },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const words = CHAT_REPLY.split(' ');
      let i = 0;
      const timer = setInterval(() => {
        if (i < words.length) {
          const chunk = (i === 0 ? '' : ' ') + words[i++];
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        } else {
          clearInterval(timer);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 40);
    });
    return;
  }
  res.writeHead(404);
  res.end();
}

if (RUN) {
  const server = http.createServer(mockLlmHandler);
  // Playwright loads the spec module more than once per worker; the first
  // listener wins and serves them all. Anything but EADDRINUSE is real.
  server.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
  });
  server.listen(MOCK_LLM_PORT, '127.0.0.1');
}

// ---------------------------------------------------------------------------
// 1 — window, menus, editor, slash menu, palettes, panes
// ---------------------------------------------------------------------------

test.describe('manual: shell & editor', () => {
  test.use({ seedVault: DEMO });

  test('window overview, titlebar menu, editor modes, slash menu, palettes, panes', async ({
    page,
    electronApp,
  }) => {
    await prep(electronApp, page);

    // The overview: a note with tags, wikilinks and tasks in Live Preview,
    // default layout (Calendar + Files left, Assistant right).
    await openFile(page, 'Projects/Website-Relaunch.md', { folders: ['Projects'] });
    await page.locator('app-editor .cm-line', { hasText: 'image rights' }).first().click();
    await page.waitForTimeout(250);
    await shoot(page, 'window-overview.png');

    // The titlebar's View menu (closed by clicking its backdrop overlay --
    // neither Escape nor the covered label dismiss it).
    await page.locator('app-titlebar .menu-label', { hasText: 'View' }).click();
    await expect(page.locator('app-titlebar .popover')).toBeVisible();
    await shoot(page, 'titlebar-view-menu.png');
    await page.locator('app-titlebar .overlay').click({ force: true });
    await expect(page.locator('app-titlebar .popover')).toHaveCount(0);

    // The editor meta bar's ⋯ menu (mode switch, save-as, history, PDF, …);
    // closed through its own backdrop.
    await page.locator('app-editor .more').click();
    await expect(page.locator('.editor-menu')).toBeVisible();
    await shoot(page, 'editor-more-menu.png');
    await page.locator('app-editor .ctx-backdrop').click({ force: true });
    await expect(page.locator('.editor-menu')).toHaveCount(0);

    // Source mode for the same note.
    await page.locator('app-editor .more').click();
    await page.locator('.editor-menu button', { hasText: 'Source' }).click();
    await page.waitForTimeout(250);
    await shoot(page, 'editor-source.png');
    await page.locator('app-editor .more').click();
    await page.locator('.editor-menu button', { hasText: 'Live Preview' }).click();

    // The file palette.
    await page.keyboard.press('Control+P');
    await page.keyboard.type('rela');
    await page.waitForTimeout(300);
    await shoot(page, 'palette-files.png');
    await page.keyboard.press('Escape');

    // The command palette.
    await page.keyboard.press('Control+Shift+P');
    await page.waitForTimeout(300);
    await shoot(page, 'palette-commands.png');
    await page.keyboard.press('Escape');

    // The slash menu on a fresh note: Entry block + vault templates. Typing
    // on filters the same popup -- no close/reopen in between.
    await page.keyboard.press('Control+N');
    await expect(page.locator('app-editor .cm-content')).toBeVisible();
    await page.locator('app-editor .cm-content').click();
    await page.keyboard.type('/');
    const slash = page.locator('app-editor .cm-tooltip-autocomplete');
    await expect(slash).toBeVisible();
    await page.waitForTimeout(250);
    await shoot(page, 'slash-menu.png');

    // A snippet trigger (tbl) narrows the same popup to the block preview.
    await page.keyboard.type('tbl');
    await expect(slash.locator('li', { hasText: 'Table' })).toBeVisible();
    await page.waitForTimeout(250);
    await shoot(page, 'snippet-menu.png');
    await page.keyboard.press('Escape');

    // Back to the note, then split panes: two documents side by side.
    await page.locator('app-tab-bar .tab', { hasText: 'Website-Relaunch' }).click();
    await page.waitForTimeout(150);
    await page.keyboard.press('Control+Alt+Enter');
    await page.waitForTimeout(250);
    await page.keyboard.press('Control+P');
    await page.keyboard.type('cheatsheet');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await shoot(page, 'panes-split.png');
  });
});

// ---------------------------------------------------------------------------
// 2 — the dock panels
// ---------------------------------------------------------------------------

test.describe('manual: panels', () => {
  test.use({ seedVault: DEMO });

  test('calendar, files, search, tasks, templates, outline, backlinks, windows', async ({
    page,
    electronApp,
  }) => {
    await prep(electronApp, page);

    // Calendar with today's daily note open behind it. (The Today button
    // lives in the panel-frame head projection, not under app-calendar.)
    await page.locator("button[aria-label=\"Open today's daily note\"]").click();
    await expect(page.locator('app-editor .cm-content')).toContainText('2026-10-13');
    await page.waitForTimeout(250);
    await shoot(page, 'panel-calendar.png');

    // Files panel: tree with folders, one folder's context menu open.
    await openFile(page, 'Knowledge/Sailing-Terms.md', { folders: ['Knowledge'] });
    await shoot(page, 'panel-files.png');
    await page
      .locator('app-dock[side="left"] .node.folder', { hasText: 'Projects' })
      .click({ button: 'right' });
    await page.waitForTimeout(200);
    await shoot(page, 'panel-files-context-menu.png');
    await page.keyboard.press('Escape');

    // Search panel: grouped results for a text query.
    await soloPanel(page, 'Search');
    const search = page.locator('app-panel-frame', { has: page.locator('.tag-search') });
    await expect(search.locator('.tag-search-field .tag-field-input').first()).toBeVisible();
    await search.locator('.tag-search-field .tag-field-input').first().fill('Relaunch');
    await search.locator('.tag-search-field .tag-field-input').first().press('Enter');
    await expect(search.locator('.tag-search-hit').first()).toBeVisible();
    await page.waitForTimeout(250);
    await shoot(page, 'panel-search.png');

    // Tasks panel: vault scope with due badges and priority glyphs. The
    // document scope needs a task-carrying note open; vault scope reads the
    // plugin's whole-vault index.
    await openFile(page, 'Projects/Website-Relaunch.md', { folders: ['Projects'] });
    await soloPanel(page, 'Tasks');
    const tasks = page.locator('app-panel-frame', { has: page.locator('.tasks-panel') });
    await expect(tasks.locator('.task').first()).toBeVisible();
    await tasks.locator('.seg button[data-scope="vault"]').click();
    await expect(tasks.locator('.task').nth(2)).toBeVisible();
    await page.waitForTimeout(250);
    await shoot(page, 'panel-tasks.png');

    // Templates panel: the vault's template library.
    await soloPanel(page, 'Templates');
    await page.waitForTimeout(400);
    await shoot(page, 'panel-templates.png');

    // Outline of the open note.
    await openFile(page, 'Knowledge/Markdown-Cheatsheet.md');
    await soloPanel(page, 'Outline');
    await page.waitForTimeout(400);
    await shoot(page, 'panel-outline.png');

    // Backlinks into the relaunch note.
    await openFile(page, 'Projects/Website-Relaunch.md', { folders: ['Projects'] });
    await soloPanel(page, 'Backlinks');
    await page.waitForTimeout(600);
    await shoot(page, 'panel-backlinks.png');

    // Open windows.
    await soloPanel(page, 'Open windows');
    await page.waitForTimeout(300);
    await shoot(page, 'panel-windows.png');
  });
});

// ---------------------------------------------------------------------------
// 3 — the assistant with a mocked local model
// ---------------------------------------------------------------------------

test.describe('manual: assistant', () => {
  test.use({
    seedVault: DEMO,
    appConfig: {
      llm: {
        enabled: true,
        provider: 'openai-compat',
        baseUrl: MOCK_LLM_BASE_URL,
        apiKey: null,
        model: 'drey-demo-model',
      },
    },
  });

  test('a chat turn streams an answer; the picker lists the conversation', async ({
    page,
    electronApp,
  }) => {
    await prep(electronApp, page);

    const panel = page.locator('app-panel-frame', { has: page.locator('.assistant-panel') });
    await expect(panel.locator('.assistant-head .chat-label')).toBeVisible();

    const composer = panel.locator('.assistant-composer .composer-input .cm-content');
    await composer.click();
    await page.keyboard.type('How is the website relaunch going?');
    await page.keyboard.press('Enter');

    // The turn card with the streamed answer.
    await expect(panel.locator('.assistant-thread')).toContainText('image rights', {
      timeout: 30_000,
    });
    await page.waitForTimeout(600);
    await shoot(page, 'assistant-chat.png');

    // The chat picker.
    await panel.locator('.assistant-head button[aria-label="Switch chat"]').click();
    await page.waitForTimeout(300);
    await shoot(page, 'assistant-chat-picker.png');
  });
});

// ---------------------------------------------------------------------------
// 4 — git source control
// ---------------------------------------------------------------------------

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test.describe('manual: git', () => {
  test.skip(!hasGit(), 'git is not installed');

  test.use({
    seedVault: {
      'docs/index.md': '# Index\n\nThe wiki\'s start page.\n',
      'docs/old.md': 'old\n',
      'readme.md': '# Vault\n\nThe notes vault.\n',
    },
  });

  test('source control panel, files decorations, diff dialog', async ({
    page,
    electronApp,
    vaultDir,
  }) => {
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: vaultDir, encoding: 'utf8' });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Manual');
    git('config', 'user.email', 'manual@example.invalid');
    git('config', 'core.autocrlf', 'false');
    git('add', '-A');
    git('commit', '-m', 'Initial commit');
    fs.writeFileSync(
      path.join(vaultDir, 'docs', 'index.md'),
      '# Index\n\nThe wiki\'s start page.\n\nA new paragraph.\n',
    );
    fs.writeFileSync(path.join(vaultDir, 'docs', 'new.md'), 'new\n');
    fs.rmSync(path.join(vaultDir, 'docs', 'old.md'));

    await prep(electronApp, page);

    await soloPanel(page, 'Source control');
    const panel = page.locator('app-panel-frame', { has: page.locator('.git-panel') });
    // The repository was created after launch; Refresh makes the plugin
    // look again (same as git.spec).
    await panel.locator('button[aria-label="Refresh the status"]').click();
    await expect(panel.locator('.git-change').first()).toBeVisible({ timeout: 15_000 });
    if ((await panel.locator('.git-commit').count()) === 0) {
      await panel.locator('.git-history').click(); // unfold History
    }
    await expect(panel.locator('.git-commit').first()).toBeVisible();
    await page.waitForTimeout(250);
    await shoot(page, 'panel-git.png');

    // Files panel carries the git decorations.
    await soloPanel(page, 'Files');
    await page.locator('app-dock[side="left"] .node.folder', { hasText: 'docs' }).click();
    await page.waitForTimeout(400);
    await shoot(page, 'git-files-badges.png');

    // The diff dialog from a row click.
    await soloPanel(page, 'Source control');
    await panel.locator('.git-change', { hasText: 'index.md' }).click();
    const diff = page.locator('app-diff-dialog .dialog');
    await expect(diff).toBeVisible();
    await shoot(page, 'dialog-diff.png');
    await diff.locator('button', { hasText: 'Close' }).click();
  });
});

// ---------------------------------------------------------------------------
// 5 — every settings category
// ---------------------------------------------------------------------------

test.describe('manual: settings', () => {
  test.use({
    seedVault: DEMO,
    appConfig: {
      llm: {
        enabled: true,
        provider: 'lmstudio',
        baseUrl: 'http://localhost:1234/v1',
        apiKey: null,
        model: 'qwen2.5-7b-instruct',
      },
    },
  });

  test('walk every settings category and shoot it', async ({ page, electronApp }) => {
    await prep(electronApp, page);

    await page.locator('app-status-bar .settings').click();
    // The host component stays display-less until its screen opens -- the
    // category list is the reliable visibility probe.
    await expect(page.locator('app-settings .category').first()).toBeVisible();

    const slug = (label: string): string =>
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

    const count = await page.locator('app-settings .category').count();
    expect(count).toBeGreaterThan(5);
    for (let i = 0; i < count; i++) {
      const category = page.locator('app-settings .category').nth(i);
      await category.scrollIntoViewIfNeeded();
      await category.click();
      await page.waitForTimeout(300);
      const label = (await category.textContent())?.trim() ?? `category-${i}`;
      await shoot(page, `settings-${slug(label)}.png`);
    }

    // The auto slug glues the category's label and hint together -- rename
    // to the curated file names the manual references.
    const renames: Array<[string, string]> = [
      ['settings-aboutversion-licenses.png', 'settings-about.png'],
      ['settings-actionsprompt-templates-triggers.png', 'settings-actions.png'],
      ['settings-appearancetype-size-colour-font.png', 'settings-appearance.png'],
      ['settings-assistant-toolsvault-web-mcp-servers.png', 'settings-assistant-tools.png'],
      ['settings-daily-notesstartup-storage-folder.png', 'settings-daily-notes.png'],
      ['settings-diagramsformat-of-new-diagrams.png', 'settings-diagrams.png'],
      ['settings-entry-formatthe-menu-entry-block.png', 'settings-entry-format.png'],
      ['settings-gitgit-executable.png', 'settings-git.png'],
      ['settings-keyboard-shortcutscommands-quick-capture.png', 'settings-keyboard-shortcuts.png'],
      ['settings-llmlocal-model-connection.png', 'settings-llm.png'],
      ['settings-mcpvault-server-for-other-apps.png', 'settings-mcp.png'],
      ['settings-panels-pluginstoggle-panels-plugins.png', 'settings-panels-plugins.png'],
      ['settings-spellingdictionaries-language.png', 'settings-spelling.png'],
      ['settings-tagstag-colors-rename-and-merge.png', 'settings-tags.png'],
      ['settings-templatessnippet-library-folder.png', 'settings-templates.png'],
      ['settings-vaultexternal-change-detection.png', 'settings-vault.png'],
    ];
    for (const [auto, curated] of renames) {
      const from = path.join(OUT, auto);
      if (fs.existsSync(from)) {
        fs.renameSync(from, path.join(OUT, curated));
      }
    }

    await page.locator('app-settings .close').click();
  });
});

// ---------------------------------------------------------------------------
// 6 — version history, replace confirmation, save conflict
// ---------------------------------------------------------------------------

test.describe('manual: history & dialogs', () => {
  test.use({ seedVault: DEMO });

  test('file history, vault replace confirmation, save conflict', async ({
    page,
    electronApp,
    vaultDir,
  }) => {
    await prep(electronApp, page);

    // Two saves -> two versions in the local history.
    await openFile(page, 'Knowledge/Sailing-Terms.md', { folders: ['Knowledge'] });
    const editor = page.locator('app-editor .cm-content');
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\nAddendum: in a tack the crew handles the jib sheet.\n');
    await page.keyboard.press('ControlOrMeta+S');
    await page.waitForTimeout(600);
    await page.keyboard.type('Second addendum: on a broad reach the boom stays secured.\n');
    await page.keyboard.press('ControlOrMeta+S');
    await page.waitForTimeout(600);

    await page.locator('app-editor .more').click();
    await page.locator('.editor-menu button', { hasText: 'File history' }).click();
    const history = page.locator('app-history-dialog .dialog');
    await expect(history).toBeVisible();
    await page.waitForTimeout(300);
    await shoot(page, 'dialog-history.png');
    await history.locator('button', { hasText: 'Close' }).click();

    // Vault-wide replace: the bundled confirmation dialog.
    await soloPanel(page, 'Search');
    const search = page.locator('app-panel-frame', { has: page.locator('.tag-search') });
    await search.locator('.tag-search-field .tag-field-input').first().fill('colour scheme');
    await search.locator('.tag-search-field .tag-field-input').first().press('Enter');
    await expect(search.locator('.tag-search-hit').first()).toBeVisible();
    await search.locator('.tag-search-summary [aria-label="Replace"]').click();
    await search.locator('.tag-search-replace input').fill('colour palette');
    await search.locator('.tag-search-replace [aria-label="Replace all"]').click();
    const modal = page.locator('.plugin-modal.tag-search-modal');
    await expect(modal).toBeVisible();
    await shoot(page, 'dialog-confirm-replace.png');
    await modal.locator('button', { hasText: 'Replace all' }).click();
    await expect(modal).toHaveCount(0);

    // Save conflict: the file changes on disk while the tab is edited.
    await openFile(page, 'Knowledge/Markdown-Cheatsheet.md');
    fs.appendFileSync(
      path.join(vaultDir, 'Knowledge', 'Markdown-Cheatsheet.md'),
      '\n> Added from outside while the tab was open.\n',
    );
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\nMy own addition in the tab.\n');
    await page.keyboard.press('ControlOrMeta+S');
    const conflict = page.locator('app-conflict-dialog .dialog');
    await expect(conflict).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(300);
    await shoot(page, 'dialog-conflict.png');
    await page.keyboard.press('Escape').catch(() => undefined);
  });
});

// ---------------------------------------------------------------------------
// 7 — diagrams (draw.io) — the embed always; the editor tab needs the
//     fetched web app (npm run fetch:drawio)
// ---------------------------------------------------------------------------

const DIAGRAM_XML =
  '<mxfile><diagram name="Page-1"><mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="2" value="Vault" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1">' +
  '<mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>' +
  '</root></mxGraphModel></diagram></mxfile>';

const escapeAttribute = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const DIAGRAM_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="1px" height="1px" ' +
  `viewBox="-0.5 -0.5 1 1" content="${escapeAttribute(DIAGRAM_XML)}"></svg>\n`;

test.describe('manual: diagrams & media', () => {
  const webapp = path.resolve(
    __dirname,
    '..',
    'dist-electron',
    'plugins',
    'drawio',
    'webapp',
    'index.html',
  );

  test.use({
    seedVault: {
      ...DEMO,
      'img/diagram.drawio.svg': DIAGRAM_SVG,
      'img/plain.drawio': DIAGRAM_XML,
      'Workflow.md': '# Workflow\n\n![Diagram](img/diagram.drawio.svg)\n\nEnd.\n',
    },
  });

  test('a diagram embeds as a picture; with the web app fetched, its tab opens', async ({
    page,
    electronApp,
  }) => {
    await prep(electronApp, page);

    // The embedded .drawio.svg renders as an ordinary picture in the note.
    await openFile(page, 'Workflow.md');
    await page.waitForTimeout(400);
    await shoot(page, 'editor-drawio-embed.png');

    test.skip(!fs.existsSync(webapp), 'draw.io web app not fetched (npm run fetch:drawio)');

    // The .drawio file opens in the bundled draw.io editor tab.
    await page.locator('app-dock[side="left"] .node.folder', { hasText: 'img' }).click();
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'plain.drawio' }).click();
    const frame = page.frameLocator('iframe.drawio-frame');
    await expect(frame.locator('.geDiagramContainer')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1_000);
    await shoot(page, 'tab-drawio.png');
  });
});
