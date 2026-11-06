<#
  Cleans up what the agent sessions left behind. DRY RUN by default: it only prints
  what it would delete. Pass -Apply to delete. Read the output first.

    .\scripts\cleanup-session-leftovers.ps1            # list only
    .\scripts\cleanup-session-leftovers.ps1 -Apply     # delete

  What it touches, and only this:
   1. Git worktrees under <repo>\.claude\worktrees whose branch is fully merged into
      `desktop-integration` AND whose working tree is clean (no uncommitted files). The worktree
      is removed (no --force) and the branch is deleted. Unmerged or dirty ones are skipped
      and listed. Run it only after `desktop-integration` has been pushed.
   2. Scratch folders and files in E:\ named dk* (E:\dkr1, E:\dkv, E:\dkr-*.txt ...).
   3. The private working copies of `dk` (%LOCALAPPDATA%\dricket) - dk recreates them.
   4. Temp leftovers: %TEMP%\dk*, %TEMP%\drey-vault-*, %TEMP%\tickets-engine-*.

  It never touches: E:\projects\drey-tickets (your real ticket repo and its _worktrees),
  Drey-desktop-integration, Drey-kimi-test, Drey-tickets-engine, the main checkouts, ~/.drey-engine.
#>
param(
  [switch]$Apply,
  [string]$Repo = 'E:\projects\Drey',
  [string]$Target = 'desktop-integration'
)

$ErrorActionPreference = 'Continue'
function Say($m) { Write-Host $m }
function Act($what, [scriptblock]$do) {
  if ($Apply) { Say "DELETE  $what"; & $do } else { Say "would delete  $what" }
}

# --- 1. merged, clean worktrees ------------------------------------------------------------
Say "== 1. worktrees under $Repo\.claude\worktrees merged into $Target"
$wtRoot = (Join-Path $Repo '.claude\worktrees').ToLower().Replace('\', '/')
$entries = git -C $Repo worktree list --porcelain | Out-String
$blocks = $entries -split "(\r?\n){2,}" | Where-Object { $_ -match 'worktree ' }
foreach ($b in $blocks) {
  $path = ($b -split "\r?\n" | Where-Object { $_ -like 'worktree *' } | Select-Object -First 1) -replace '^worktree ', ''
  $branchLine = $b -split "\r?\n" | Where-Object { $_ -like 'branch *' } | Select-Object -First 1
  if (-not $path.ToLower().Replace('\', '/').StartsWith($wtRoot)) { continue }
  $branch = if ($branchLine) { $branchLine -replace '^branch refs/heads/', '' } else { $null }
  if (-not $branch) { Say "skip  $path  (detached HEAD)"; continue }
  git -C $Repo merge-base --is-ancestor $branch $Target 2>$null
  if ($LASTEXITCODE -ne 0) { Say "SKIP (not merged into $Target)  $branch   $path"; continue }
  $dirty = git -C $path status --porcelain 2>$null
  if ($dirty) { Say "SKIP (uncommitted files)  $branch   $path"; continue }
  Act "worktree $path  + branch $branch" {
    git -C $Repo worktree remove $path
    if ($LASTEXITCODE -eq 0) { git -C $Repo branch -D $branch | Out-Null }
    else { Say "   could not remove $path (a session may still run in it) - branch kept" }
  }
}
git -C $Repo worktree prune

# --- 2. scratch in E:\ ---------------------------------------------------------------------
Say "`n== 2. E:\dk* scratch"
Get-ChildItem -LiteralPath 'E:\' -Filter 'dk*' -Force -ErrorAction SilentlyContinue | ForEach-Object {
  Act $_.FullName { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Continue }
}

# --- 3. dk private working copies -------------------------------------------------------------
Say "`n== 3. $env:LOCALAPPDATA\dricket"
$dk = Join-Path $env:LOCALAPPDATA 'dricket'
if (Test-Path $dk) {
  Get-ChildItem -LiteralPath $dk -Force | ForEach-Object {
    Act $_.FullName { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Continue }
  }
}

# --- 4. temp ----------------------------------------------------------------------------------
Say "`n== 4. $env:TEMP leftovers"
foreach ($pat in 'dk*', 'drey-vault-*', 'tickets-engine-*') {
  Get-ChildItem -LiteralPath $env:TEMP -Filter $pat -Force -ErrorAction SilentlyContinue | ForEach-Object {
    Act $_.FullName { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Continue }
  }
}

Say "`nDone. $(if ($Apply) { 'Deleted.' } else { 'Dry run only - re-run with -Apply to delete.' })"
