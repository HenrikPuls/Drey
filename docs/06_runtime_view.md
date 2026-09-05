# 6. Runtime View

Sequence diagrams get added here one at a time, as each flow actually
lands — not speculatively up front.

## 6.1 Vault selection + file listing (milestone 2)

Two related flows: picking a vault, and loading (or reloading) its file
tree. Both go through the same `VaultService` → `contextBridge` →
`VaultManager` path described in
[05_building_block_view.md](05_building_block_view.md).

```mermaid
sequenceDiagram
    actor User
    participant Sidebar
    participant VaultService
    participant Preload as preload (cyberNotesApi)
    participant Main as main (ipcMain)
    participant VaultManager
    participant FS as Filesystem

    Note over VaultService: On app start
    VaultService->>Preload: getActiveVault()
    Preload->>Main: invoke('vault:get-active')
    Main->>VaultManager: getActiveVaultPath()
    VaultManager-->>Main: path | null (from in-memory state,\nseeded from vault-config.json at startup)
    Main-->>Preload: path | null
    Preload-->>VaultService: path | null
    alt a vault was already active
        VaultService->>Preload: listVaultFiles()
        Preload->>Main: invoke('vault:list-files')
        Main->>VaultManager: listFiles()
        VaultManager->>FS: readdir (recursive)
        FS-->>VaultManager: entries
        VaultManager-->>Main: VaultFileEntry[]
        Main-->>Preload: VaultFileEntry[]
        Preload-->>VaultService: VaultFileEntry[]
        VaultService->>Sidebar: fileTree signal updates
    end

    User->>Sidebar: click "Select vault folder..."
    Sidebar->>VaultService: selectVault()
    VaultService->>Preload: selectVault()
    Preload->>Main: invoke('vault:select')
    Main->>VaultManager: selectVault()
    VaultManager->>User: native folder picker dialog
    User-->>VaultManager: folder chosen (or cancelled)
    alt folder chosen
        VaultManager->>FS: write vault-config.json
        VaultManager-->>Main: new active path
    else cancelled
        VaultManager-->>Main: previous active path (unchanged)
    end
    Main-->>Preload: path
    Preload-->>VaultService: path
    VaultService->>Preload: listVaultFiles()
    Note over VaultService,FS: same listing sequence as above
    VaultService->>Sidebar: activeVaultPath + fileTree signals update
```

Deliberately out of scope for this milestone: reacting to *external*
changes to the vault folder while the app is running (chokidar file
watching, frontmatter-change vs. body-change vs. untracked-new-file
detection per CLAUDE.md's `FileWatcher` component). This flow is a
one-shot read, re-triggered manually by picking a vault or restarting the
app. Live watching becomes necessary once there's editor autosave to
conflict with it — deferred to whichever milestone builds that (see
[11_risks_and_technical_debt.md](11_risks_and_technical_debt.md),
"Autosave-vs-watcher conflict").

## Planned flows (added as their milestone is built)

- Quick-capture → routing (milestone 4–5)
- Batch tag suggestion (milestone 7)
- File-watcher reaction (frontmatter-change / body-change / untracked-new-file) (deferred, see above)
- Chat/RAG scope resolution (milestone 9+ / Phase 2 for "all notes" scope)
