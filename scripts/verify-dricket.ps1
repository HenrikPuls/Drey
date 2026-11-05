# Part A of docs/design/dricket/cutover-guide.md in ONE command: a scratch
# dricket store with seeded tickets plus an ISOLATED Drey instance on it.
#
#   .\scripts\verify-dricket.ps1            prepare (first run) and start the app
#   .\scripts\verify-dricket.ps1 -Remote    the store is a bare repo + a separate clone
#   .\scripts\verify-dricket.ps1 -Reset     stop everything and delete what this script created
#
# What it touches -- and what never: it creates two folders, the scratch store
# (default E:\dkv) and an isolated profile (default E:\dkv-profile). The app is
# started with USERPROFILE / HOME / APPDATA / LOCALAPPDATA and --user-data-dir
# all pointing into the profile, so the real ~/.drey-engine, the real userData
# (settings, plugin config) and the real drey-tickets vault are neither read nor
# written. A fingerprint of the real locations is taken before the start and
# compared at -Reset; -Fingerprint prints it any time. Folders are only ever
# deleted when they carry this script's marker file.
#
# Needs: dk (v0.6.2+) on PATH or -DkPath, git, and this checkout's toolchain
# (bootstrapped like dev.ps1: .tools junction, npm ci).

param(
    [string]$Store = 'E:\dkv',
    [string]$Profile = 'E:\dkv-profile',
    [switch]$Remote,
    [switch]$Reset,
    [switch]$SkipBuild,
    [switch]$NoLaunch,
    [switch]$Fingerprint,
    [string]$DkPath = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$magic = 'drey-verify-dricket v1'

# ---------------------------------------------------------------- real data

# Read-only fingerprint of every place a real Drey would keep state this
# script must leave alone. Taken with the REAL environment (before any override).
function Get-RealFingerprint {
    $realHome = [Environment]::GetFolderPath('UserProfile')
    $realUserData = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'drey'
    $files = New-Object System.Collections.Generic.List[string]
    $engine = Join-Path $realHome '.drey-engine'
    if (Test-Path -LiteralPath $engine) {
        Get-ChildItem -LiteralPath $engine -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object { $files.Add($_.FullName) }
    }
    foreach ($rel in @('app-config.json', 'vault-config.json')) {
        $p = Join-Path $realUserData $rel
        if (Test-Path -LiteralPath $p) { $files.Add($p) }
    }
    $plugins = Join-Path $realUserData 'plugins'
    if (Test-Path -LiteralPath $plugins) {
        Get-ChildItem -LiteralPath $plugins -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object { $files.Add($_.FullName) }
    }
    $lines = foreach ($f in ($files | Sort-Object)) {
        $i = Get-Item -LiteralPath $f -Force
        $hash = ''
        if ($i.Length -lt 2MB) { $hash = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.Substring(0, 12) }
        '{0}|{1}|{2}|{3}' -f $f, $i.Length, $i.LastWriteTimeUtc.ToString('o'), $hash
    }
    return @($lines)
}

if ($Fingerprint) {
    Get-RealFingerprint
    return
}

# --------------------------------------------------------------- path guards

function Assert-SafePath([string]$Path, [string]$What) {
    if (-not [IO.Path]::IsPathRooted($Path)) { throw "$What must be an absolute path: $Path" }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($full.Length -gt 150) { throw "$What is too long ($($full.Length) chars, limit 150): $full" }
    $oneDrive = @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial) | Where-Object { $_ }
    $inOneDrive = $full -match '(?i)[\\/]OneDrive' -or ($oneDrive | Where-Object { $full.StartsWith($_.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) })
    if ($inOneDrive) { throw "$What must not be inside OneDrive: $full" }
    if ($full.Length -le 3) { throw "$What must not be a drive root: $full" }
    return $full
}

