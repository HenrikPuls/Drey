# 66. Office documents open in their own program

## Status

Accepted (milestone 66, the remainder of Req-2). Builds on ADR-0052 (the
PDF slice of Req-2) and ADR-0024 / milestone 31 (dropped files are staged
into `attachments/`). Narrows the "a note can never open a `file:`
target" guard of the `openExternal` handler by one exception.

## Context

Req-2 asked for Office documents (Word, Excel, PowerPoint, Loop) rendered
inline. The PDF slice shipped as milestone 30 because Chromium renders
PDF itself; it renders none of the Office formats.

The state before this decision: an Office file dropped into a note was
already staged into `attachments/` and linked (milestone 31). But
clicking that link, or the file in the Files panel, ran the base text
routing — a mojibake text buffer whose Ctrl+S would have written the
garbage back.

The options discussed with the owner:

- **JS renderers in a plugin** (`docx-preview`, SheetJS). Offline and
  install-free, but read-only, several MB of bundle, a plain grid for
  Excel, and no usable PowerPoint renderer.
- **Convert to PDF** with an installed Office or LibreOffice and show the
  result in the PDF viewer. Best fidelity, but it depends on that
  install, takes seconds per open and needs a cache of converted files.
- **Office for the web in a frame.** A cloud call, a sign-in and files
  that must live on OneDrive / SharePoint.
- **Open the file in its own program.**

## Decision

**Drey does not render Office documents. It opens them in the program
the OS associates with them** — the owner's choice: the real program
edits as well as shows, and it is already installed where such files
exist.

**1 · An allowlist of document types** (`shared/external-document.ts`,
`externalDocumentExtension`): Word, Excel and PowerPoint in their binary,
XML, macro and template forms, the OpenDocument trio, RTF, Visio,
Project, Publisher, OneNote, Loop, and `.msg` / `.eml`. An allowlist
rather than "everything that is not text": a link in a note — which an
MCP client, the assistant or a synced vault may have written — must
never be able to launch an executable, a script or a shortcut.

**2 · A vault file on the list opens externally, never as a tab.**
`EditorService.openFile` asks the plugin file openers first, then this
rule, then image / PDF / text. Every caller is covered by that one
place: the Files panel, a Ctrl-click on a note link, the quick switcher,
a file dropped on a pane. No tab opens and no clean tab is replaced.
Main resolves the path inside the vault and calls `shell.openPath`
(`vault:open-externally` → `VaultManager.openExternally` →
`electron/open-document.ts`), checking the allowlist again — the
renderer's check is routing, main's is the guard.

**3 · A document can be linked where it lives.** A note link may be a
`file:` URL: `[Report.docx](file:///C:/Docs/Report.docx)`. Ctrl-click
sends it to `app:open-local-document`; main opens it only when it is a
path on this machine (no host part, no UNC path — a note must not make
the machine contact a foreign server), on the allowlist, and present.
This is the one exception to the rule that the editor's link click
reaches `http(s):` and `mailto:` only.

**4 · Two ways to drop.** A plain drop of an Office file keeps the
milestone-31 behaviour: copied into the note's `attachments/` under its
own name, a link inserted. An **Alt-drop** copies nothing and inserts
the `file:` link to the original (the Explorer convention for "create a
link"); the path comes from Electron's `webUtils.getPathForFile`,
exposed as `pathForFile` on the bridge. An Alt-drop that carries anything
but local documents falls back to the normal cascade. A vault document
dragged from the Files panel onto a note is linked in place, relative,
no copy.

**5 · Base, not a plugin.** The roadmap named the milestone-64
file-opener seam as the way in. With rendering dropped there is no doc
kind to contribute, and the remaining pieces — the drop cascade, the
link click, the `shell` call behind an allowlist — are base. A plugin
would have needed a new SDK method that hands arbitrary files to the OS.

## Consequences

- An Office file in the vault behaves like a file in Explorer: click,
  and Word / Excel / PowerPoint opens. Drey shows nothing of its
  content, searches nothing in it and gives the assistant nothing of it.
- Loop is covered only as far as the OS has a program for `.loop`
  files; Drey does nothing Loop-specific.
- `.msg` in the vault now opens in the mail program instead of as
  unreadable text. Dropping an invite on a note is unchanged (the
  meeting decoder claims it first).
- A `file:` link is machine-specific: it breaks when the file moves and
  on any other machine, and link update on rename (ADR-0059) does not
  touch it. The copy into `attachments/` stays the default for that
  reason.
- No inline embed: `![](x.docx)` is not supported; an Office document
  is always a plain link.
- Rendering stays possible later as a plugin on the file-opener seam; a
  plugin opener is asked before the allowlist rule and would win.
- The allowlist is code, not a setting. Other binary types (archives,
  media) keep their previous behaviour.
