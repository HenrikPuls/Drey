import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * The prototype draws every glyph as a hand-rolled inline SVG. Rather than
 * pull in `lucide-angular` (its 1.x line pins `@angular/core` to 13-21,
 * this project is on 22) or an icon font, the handful of icons the UI
 * actually needs are vendored here as [Lucide](https://lucide.dev) path
 * data on a 24x24 grid. `lucide-static` can later replace this map without
 * touching a single call site -- everything goes through `<app-icon>`.
 *
 * Shapes are described declaratively (no `innerHTML` / sanitizer bypass):
 * each icon is a list of path / circle primitives rendered with a
 * `currentColor` stroke, so colour and size come from CSS / the `size`
 * input.
 */
type IconShape =
  | { readonly kind: 'path'; readonly d: string }
  | { readonly kind: 'circle'; readonly cx: number; readonly cy: number; readonly r: number };

export type IconName =
  | 'chevron-right'
  | 'chevron-left'
  | 'chevron-down'
  | 'chevrons-down-up'
  | 'settings'
  | 'window'
  | 'x'
  | 'check'
  | 'plus'
  | 'arrow-up'
  | 'arrow-down'
  | 'git-branch'
  | 'arrow-left'
  | 'arrow-right'
  | 'sparkles'
  | 'message-circle'
  | 'more-horizontal'
  | 'copy'
  | 'corner-down-left'
  | 'rotate-ccw'
  | 'refresh-cw'
  | 'folder'
  | 'list-ordered'
  | 'grip-vertical'
  | 'minus'
  | 'pencil'
  | 'globe'
  | 'square'
  | 'save'
  | 'pin'
  | 'calendar-check'
  | 'search'
  | 'file-text'
  | 'layers'
  | 'replace'
  | 'download'
  | 'filter'
  | 'check-square'
  | 'circle-check'
  | 'hash'
  | 'paperclip'
  | 'pencil-line'
  | 'database'
  | 'book-open'
  | 'heading'
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'list'
  | 'quote'
  | 'link'
  | 'image'
  | 'table'
  | 'panel-left'
  | 'panel-right'
  | 'code'
  | 'shapes'
  | 'trash'
  | 'git-merge'
  | 'archive'
  | 'history'
  | 'upload'
  | 'triangle-alert'
  | 'brain';

const ICONS: Record<IconName, readonly IconShape[]> = {
  'chevron-right': [{ kind: 'path', d: 'm9 18 6-6-6-6' }],
  'chevron-left': [{ kind: 'path', d: 'm15 18-6-6 6-6' }],
  'chevron-down': [{ kind: 'path', d: 'm6 9 6 6 6-6' }],
  // Lucide "chevrons-down-up" -- the Files panel "collapse all folders" button.
  'chevrons-down-up': [
    { kind: 'path', d: 'm7 20 5-5 5 5' },
    { kind: 'path', d: 'm7 4 5 5 5-5' },
  ],
  settings: [
    {
      kind: 'path',
      d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
    },
    { kind: 'circle', cx: 12, cy: 12, r: 3 },
  ],
  window: [
    { kind: 'path', d: 'M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z' },
    { kind: 'path', d: 'M2 9h20' },
  ],
  x: [
    { kind: 'path', d: 'M18 6 6 18' },
    { kind: 'path', d: 'm6 6 12 12' },
  ],
  check: [{ kind: 'path', d: 'M20 6 9 17l-5-5' }],
  plus: [
    { kind: 'path', d: 'M5 12h14' },
    { kind: 'path', d: 'M12 5v14' },
  ],
  'arrow-up': [
    { kind: 'path', d: 'm5 12 7-7 7 7' },
    { kind: 'path', d: 'M12 19V5' },
  ],
  // Lucide "arrow-down" / "git-branch" -- the Source control panel (pull, branch).
  'arrow-down': [
    { kind: 'path', d: 'M12 5v14' },
    { kind: 'path', d: 'm19 12-7 7-7-7' },
  ],
  'git-branch': [
    { kind: 'path', d: 'M6 3v12' },
    { kind: 'circle', cx: 18, cy: 6, r: 3 },
    { kind: 'circle', cx: 6, cy: 18, r: 3 },
    { kind: 'path', d: 'M18 9a9 9 0 0 1-9 9' },
  ],
  // Lucide "arrow-left" / "arrow-right" -- document-history navigation.
  'arrow-left': [
    { kind: 'path', d: 'm12 19-7-7 7-7' },
    { kind: 'path', d: 'M19 12H5' },
  ],
  'arrow-right': [
    { kind: 'path', d: 'M5 12h14' },
    { kind: 'path', d: 'm12 5 7 7-7 7' },
  ],
  // Lucide "message-circle" -- the Search panel's "Include chats" toggle.
  'message-circle': [{ kind: 'path', d: 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z' }],
  // Lucide "sparkles" -- the assistant / AI affordance.
  sparkles: [
    {
      kind: 'path',
      d: 'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z',
    },
    { kind: 'path', d: 'M20 3v4' },
    { kind: 'path', d: 'M22 5h-4' },
  ],
  'more-horizontal': [
    { kind: 'circle', cx: 12, cy: 12, r: 1 },
    { kind: 'circle', cx: 19, cy: 12, r: 1 },
    { kind: 'circle', cx: 5, cy: 12, r: 1 },
  ],
  // Lucide "copy" -- the card's copy-to-clipboard action. The outer square
  // is Lucide's `<rect>` re-expressed as a rounded-rect path, since this
  // map only renders path / circle primitives.
  copy: [
    {
      kind: 'path',
      d: 'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z',
    },
    { kind: 'path', d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' },
  ],
  // Lucide "corner-down-left" -- "insert this card into the note".
  'corner-down-left': [
    { kind: 'path', d: 'M20 4v7a4 4 0 0 1-4 4H4' },
    { kind: 'path', d: 'm9 10-5 5 5 5' },
  ],
  // Lucide "rotate-ccw" -- "restart chat from here".
  'rotate-ccw': [
    { kind: 'path', d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' },
    { kind: 'path', d: 'M3 3v5h5' },
  ],
  // Lucide "git-merge" -- the Source control panel's merge actions.
  'git-merge': [
    { kind: 'circle', cx: 18, cy: 18, r: 3 },
    { kind: 'circle', cx: 6, cy: 6, r: 3 },
    { kind: 'path', d: 'M6 21V9a9 9 0 0 0 9 9' },
  ],
  // Lucide "archive" -- stash.
  archive: [
    { kind: 'path', d: 'M2 4a1 1 0 0 1 1-1h18a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z' },
    { kind: 'path', d: 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8' },
    { kind: 'path', d: 'M10 12h4' },
  ],
  // Lucide "history" -- the Git history dialog.
  history: [
    { kind: 'path', d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' },
    { kind: 'path', d: 'M3 3v5h5' },
    { kind: 'path', d: 'M12 7v5l4 2' },
  ],
  // Lucide "upload" -- "commit and push".
  upload: [
    { kind: 'path', d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' },
    { kind: 'path', d: 'm17 8-5-5-5 5' },
    { kind: 'path', d: 'M12 3v12' },
  ],
  // Lucide "triangle-alert" -- a merge in progress.
  'triangle-alert': [
    { kind: 'path', d: 'M12 3 2 20h20z' },
    { kind: 'path', d: 'M12 10v4' },
    { kind: 'path', d: 'M12 17.5v.5' },
  ],
  // Lucide "brain" -- the Search panel's semantic mode (SDK 1.18).
  brain: [
    { kind: 'path', d: 'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z' },
    { kind: 'path', d: 'M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z' },
    { kind: 'path', d: 'M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4' },
    { kind: 'path', d: 'M17.599 6.5a3 3 0 0 0 .399-1.375' },
    { kind: 'path', d: 'M6.003 5.125A3 3 0 0 0 6.401 6.5' },
    { kind: 'path', d: 'M3.477 10.896a4 4 0 0 1 .585-.396' },
    { kind: 'path', d: 'M19.938 10.5a4 4 0 0 1 .585.396' },
    { kind: 'path', d: 'M6 18a4 4 0 0 1-1.967-.516' },
    { kind: 'path', d: 'M19.967 17.484A4 4 0 0 1 18 18' },
  ],
  // Lucide "refresh-cw" -- the "re-read the vault" button.
  'refresh-cw': [
    { kind: 'path', d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' },
    { kind: 'path', d: 'M21 3v5h-5' },
    { kind: 'path', d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' },
    { kind: 'path', d: 'M3 21v-5h5' },
  ],
  // Lucide "folder" -- the Files panel's vault switcher row.
  folder: [
    {
      kind: 'path',
      d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
    },
  ],
  // Lucide "list-ordered" -- the meta-bar line-numbers toggle.
  'list-ordered': [
    { kind: 'path', d: 'M10 12h11' },
    { kind: 'path', d: 'M10 18h11' },
    { kind: 'path', d: 'M10 6h11' },
    { kind: 'path', d: 'M4 10h2' },
    { kind: 'path', d: 'M4 6h1v4' },
    { kind: 'path', d: 'M6 18H4c0-1 2-2 2-3s-1-1.5-2-1' },
  ],
  // Lucide "grip-vertical" -- panel-header drag grip.
  'grip-vertical': [
    { kind: 'circle', cx: 9, cy: 12, r: 1 },
    { kind: 'circle', cx: 9, cy: 5, r: 1 },
    { kind: 'circle', cx: 9, cy: 19, r: 1 },
    { kind: 'circle', cx: 15, cy: 12, r: 1 },
    { kind: 'circle', cx: 15, cy: 5, r: 1 },
    { kind: 'circle', cx: 15, cy: 19, r: 1 },
  ],
  // Titlebar minimize.
  minus: [{ kind: 'path', d: 'M5 12h14' }],
  // Rename (matches the Live Preview widgets' edit affordance).
  pencil: [{ kind: 'path', d: 'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z' }],
  // Lucide "globe" -- the browser-tab fallback icon (no favicon yet).
  globe: [
    { kind: 'circle', cx: 12, cy: 12, r: 10 },
    { kind: 'path', d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' },
    { kind: 'path', d: 'M2 12h20' },
  ],
  // Titlebar maximize (an outline square).
  square: [
    {
      kind: 'path',
      d: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
    },
  ],
  // Lucide "save" -- the meta-bar save button (a floppy disk).
  save: [
    {
      kind: 'path',
      d: 'M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
    },
    { kind: 'path', d: 'M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7' },
    { kind: 'path', d: 'M7 3v4a1 1 0 0 0 1 1h7' },
  ],
  // Lucide "pin" -- a pinned tab (never replaced by the next file opened).
  pin: [
    { kind: 'path', d: 'M12 17v5' },
    {
      kind: 'path',
      d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
    },
  ],
  // Milestone 43 (ADR-0057): the icon-only chrome. Lucide path data; rects
  // and ellipses are re-expressed as paths (this map renders path/circle).
  'calendar-check': [
    { kind: 'path', d: 'M8 2v4' },
    { kind: 'path', d: 'M16 2v4' },
    { kind: 'path', d: 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z' },
    { kind: 'path', d: 'M3 10h18' },
    { kind: 'path', d: 'm9 16 2 2 4-4' },
  ],
  search: [
    { kind: 'circle', cx: 11, cy: 11, r: 8 },
    { kind: 'path', d: 'm21 21-4.3-4.3' },
  ],
  'file-text': [
    { kind: 'path', d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' },
    { kind: 'path', d: 'M14 2v4a2 2 0 0 0 2 2h4' },
    { kind: 'path', d: 'M10 9H8' },
    { kind: 'path', d: 'M16 13H8' },
    { kind: 'path', d: 'M16 17H8' },
  ],
  // Triangle, square, circle -- the usual mark for diagrams (ADR-0064).
  shapes: [
    { kind: 'path', d: 'M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z' },
    { kind: 'path', d: 'M4 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z' },
    { kind: 'circle', cx: 17.5, cy: 17.5, r: 3.5 },
  ],
  layers: [
    { kind: 'path', d: 'm12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z' },
    { kind: 'path', d: 'm22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65' },
    { kind: 'path', d: 'm22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65' },
  ],
  replace: [
    { kind: 'path', d: 'M8 3 4 7l4 4' },
    { kind: 'path', d: 'M4 7h16' },
    { kind: 'path', d: 'm16 21 4-4-4-4' },
    { kind: 'path', d: 'M20 17H4' },
  ],
  download: [
    { kind: 'path', d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' },
    { kind: 'path', d: 'm7 10 5 5 5-5' },
    { kind: 'path', d: 'M12 15V3' },
  ],
  filter: [
    { kind: 'path', d: 'M3 6h18' },
    { kind: 'path', d: 'M7 12h10' },
    { kind: 'path', d: 'M10 18h4' },
  ],
  'check-square': [
    { kind: 'path', d: 'M21 10.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12.5' },
    { kind: 'path', d: 'm9 11 3 3L22 4' },
  ],
  'circle-check': [
    { kind: 'circle', cx: 12, cy: 12, r: 10 },
    { kind: 'path', d: 'm9 12 2 2 4-4' },
  ],
  hash: [
    { kind: 'path', d: 'M4 9h16' },
    { kind: 'path', d: 'M4 15h16' },
    { kind: 'path', d: 'M10 3 8 21' },
    { kind: 'path', d: 'M16 3l-2 18' },
  ],
  paperclip: [
    { kind: 'path', d: 'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48' },
  ],
  'pencil-line': [
    { kind: 'path', d: 'M12 20h9' },
    { kind: 'path', d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z' },
  ],
  database: [
    { kind: 'path', d: 'M3 5c0-1.66 4.03-3 9-3s9 1.34 9 3-4.03 3-9 3-9-1.34-9-3z' },
    { kind: 'path', d: 'M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5' },
    { kind: 'path', d: 'M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3' },
  ],
  'book-open': [
    { kind: 'path', d: 'M12 7v14' },
    { kind: 'path', d: 'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z' },
  ],
  heading: [
    { kind: 'path', d: 'M6 12h12' },
    { kind: 'path', d: 'M6 20V4' },
    { kind: 'path', d: 'M18 20V4' },
  ],
  bold: [
    { kind: 'path', d: 'M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8' },
  ],
  italic: [
    { kind: 'path', d: 'M19 4h-9' },
    { kind: 'path', d: 'M14 20H5' },
    { kind: 'path', d: 'M15 4 9 20' },
  ],
  strikethrough: [
    { kind: 'path', d: 'M16 4H9a3 3 0 0 0-2.83 4' },
    { kind: 'path', d: 'M14 12a4 4 0 0 1 0 8H6' },
    { kind: 'path', d: 'M4 12h16' },
  ],
  list: [
    { kind: 'path', d: 'M8 6h13' },
    { kind: 'path', d: 'M8 12h13' },
    { kind: 'path', d: 'M8 18h13' },
    { kind: 'path', d: 'M3 6h.01' },
    { kind: 'path', d: 'M3 12h.01' },
    { kind: 'path', d: 'M3 18h.01' },
  ],
  quote: [
    { kind: 'path', d: 'M17 6H3' },
    { kind: 'path', d: 'M21 12H8' },
    { kind: 'path', d: 'M21 18H8' },
    { kind: 'path', d: 'M3 12v6' },
  ],
  link: [
    { kind: 'path', d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' },
    { kind: 'path', d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' },
  ],
  image: [
    { kind: 'path', d: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z' },
    { kind: 'circle', cx: 9, cy: 9, r: 2 },
    { kind: 'path', d: 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21' },
  ],
  table: [
    { kind: 'path', d: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z' },
    { kind: 'path', d: 'M12 3v18' },
    { kind: 'path', d: 'M3 9h18' },
    { kind: 'path', d: 'M3 15h18' },
  ],
  code: [
    { kind: 'path', d: 'm16 18 6-6-6-6' },
    { kind: 'path', d: 'm8 6-6 6 6 6' },
  ],
  // Lucide "panel-left" / "panel-right" -- the titlebar's dock toggles.
  'panel-left': [
    { kind: 'path', d: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z' },
    { kind: 'path', d: 'M9 3v18' },
  ],
  'panel-right': [
    { kind: 'path', d: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z' },
    { kind: 'path', d: 'M15 3v18' },
  ],
  trash: [
    { kind: 'path', d: 'M3 6h18' },
    { kind: 'path', d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' },
    { kind: 'path', d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' },
  ],
};

/** Whether `name` is in the vendored set (plugin callers pass plain strings). */
export function isIconName(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The same glyph as `<app-icon>`, built as a plain SVG element -- what
 * `api.ui.icon` hands to plugin panels (plain DOM, ADR-0044 rule 2), so no
 * plugin carries its own copy of the path data. An unknown name yields an
 * empty, correctly sized SVG rather than throwing into plugin code.
 */
export function createIconElement(name: string, size = 16, strokeWidth = 1.75): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const shape of isIconName(name) ? ICONS[name] : []) {
    if (shape.kind === 'path') {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', shape.d);
      svg.appendChild(path);
    } else {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', String(shape.cx));
      circle.setAttribute('cy', String(shape.cy));
      circle.setAttribute('r', String(shape.r));
      svg.appendChild(circle);
    }
  }
  return svg;
}

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      [attr.stroke-width]="strokeWidth()"
      stroke-linecap="round"
      stroke-linejoin="round"
      [attr.width]="size()"
      [attr.height]="size()"
      aria-hidden="true"
      focusable="false"
    >
      @for (shape of shapes(); track $index) {
        @if (shape.kind === 'path') {
          <svg:path [attr.d]="shape.d" />
        } @else {
          <svg:circle [attr.cx]="shape.cx" [attr.cy]="shape.cy" [attr.r]="shape.r" />
        }
      }
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      line-height: 0;
    }
  `,
})
export class Icon {
  readonly name = input.required<IconName>();
  readonly size = input(16);
  readonly strokeWidth = input(1.75);

  protected readonly shapes = computed<readonly IconShape[]>(() => ICONS[this.name()]);
}