$Store = Assert-SafePath $Store 'Store'
$Profile = Assert-SafePath $Profile 'Profile'
if ($Store -eq $Profile -or $Profile.StartsWith($Store + '\', [StringComparison]::OrdinalIgnoreCase) -or $Store.StartsWith($Profile + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Store and Profile must be separate folders (neither inside the other).'
}

# Local store: the repo is $Store itself (marker inside .git so the checkout
# stays clean). Remote: $Store is a plain folder holding remote.git + checkout.
$profileMarker = Join-Path $Profile '.drey-verify-marker'
$storeMarker = if ($Remote) { Join-Path $Store '.drey-verify-marker' } else { Join-Path $Store '.git\drey-verify-marker' }

function Test-Marker([string]$Path) {
    return (Test-Path -LiteralPath $Path) -and ((Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue) -match [regex]::Escape($magic))
}

function Stop-ProfileProcesses {
    # The app (pid recorded at launch) and the engine daemon it spawned (pid in the profile's engine.lock).
    $pids = New-Object System.Collections.Generic.List[int]
    try {
        $m = Get-Content -LiteralPath $profileMarker -Raw | ConvertFrom-Json
        if ($m.appPid) { $pids.Add([int]$m.appPid) }
    } catch { }
    $lock = Join-Path $Profile 'home\.drey-engine\engine.lock'
    if (Test-Path -LiteralPath $lock) {
        try { $l = Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json; if ($l.pid) { $pids.Add([int]$l.pid) } } catch { }
    }
    # Anything else still running from inside the profile (electron children).
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Profile) } |
        ForEach-Object { $pids.Add([int]$_.ProcessId) }
    foreach ($p in ($pids | Select-Object -Unique)) {
        if ($p -ne $PID) { & taskkill.exe /PID $p /T /F 2>&1 | Out-Null }
    }
    Start-Sleep -Milliseconds 800
}

# --------------------------------------------------------------------- reset

if ($Reset) {
    Write-Output "Reset: store $Store, profile $Profile"
    $profileOk = Test-Marker $profileMarker
    if ($profileOk) {
        try { if ((Get-Content -LiteralPath $profileMarker -Raw | ConvertFrom-Json).remote) { $storeMarker = Join-Path $Store '.drey-verify-marker' } else { $storeMarker = Join-Path $Store '.git\drey-verify-marker' } } catch { }
        Stop-ProfileProcesses
    }
    foreach ($item in @(@{ Path = $Store; Marker = $storeMarker }, @{ Path = $Profile; Marker = $profileMarker })) {
        if (-not (Test-Path -LiteralPath $item.Path)) { Write-Output "  absent, nothing to do: $($item.Path)"; continue }
        if (-not (Test-Marker $item.Marker)) { Write-Warning "  NOT deleted, no marker from this script: $($item.Path)"; continue }
        Remove-Item -LiteralPath $item.Path -Recurse -Force
        Write-Output "  deleted: $($item.Path)"
    }
    $beforeFile = Join-Path $env:TEMP 'drey-verify-dricket-real-before.txt'
    if (Test-Path -LiteralPath $beforeFile) {
        $before = @(Get-Content -LiteralPath $beforeFile)
        $after = @(Get-RealFingerprint)
        $diff = Compare-Object $before $after
        if ($diff) {
            Write-Warning 'Real-data fingerprint DIFFERS from the one taken at start (a running real Drey writes its own logs too):'
            $diff | ForEach-Object { Write-Output ('  {0} {1}' -f $_.SideIndicator, $_.InputObject) }
        } else {
            Write-Output "  real ~/.drey-engine + real userData fingerprint unchanged ($($after.Count) files compared)."
        }
        Remove-Item -LiteralPath $beforeFile -Force
    }
    return
}

# ------------------------------------------------------------------- prepare

$dk = $DkPath
if ($dk -eq '') {
    $cmd = Get-Command dk -ErrorAction SilentlyContinue
    if (-not $cmd) { throw 'dk not found on PATH -- install dk v0.6.2+ or pass -DkPath.' }
    $dk = $cmd.Source
}
$ver = (& $dk --version) -join ' '
if ($ver -notmatch 'v?(\d+)\.(\d+)\.(\d+)' -or ([int]$Matches[1] -eq 0 -and ([int]$Matches[2] -lt 6 -or ([int]$Matches[2] -eq 6 -and [int]$Matches[3] -lt 2)))) {
    throw "dk v0.6.2 or newer is required, found: $ver"
}

# Toolchain, bootstrapped like dev.ps1 (junction into the source checkout's .tools, npm ci).
if (-not (Test-Path (Join-Path $root '.tools\node\node.exe'))) {
    $source = $null
    foreach ($line in (git -C $root worktree list --porcelain)) {
        if ($line -match '^worktree\s+(.+)$' -and (Test-Path (Join-Path $Matches[1] '.tools\node\node.exe'))) { $source = $Matches[1]; break }
    }
    if (-not $source) { throw 'No checkout with a vendored Node.js (.tools/node) found.' }
    New-Item -ItemType Junction -Path (Join-Path $root '.tools') -Target (Join-Path $source '.tools') | Out-Null
    Write-Output "Bootstrapped .tools as a junction to $source\.tools"
}
$nodeDir = Join-Path $root '.tools\node'
$node = Join-Path $nodeDir 'node.exe'

