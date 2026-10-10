import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from './fixtures/drey';

/**
 * Git vaults (plugins/git, milestone 65, ADR-0065): the seeded vault is
 * turned into a repository, then the Source control panel and the Files
 * panel are driven against the real `git`. Skipped when git is not
 * installed.
 */

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test.use({ seedVault: { 'docs/index.md': '# Index\n', 'docs/old.md': 'old\n', 'readme.md': 'readme\n' } });

test.describe('Source control panel (plugins/git, milestone 65)', () => {
  test.skip(!hasGit(), 'git is not installed');

  test('shows the status in panel and tree, compares, commits and creates a branch', async ({
    page,
    vaultDir,
  }) => {
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: vaultDir, encoding: 'utf8' });
    git('init', '-b', 'main');
    git('config', 'user.name', 'E2E');
    git('config', 'user.email', 'e2e@example.invalid');
    git('config', 'core.autocrlf', 'false');
    git('add', '-A');
    git('commit', '-m', 'Initial commit');
    fs.writeFileSync(path.join(vaultDir, 'docs', 'index.md'), '# Index\n\nA new paragraph.\n');
    fs.writeFileSync(path.join(vaultDir, 'docs', 'new.md'), 'new\n');
    fs.rmSync(path.join(vaultDir, 'docs', 'old.md'));

    // The panel lands collapsed in the left dock; Refresh looks again for
    // the repository that did not exist when the app started.
    await page.locator('app-panel-frame .head[aria-label="Expand Source control"]').click();
    const panel = page.locator('app-panel-frame', { has: page.locator('.git-panel') });
    await panel.locator('button[aria-label="Refresh the status"]').click();

    await expect(panel.locator('.git-branch-btn .name')).toHaveText('main');
    const changes = panel.locator('.git-change');
    await expect(changes).toHaveCount(3);
    await expect(panel.locator('.git-change[data-status="deleted"] .name')).toHaveText('old.md');

    // Files panel: the changed file carries tone + badge, its folder the tone.
    await page.locator('button[aria-label="Refresh files"]').click();
    const folder = page.locator('app-files-panel .node.folder', { hasText: 'docs' });
    await expect(folder).toHaveAttribute('data-status', 'modified');
    await folder.click();
    const modified = page.locator('app-files-panel .node.file', { hasText: 'index.md' });
    await expect(modified).toHaveAttribute('data-status', 'modified');
    await expect(modified.locator('.status-badge')).toHaveText('M');
    await expect(
      page.locator('app-files-panel .node.file', { hasText: 'new.md' }).locator('.status-badge'),
    ).toHaveText('U');
    await expect(page.locator('app-files-panel .node.file', { hasText: 'readme.md' })).not.toHaveAttribute(
      'data-status',
    );

    // A row click compares the working copy with the last commit.
    await panel.locator('.git-change', { hasText: 'index.md' }).click();
    const diff = page.locator('app-diff-dialog .dialog');
    await expect(diff).toContainText('docs/index.md');
    await expect(diff).toContainText('A new paragraph.');
    await diff.locator('button', { hasText: 'Close' }).click();
    await expect(diff).toBeHidden();

    // Stage everything, commit with Ctrl+Enter.
    await panel.locator('button[aria-label="Stage all changes"]').click();
    await expect(panel.locator('.git-group', { hasText: 'Staged changes' }).locator('.count')).toHaveText('3');
    await panel.locator('.git-message').fill('Update the docs');
    await panel.locator('.git-message').press('Control+Enter');
    await expect(panel.locator('.git-list .git-empty').first()).toHaveText('No changes.');
    expect(git('log', '-1', '--format=%s').trim()).toBe('Update the docs');
    await expect(modified).not.toHaveAttribute('data-status');

    // History lists the commits.
    await panel.locator('.git-history').click();
    await expect(panel.locator('.git-commit .subject').first()).toHaveText('Update the docs');
    await expect(panel.locator('.git-commit')).toHaveCount(2);

    // A new branch through the picker.
    await panel.locator('.git-branch-btn').click();
    const filter = page.locator('.git-branch-filter');
    await filter.fill('feature/docs');
    await expect(page.locator('.git-branch', { hasText: 'Create branch "feature/docs"' })).toBeVisible();
    await filter.press('Enter');
    await expect(panel.locator('.git-branch-btn .name')).toHaveText('feature/docs');
    expect(git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/docs');
  });
});
