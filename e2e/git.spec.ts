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

    // The panel starts closed in the left dock; Refresh looks again for
    // the repository that did not exist when the app started.
    await page.locator('app-dock-strip button[aria-label="Show Source control"]').click();
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

  test('merges with a conflict, amends, stashes and shows a file history', async ({ page, vaultDir }) => {
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: vaultDir, encoding: 'utf8' });
    const readme = path.join(vaultDir, 'readme.md');
    git('init', '-b', 'main');
    git('config', 'user.name', 'E2E');
    git('config', 'user.email', 'e2e@example.invalid');
    git('config', 'core.autocrlf', 'false');
    git('add', '-A');
    git('commit', '-m', 'Initial commit');
    git('checkout', '-b', 'feature');
    fs.writeFileSync(readme, 'feature\n');
    git('commit', '-am', 'Feature change');
    git('checkout', 'main');
    fs.writeFileSync(readme, 'main\n');
    git('commit', '-am', 'Main change');

    await page.locator('app-dock-strip button[aria-label="Show Source control"]').click();
    const panel = page.locator('app-panel-frame', { has: page.locator('.git-panel') });
    await panel.locator('button[aria-label="Refresh the status"]').click();
    await expect(panel.locator('.git-branch-btn .name')).toHaveText('main');
    const more = panel.locator('button[aria-label="More Git actions"]');
    const dialog = page.locator('.git-dialog');

    // Merge: the picker leaves out the current branch; both sides changed
    // the same line, so the merge stops.
    await more.click();
    await page.locator('.git-branch', { hasText: 'Merge a branch…' }).click();
    await expect(page.locator('.git-branch-filter')).toBeVisible();
    await expect(page.locator('.git-branch-list .git-branch')).toHaveCount(1);
    await page.locator('.git-branch', { hasText: 'feature' }).click();
    await expect(dialog.locator('.git-dialog-title')).toHaveText('Merge branch');
    await dialog.getByRole('button', { name: 'Merge', exact: true }).click();

    const banner = panel.locator('.git-banner');
    await expect(banner).toContainText('Merging feature');
    await expect(banner).toContainText('1 conflict left');
    const conflict = panel.locator('.git-change[data-status="conflict"]');
    await expect(conflict.locator('.name')).toHaveText('readme.md');
    await expect(panel.locator('button[aria-label="Resolve all conflicts to complete the merge"]')).toBeDisabled();

    // Keep theirs settles the file; an empty message completes the merge.
    await conflict.hover();
    await conflict.locator('button[aria-label="Keep theirs (incoming)"]').click();
    await dialog.getByRole('button', { name: 'Keep theirs', exact: true }).click();
    await expect(banner).toContainText('No conflicts left');
    await panel.locator('.git-message').press('Control+Enter');
    await expect(banner).toBeHidden();
    expect(fs.readFileSync(readme, 'utf8')).toBe('feature\n');
    expect(git('log', '-1', '--format=%s').trim()).toContain("Merge branch 'feature'");

    // Amend: the box takes the last message; the commit is rewritten.
    await more.click();
    await page.locator('.git-branch', { hasText: 'Amend the last commit' }).click();
    await expect(banner).toContainText('Amending the last commit');
    await expect(panel.locator('.git-message')).toHaveValue(/Merge branch 'feature'/);
    await panel.locator('.git-message').fill('Merged the feature');
    await panel.locator('.git-message').press('Control+Enter');
    await expect(banner).toBeHidden();
    expect(git('log', '-1', '--format=%s').trim()).toBe('Merged the feature');

    // Stash puts a change away, the stash list brings it back.
    fs.writeFileSync(readme, 'draft\n');
    await panel.locator('button[aria-label="Refresh the status"]').click();
    await expect(panel.locator('.git-change')).toHaveCount(1);
    await more.click();
    await page.locator('.git-branch', { hasText: 'Stash changes' }).click();
    await dialog.getByRole('button', { name: 'Stash', exact: true }).click();
    await expect(panel.locator('.git-list .git-empty').first()).toHaveText('No changes.');
    expect(fs.readFileSync(readme, 'utf8')).toBe('feature\n');
    await more.click();
    await page.locator('.git-branch', { hasText: 'Stashes…' }).click();
    await expect(page.locator('.git-stash')).toHaveCount(1);
    await page.locator('.git-stash button[aria-label="Apply and remove this stash"]').click();
    await expect(panel.locator('.git-change')).toHaveCount(1);
    expect(fs.readFileSync(readme, 'utf8')).toBe('draft\n');

    // The history of the open file: its commits, the first one's changes.
    await page.locator('app-files-panel .node.file', { hasText: 'readme.md' }).click();
    await more.click();
    await page.locator('.git-branch', { hasText: 'Git history of this file…' }).click();
    await expect(dialog.locator('.git-dialog-title')).toHaveText('Git history');
    await expect(dialog.locator('.git-dialog-sub')).toContainText('readme.md');
    await expect(dialog.locator('.git-history-list .git-commit').first()).toHaveClass(/on/);
    await expect(dialog.locator('.git-history-detail .git-diff .add').first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
  });
});