$prepared = (Test-Marker $profileMarker) -and (Test-Marker $storeMarker)
if (-not $prepared) {
    foreach ($p in @($Store, $Profile)) {
        if ((Test-Path -LiteralPath $p) -and (Get-ChildItem -LiteralPath $p -Force | Select-Object -First 1)) {
            throw "$p exists and is not empty, and is not from this script (no marker). Choose another path, or empty it yourself."
        }
    }
}

$home_ = Join-Path $Profile 'home'
$userData = Join-Path $Profile 'userData'
$vault = Join-Path $Profile 'vault'
$dkData = Join-Path $Profile 'dkdata'
$dkDataUi = Join-Path $Profile 'dkdata-app'
$storeDir = $Store           # where the checkout lives
$dkStore = $Store            # what dk.store points at
if ($Remote) {
    $bare = Join-Path $Store 'remote.git'
    $storeDir = Join-Path $Store 'checkout'
    $dkStore = "$bare#tickets"
}

# One identity for everything this script and the isolated app run.
$identity = @{
    DK_OWNER = 'henrik'
    GIT_AUTHOR_NAME = 'Drey-Verify'; GIT_AUTHOR_EMAIL = 'verify@drey.invalid'
    GIT_COMMITTER_NAME = 'Drey-Verify'; GIT_COMMITTER_EMAIL = 'verify@drey.invalid'
}

# A null value REMOVES the variable ([Environment]::SetEnvironmentVariable($k, $null) leaves an
# empty one behind in PowerShell, and an empty GIT_AUTHOR_NAME breaks git).
function Set-EnvVar([string]$Name, $Value) {
    if ($null -eq $Value -or $Value -eq '') { Remove-Item -LiteralPath "Env:\$Name" -ErrorAction SilentlyContinue }
    else { Set-Item -LiteralPath "Env:\$Name" -Value $Value }
}

function Invoke-Dk {
    param([string]$Owner, [string[]]$Arguments, [string]$Where)
    $saved = @{}
    $vars = @{ DK_OWNER = $Owner; DK_STORE = $Where; DK_DATA_DIR = $dkData; USERPROFILE = $home_; HOME = $home_ }
    foreach ($k in $identity.Keys) { if ($k -ne 'DK_OWNER') { $vars[$k] = $identity[$k] } }
    foreach ($k in $vars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); Set-EnvVar $k $vars[$k] }
    try {
        Push-Location (Get-Location)
        $out = & $dk @Arguments 2>&1
        if ($LASTEXITCODE -ne 0) { throw "dk $($Arguments -join ' ') failed ($LASTEXITCODE): $out" }
        return $out
    } finally {
        Pop-Location
        foreach ($k in $vars.Keys) { Set-EnvVar $k $saved[$k] }
    }
}
function Invoke-Git([string]$Dir, [string[]]$Arguments) {
    $out = & git -C $Dir -c core.autocrlf=false -c user.name=Drey-Verify -c user.email=verify@drey.invalid @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed: $out" }
    return $out
}

$PIPELINE = @'
---
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: prioritized, title: Prioritized, handover: manual }
  - { id: build, title: Build, handover: agent build-default }
  - { id: commit, title: Commit, handover: manual }
  - { id: done, title: Done, handover: none }
---
The phases.
'@
$REPOS = @'
---
repos:
  scratch:
    url: https://example.invalid/scratch.git
    branch: main
---
'@
$STAGES = @'

[stages]
values = ["inbox", "prioritized", "build", "commit", "done"]
initial = "inbox"
terminal = ["done"]
claim = ["build", "commit"]
cancelled = "cancelled"
'@

