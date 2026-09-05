# 8. Crosscutting Concepts

*(Placeholder — filled in as concrete cross-cutting decisions get made,
e.g. error handling/logging conventions, the IPC message/type conventions,
autosave-vs-watcher conflict handling. Tracked as an open risk in
[11_risks_and_technical_debt.md](11_risks_and_technical_debt.md) until
resolved.)*

## IPC typing convention (established in milestone 1)

Every data shape crossing the `contextBridge` boundary is defined once as
a TypeScript interface in a shared module (`shared/`), imported by both
the main process (implementation) and the renderer (consumer) — no
untyped `any` payloads across IPC. See
[05_building_block_view.md](05_building_block_view.md).
