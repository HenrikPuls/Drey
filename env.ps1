# Puts this project's local, portable Node.js runtime on PATH for the
# current PowerShell session only -- never touches the system-wide PATH
# or the Windows registry.
#
# Usage (each new terminal session, from the repo root):
#   . .\env.ps1
#
# Why: CLAUDE.md/roadmap call for no assumed global tooling; Node.js is
# vendored under .tools/node/ (gitignored, see .gitignore) instead of a
# machine-wide install, so the project's toolchain stays fully removable
# by deleting .tools/.

$nodeDir = Join-Path $PSScriptRoot ".tools\node"

if (-not (Test-Path (Join-Path $nodeDir "node.exe"))) {
    Write-Error "Local Node.js not found at $nodeDir -- did you run the setup step?"
    return
}

if ($env:Path -notlike "*$nodeDir*") {
    $env:Path = "$nodeDir;$env:Path"
}

Write-Output "Local Node.js on PATH for this session: $(node --version) (npm $(npm --version))"