function New-Seed([string]$Dir) {
    # A local dricket store with Drey's five stages, prefix t (ids t-1 ...).
    $dkOut = Invoke-Dk -Owner 'henrik' -Arguments @('init', $Dir, 't') -Where $Dir
    if (-not $Remote) { [IO.File]::WriteAllText($storeMarker, $magic) }
    Invoke-Git $Dir @('config', 'core.autocrlf', 'false') | Out-Null
    Invoke-Git $Dir @('checkout', '-q', 'main') | Out-Null
    $toml = Join-Path $Dir 'dricket.toml'
    [IO.File]::AppendAllText($toml, ($STAGES -replace "`r`n", "`n"))
    Invoke-Git $Dir @('commit', '-q', '-am', 'scratch store stages') | Out-Null
    Invoke-Git $Dir @('checkout', '-q', 'tickets') | Out-Null

    $add = { param($title, $extra) Invoke-Dk -Owner 'henrik' -Where $Dir -Arguments (@('add', '--unclaimed', '-m', $title) + $extra) | Out-Null }
    & $add 'Export the vault as a zip' @('-d', 'Zip the whole vault, attachments included.')
    & $add 'Spellcheck for daily notes' @('--priority', 'high')
    & $add 'Pin tabs to the left' @('--depends', 't-2')
    & $add 'Fix the tag colour in the dark theme' @()
    & $add 'Release notes for the next version' @('-l', 'docs')
    & $add 'Rename a folder without losing links' @()
    Invoke-Dk -Owner 'henrik' -Where $Dir -Arguments @('comment', 't-1', '-m', 'Decision needed: zip everything, or only the open notes?') | Out-Null

    # Stage moves: claim (inbox -> build), release to the wanted stage.
    $move = { param($id, $stage)
        Invoke-Dk -Owner 'seed-agent@scratch' -Where $Dir -Arguments @('claim', $id, '--size', 'S', '--kind', 'human') | Out-Null
        Invoke-Dk -Owner 'seed-agent@scratch' -Where $Dir -Arguments @('release', $id, '--stage', $stage, '-m', "Seeded into $stage.") | Out-Null }
    & $move 't-2' 'prioritized'
    & $move 't-3' 'prioritized'
    & $move 't-5' 'commit'
    & $move 't-6' 'done'

    # t-4: build, claimed by a foreign runner whose lease ended hours ago. dk has no clock
    # override, so the claim is committed by hand with back-dated fields (dk validate accepts it).
    $ticket = Join-Path $Dir 'tickets\t\0000\t-4\ticket.md'
    if (-not (Test-Path -LiteralPath $ticket)) { throw "seed: $ticket not found (dk layout changed?)" }
    $text = [IO.File]::ReadAllText($ticket)
    $text = $text -replace '(?m)^stage:.*$', 'stage: build'
    $text = $text -replace '(?m)^owner:.*$', 'owner: agent-r-9@scratch'
    $claimed = [DateTime]::UtcNow.AddHours(-6).ToString('yyyy-MM-ddTHH:mm:ssZ')
    $lease = [DateTime]::UtcNow.AddHours(-4).ToString('yyyy-MM-ddTHH:mm:ssZ')
    $text = $text -replace '(?m)^claimed_at:.*$', "claimed_at: $claimed"
    $text = $text -replace '(?m)^lease_until:.*$', "lease_until: $lease"
    $text = $text -replace '(?m)^epoch: (\d+)$', { 'epoch: ' + ([int]$_.Groups[1].Value + 1) }
    $text = $text -replace '(?m)^rev: (\d+)$', { 'rev: ' + ([int]$_.Groups[1].Value + 1) }
    [IO.File]::WriteAllText($ticket, $text)
    $env:GIT_AUTHOR_DATE = $claimed; $env:GIT_COMMITTER_DATE = $claimed
    try {
        Invoke-Git $Dir @('add', '-A') | Out-Null
        Invoke-Git $Dir @('commit', '-q', '-m', 'dricket: claim t-4') | Out-Null
    } finally {
        Remove-Item Env:\GIT_AUTHOR_DATE, Env:\GIT_COMMITTER_DATE -ErrorAction SilentlyContinue
    }
    $v = (Invoke-Dk -Owner 'henrik' -Where $Dir -Arguments @('validate') | Out-String).Trim()
    Write-Output "  seeded 6 tickets; dk validate: $v"
}

