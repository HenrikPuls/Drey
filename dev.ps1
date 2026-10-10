# One-command dev launcher: bootstraps this checkout's toolchain and
# dependencies, then starts the app -- by default the dev mode (the
# Angular dev server on port 4200 plus the Electron main process, with
# hot reload and DevTools), with `-Built` a production build that runs
# from `dist/` like a packaged app: no dev server, no port, no DevTools.
# `-Built` always rebuilds first, so a stale build is never launched.
#
# `-Multi` (combinable) opts this instance out of the single-instance
# lock (DREY_MULTI_INSTANCE=1): parallel checkouts can run side by side
# for checking several agent outputs at once. They share one userData /
# one set of settings; the first instance keeps the quick-capture hotkey.
#
# Usage (from this checkout's root, or any subfolder):
#   .\dev.ps1                  dev server + Electron (hot reload, DevTools)
#   .\dev.ps1 -Built           npm run build, then the packaged-style app
#   .\dev.ps1 -Built -Multi    ...as a parallel instance (see above)
#
# Bootstrap rules (mirrors env.ps1's "no global tooling" contract):
# - `.tools/node` is gitignored and vendored only in the source
#   checkout. In a linked git worktree this script creates `.tools` as a
#   directory junction into the source checkout's copy -- junctions
#   need no admin rights, and deleting the worktree removes just the
#   link, never the toolchain itself.
# - `node_modules` is installed with `npm ci` when missing.

param(
    [switch]$Built,
    [switch]$Multi
)

$root = $PSScriptRoot

if (-not (Test-Path (Join-Path $root ".tools\node\node.exe"))) {
    if (Test-Path (Join-Path $root ".tools")) {
        Write-Error ".tools exists but contains no node.exe -- fix or remove it, then re-run."
        return
    }

    # The source checkout is whichever listed worktree carries the
    # vendored toolchain (this one just proved it does not).
    $source = $null
    foreach ($line in (git worktree list --porcelain)) {
        if ($line -match '^worktree\s+(.+)$') {
            $candidate = $Matches[1]
            if (Test-Path (Join-Path $candidate ".tools\node\node.exe")) {
                $source = $candidate
                break
            }
        }
    }
    if (-not $source) {
        Write-Error "No checkout with a vendored Node.js (.tools/node) found -- run the setup step in the source checkout first (see env.ps1)."
        return
    }

    New-Item -ItemType Junction -Path (Join-Path $root ".tools") -Target (Join-Path $source ".tools") | Out-Null
    Write-Output "Bootstrapped .tools as a junction to $source\.tools"
}

. (Join-Path $root "env.ps1")

if (-not (Test-Path (Join-Path $root "node_modules"))) {
    Write-Output "node_modules missing -- running npm ci (this takes a moment)..."
    Push-Location $root
    try {
        & (Join-Path $root ".tools\node\npm.cmd") ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            Write-Error "npm ci failed."
            return
        }
    } finally {
        Pop-Location
    }
}

if ($Multi) {
    # Passed down to Electron through npm; see electron/main.ts's
    # single-instance lock.
    $env:DREY_MULTI_INSTANCE = '1'
}

Push-Location $root
try {
    if ($Built) {
        & (Join-Path $root ".tools\node\npm.cmd") run app
    } else {
        & (Join-Path $root ".tools\node\npm.cmd") run dev
    }
} finally {
    Pop-Location
}