if (-not $prepared) {
    Write-Output "Preparing scratch store ($(if ($Remote) { 'remote' } else { 'local' })) and isolated profile ..."
    New-Item -ItemType Directory -Force -Path $Profile, $Store | Out-Null
    if ($Remote) { [IO.File]::WriteAllText($storeMarker, $magic) }
    foreach ($d in @($home_, $userData, $vault, $dkData, $dkDataUi, (Join-Path $home_ 'AppData\Roaming'), (Join-Path $home_ 'AppData\Local'), (Join-Path $userData 'plugins\tickets'))) {
        New-Item -ItemType Directory -Force -Path $d | Out-Null
    }
    # Marker first, so a half-finished prepare can still be reset.
    $markerBody = @{ magic = $magic; store = $Store; profile = $Profile; remote = [bool]$Remote; created = (Get-Date).ToString('o'); appPid = $null } | ConvertTo-Json
    [IO.File]::WriteAllText($profileMarker, $markerBody)

    if ($Remote) {
        $seedDir = Join-Path $Store 'seed'
        New-Seed $seedDir
        & git clone -q --bare $seedDir $bare 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'git clone --bare failed' }
        Remove-Item -LiteralPath $seedDir -Recurse -Force
        & git -c core.autocrlf=false clone -q -b tickets $bare $storeDir 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'git clone of the bare repo failed' }
        Invoke-Git $storeDir @('config', 'core.autocrlf', 'false') | Out-Null
        [IO.File]::WriteAllText($storeMarker, $magic)
        $v = (Invoke-Dk -Owner 'henrik' -Where $dkStore -Arguments @('ls') | Out-String).Trim()
        Write-Output "  remote store readable through dk ($dkStore):"
        Write-Output ($v -split "`n" | ForEach-Object { "    $_" })
    } else {
        New-Seed $Store
        [IO.File]::WriteAllText($storeMarker, $magic)
    }

    # The engine/board still wants a tickets vault (tickets/_meta/pipeline.md) to host.
    $meta = Join-Path $vault 'tickets\_meta'
    New-Item -ItemType Directory -Force -Path $meta | Out-Null
    [IO.File]::WriteAllText((Join-Path $meta 'pipeline.md'), ($PIPELINE -replace "`r`n", "`n") + "`n")
    [IO.File]::WriteAllText((Join-Path $meta 'repos.md'), ($REPOS -replace "`r`n", "`n") + "`n")
    [IO.File]::WriteAllText((Join-Path $userData 'vault-config.json'), (@{ activeVaultPath = $vault } | ConvertTo-Json))
    [IO.File]::WriteAllText((Join-Path $userData 'app-config.json'), (@{ plugins = @{ disabled = @('sample') } } | ConvertTo-Json -Depth 5))

    $cfg = [ordered]@{ backend = 'dricket'; 'dk.store' = $dkStore; 'dk.dataDir' = $dkDataUi }
    if ($Remote) { $cfg['dk.checkout'] = $storeDir; $cfg['dk.syncSeconds'] = 30 } else { $cfg['dk.syncSeconds'] = 0 }
    if ($DkPath -ne '') { $cfg['dk.path'] = $DkPath }
    [IO.File]::WriteAllText((Join-Path $userData 'plugins\tickets\config.json'), ($cfg | ConvertTo-Json))

    $lines = @(
        '# Dot-source in a terminal next to the isolated Drey: . ' + (Join-Path $Profile 'dk-env.ps1'),
        "`$env:DK_STORE = '$dkStore'",
        "`$env:DK_DATA_DIR = '$dkData'",
        "`$env:DK_OWNER = 'terminal@scratch'",
        "`$env:GIT_AUTHOR_NAME = 'Drey-Verify'; `$env:GIT_AUTHOR_EMAIL = 'verify@drey.invalid'",
        "`$env:GIT_COMMITTER_NAME = 'Drey-Verify'; `$env:GIT_COMMITTER_EMAIL = 'verify@drey.invalid'",
        "Set-Location '$storeDir'"
    )
    [IO.File]::WriteAllText((Join-Path $Profile 'dk-env.ps1'), ($lines -join "`r`n") + "`r`n")
    Write-Output '  profile ready.'
} else {
    Write-Output "Scratch store and profile already prepared (use -Reset to start over)."
}

# ----------------------------------------------------------------- build/launch

if ($NoLaunch) { Write-Output 'NoLaunch: prepared only.'; return }

if (Test-Marker $profileMarker) {
    $m = Get-Content -LiteralPath $profileMarker -Raw | ConvertFrom-Json
    if ($m.appPid -and (Get-Process -Id ([int]$m.appPid) -ErrorAction SilentlyContinue)) {
        throw "The isolated app already runs (pid $($m.appPid)). Close it first, or use -Reset."
    }
}

$env:Path = "$nodeDir;$env:Path"
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
    Write-Output 'node_modules missing -- running npm ci (this takes a moment)...'
    Push-Location $root
    try { & (Join-Path $nodeDir 'npm.cmd') ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' } } finally { Pop-Location }
}
if (-not $SkipBuild) {
    Write-Output 'Building (npm run build; use -SkipBuild to reuse dist/) ...'
    Push-Location $root
    try { & (Join-Path $nodeDir 'npm.cmd') run build; if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' } } finally { Pop-Location }
}
if (-not (Test-Path (Join-Path $root 'dist-electron\electron\main.js'))) { throw 'No build found (dist-electron). Run without -SkipBuild.' }

# Fingerprint of the real locations BEFORE the isolated app starts.
$beforeFile = Join-Path $env:TEMP 'drey-verify-dricket-real-before.txt'
if (-not (Test-Path -LiteralPath $beforeFile)) {
    Get-RealFingerprint | Set-Content -LiteralPath $beforeFile
}
Write-Output "Real-data fingerprint taken ($((Get-Content -LiteralPath $beforeFile | Measure-Object).Count) files) -> compared at -Reset."

# Everything the app resolves a path from points into the profile.
$overrides = @{
    USERPROFILE = $home_; HOME = $home_
    APPDATA = (Join-Path $home_ 'AppData\Roaming'); LOCALAPPDATA = (Join-Path $home_ 'AppData\Local')
    DREY_MULTI_INSTANCE = '1'; DREY_RENDERER_URL = $null; ELECTRON_RUN_AS_NODE = $null
    DK_DATA_DIR = $dkDataUi; DK_STORE = $null
}
foreach ($k in $identity.Keys) { $overrides[$k] = $identity[$k] }
$saved = @{}
foreach ($k in $overrides.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }
try {
    foreach ($k in $overrides.Keys) { Set-EnvVar $k $overrides[$k] }
    $log = Join-Path $Profile 'app.log'
    $proc = Start-Process -FilePath $node -ArgumentList @((Join-Path $root 'scripts\run-electron.js'), "--user-data-dir=$userData") `
        -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError ($log + '.err')
} finally {
    foreach ($k in $overrides.Keys) { Set-EnvVar $k $saved[$k] }
}
$m = Get-Content -LiteralPath $profileMarker -Raw | ConvertFrom-Json
$m.appPid = $proc.Id
[IO.File]::WriteAllText($profileMarker, ($m | ConvertTo-Json))
Write-Output "Isolated Drey started (launcher pid $($proc.Id)), log: $log"

# ----------------------------------------------------------------- checklist

@"

=== Part A checklist (scratch store: $dkStore) ===
In a SECOND terminal:   . '$Profile\dk-env.ps1'    (sets DK_STORE, DK_OWNER, ... for dk and git)

 1. Open the Tickets panel (dock icon "Show Tickets"): the board shows t-1 .. t-5
    (t-6 is done); t-3 is blocked by t-2; t-4 sits in Build with an expired foreign claim;
    t-1 has a comment ("Decision needed").
 2. Live change detection:   dk add --unclaimed -m "From the terminal"
    -> a new card within ~1-2 s, no refresh.   (git -C '$storeDir' log --oneline)
 3. Board moves: capture a ticket, change a priority, move a stage, accept / send back.
    Each is one "dricket: put ..." commit in the log above.
 4. Open a ticket document in the editor, edit, Ctrl+S -> a put commit. Edit the same
    ticket from the terminal in between -> the save-conflict merge view opens.
 5. Comments:   dk comment t-2 -m "x"   -> shows in the ticket's thread. A Needs-you
    decision resolves via a comment (there is no answer button yet).
 6. Fleet: only on a throw-away ticket with a worker configured (none is set in this
    profile). Watch claim / extend / release with   dk show t-N ; dk leases
    Kill the runner (Task Manager) and restart (this script again): the leftover claim
    is released at start. A foreign dead claim (t-4) is taken over only after lease end
    plus dk's fixed 20-minute grace.
 7. Source control panel marks the checkout "Managed by Tickets".
$(if ($Remote) { @"
 8. Remote: the checkout syncs every 30 s. Write from another clone to prove it:
    git -c core.autocrlf=false clone -q -b tickets '$bare' '$Store\other'; cd '$Store\other'; then a dk add with
    DK_STORE='$dkStore'  (dk pushes)  -> the board follows after the next sync.
"@ })

Anything wrong -> note it as a requirement (specs/roadmap.md), do not fix by hand-editing the store.
When done:   .\scripts\verify-dricket.ps1 -Reset$(if ($Remote) { ' -Remote' })   (stops the app + engine, deletes only what this script created)
"@
