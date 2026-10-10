import { EditorView } from '@codemirror/view';

/**
 * Styling for the Live Preview decorations (`lp-*` classes). This must be an
 * `EditorView.theme`, not component CSS: the widget DOM is created by
 * CodeMirror, so Angular's emulated view encapsulation would never match it.
 * Values read the same design tokens as `editor-theme.ts`.
 */
export const livePreviewTheme = EditorView.theme(
  {
    // The expanded frontmatter block (`---` ... `---`) reads as plain grey
    // body text, matching `.cm-fm-line` in source mode -- no mono, no dimming.
    // The `span` rule (0,0,1,1) overrides the per-token highlight spans:
    // without a frontmatter parser, Lezer-Markdown tags the block as a Setext
    // H2, so each line otherwise gets heading weight/size + inline colours.
    '.lp-frontmatter': {
      color: 'var(--text-3)',
    },
    '.lp-frontmatter span': {
      color: 'var(--text-3)',
      fontWeight: '400',
      fontStyle: 'normal',
      fontSize: '1em',
      fontFamily: 'var(--font-sans)',
      textDecoration: 'none',
    },

    '.lp-quote': {
      borderLeft: '2px solid var(--accent-quote)',
      paddingLeft: '14px',
    },

    '.lp-inline-code': {
      background: 'var(--hover-bg)',
      borderRadius: 'var(--radius-xs)',
      padding: '0.1em 0.2em',
    },

    '.lp-code': {
      background: 'var(--bg-bar)',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.9em',
      padding: '0 12px',
    },
    '.lp-code-first': {
      borderRadius: 'var(--radius) var(--radius) 0 0',
      paddingTop: '6px',
      position: 'relative',
    },
    // Language badge on the block's right, from the fence's info string.
    '.lp-code-first[data-lang]::after': {
      content: 'attr(data-lang)',
      position: 'absolute',
      right: '10px',
      top: '5px',
      fontSize: '10px',
      letterSpacing: '0.04em',
      color: 'var(--text-6)',
      fontFamily: 'var(--font-mono)',
      pointerEvents: 'none',
    },
    '.lp-code-last': {
      borderRadius: '0 0 var(--radius) var(--radius)',
      paddingBottom: '6px',
    },

    '.lp-bullet': {
      color: 'var(--text-5)',
    },

    '.lp-task input': {
      margin: '0 2px',
      verticalAlign: 'middle',
      accentColor: 'var(--accent)',
      cursor: 'pointer',
    },

    // A checked `- [x]` task: strike the text and mute it, the way a
    // done item reads in Obsidian / a paper list.
    '.lp-task-done': {
      textDecoration: 'line-through',
      textDecorationThickness: '1px',
      color: 'var(--text-6)',
    },

    '.lp-hr': {
      display: 'inline-block',
      width: '100%',
      verticalAlign: 'middle',
      borderTop: '1px solid var(--border-strong)',
    },

    '.lp-image': {
      position: 'relative',
      display: 'inline-block',
      lineHeight: '0',
    },
    '.lp-image img': {
      maxWidth: '100%',
      borderRadius: 'var(--radius-xs)',
      verticalAlign: 'text-bottom',
    },
    // An all-but-invisible picture: a box big enough for the hover buttons,
    // outlined so there is something to aim at. The picture is not scaled.
    '.lp-image-tiny': {
      minWidth: '72px',
      minHeight: '32px',
      outline: '1px dashed var(--border-strong)',
      borderRadius: 'var(--radius-xs)',
    },
    '.lp-image-missing': {
      color: 'var(--text-faint)',
      fontStyle: 'italic',
    },
    // Corner grip -> drag to resize (rewrites `![alt|W]`, ADR-0026).
    '.lp-resize': {
      position: 'absolute',
      right: '-4px',
      bottom: '-4px',
      width: '14px',
      height: '14px',
      borderRadius: '3px',
      background: 'var(--accent)',
      border: '2px solid var(--bg-editor)',
      cursor: 'nwse-resize',
      opacity: '0',
      transition: 'opacity 0.12s ease',
      touchAction: 'none',
    },
    '.lp-image:hover .lp-resize': {
      opacity: '1',
    },

    // A rendered ```mermaid diagram (ADR-0025). Spacing is `padding`, not
    // `margin`: this is the root of a `block: true` replace widget and
    // CodeMirror's height measurement ignores a block widget's own margin
    // (see `.cm-fm-pill` in `frontmatter-fold.ts`), which would drift the
    // gutter / click hit-testing for every line below the diagram.
    '.lp-mermaid': {
      position: 'relative',
      display: 'block',
      margin: '0',
      padding: '16px 12px',
      background: 'var(--bg-bar)',
      borderRadius: 'var(--radius)',
      overflowX: 'auto',
      textAlign: 'center',
    },
    '.lp-mermaid svg': {
      maxWidth: '100%',
      height: 'auto',
    },
    '.lp-mermaid-pending': {
      color: 'var(--text-faint)',
      fontStyle: 'italic',
      fontSize: '0.9em',
    },
    '.lp-mermaid-error': {
      margin: '0',
      textAlign: 'left',
      whiteSpace: 'pre-wrap',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.85em',
      color: 'var(--danger, #e06c75)',
      // The whole box is a hit target back into the fenced source.
      cursor: 'pointer',
    },

    // An embedded PDF rendered by the built-in (PDFium) viewer (ADR-0052).
    // Inline replace decoration like `.lp-image`, full column wide; the
    // height is a variable so it stays themable without code.
    '.lp-pdf': {
      position: 'relative',
      display: 'inline-block',
      width: '100%',
    },
    '.lp-pdf-name': {
      display: 'block',
      lineHeight: '1.4',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.78rem',
      color: 'var(--text-faint)',
      padding: '0 0 2px',
      overflowWrap: 'anywhere',
    },
    '.lp-pdf-frame': {
      display: 'block',
      width: '100%',
      height: 'var(--lp-pdf-height, 480px)',
      border: '1px solid var(--border-strong)',
      borderRadius: 'var(--radius-xs)',
      background: 'var(--bg-bar)',
    },
    '.lp-pdf-pending': {
      color: 'var(--text-faint)',
      fontStyle: 'italic',
      fontSize: '0.9em',
    },
    '.lp-pdf-error': {
      margin: '0',
      textAlign: 'left',
      whiteSpace: 'pre-wrap',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.85em',
      color: 'var(--danger, #e06c75)',
      // The whole box is a hit target back into the embed's source line.
      cursor: 'pointer',
    },

    '.lp-table': {
      padding: '2px 0',
      cursor: 'default',
    },
    '.lp-table table, .lp-html table': {
      borderCollapse: 'collapse',
      fontSize: '0.95em',
    },
    '.lp-table th, .lp-table td, .lp-html th, .lp-html td': {
      border: '1px solid var(--border-strong)',
      padding: '0.35rem 0.7rem',
      textAlign: 'left',
    },
    '.lp-table th, .lp-html th': {
      background: 'var(--hover-bg)',
      fontWeight: '600',
      color: 'var(--text-primary)',
    },

    '.lp-html': {
      padding: '2px 0',
    },
    '.lp-html img': {
      maxWidth: '100%',
      borderRadius: 'var(--radius-xs)',
    },
    '.lp-html a': {
      color: 'var(--accent)',
    },
    '.lp-html summary': {
      cursor: 'pointer',
      color: 'var(--text-primary)',
    },
    '.lp-html details': {
      background: 'var(--hover-bg)',
      borderRadius: 'var(--radius)',
      padding: '6px 10px',
    },

    '.lp-table, .lp-html, .lp-mermaid': {
      position: 'relative',
    },

    // The hover corner cluster on a rendered block: the `</>` "View source"
    // button and, where present, the zoom lens -- a flex row so the two
    // sit side by side instead of stacking in the same corner. The
    // `.lp-resize` grip stays its own separate bottom-right element.
    '.lp-tools': {
      position: 'absolute',
      top: '4px',
      right: '4px',
      display: 'flex',
      gap: '4px',
      opacity: '0',
      transition: 'opacity 0.12s ease',
    },
    '.lp-table:hover .lp-tools, .lp-html:hover .lp-tools, .lp-mermaid:hover .lp-tools, .lp-image:hover .lp-tools, .lp-pdf:hover .lp-tools':
      {
        opacity: '1',
      },
    '.lp-edit, .lp-lens': {
      display: 'inline-flex',
      padding: '3px',
      border: '0',
      borderRadius: 'var(--radius-sm)',
      background: 'var(--hover-bg)',
      color: 'var(--text-6)',
      cursor: 'pointer',
    },
    '.lp-edit:hover, .lp-lens:hover': {
      color: 'var(--text-primary)',
      background: 'var(--hover-bg-strong)',
    },

    // The revealed-source container: while an embed's raw Markdown is shown
    // for editing, its line(s) get a rounded box so the active-line
    // highlight reads as "in scope" rather than running full-bleed. Border
    // only + near-transparent fill, so it composes over `.lp-code*` (a
    // revealed mermaid fence) and `.cm-activeLine`.
    '.lp-reveal': {
      background: 'var(--hover-bg)',
      borderLeft: '1px solid var(--border-strong)',
      borderRight: '1px solid var(--border-strong)',
    },
    '.lp-reveal-first': {
      borderTop: '1px solid var(--border-strong)',
      borderTopLeftRadius: 'var(--radius)',
      borderTopRightRadius: 'var(--radius)',
      paddingTop: '2px',
    },
    '.lp-reveal-last': {
      borderBottom: '1px solid var(--border-strong)',
      borderBottomLeftRadius: 'var(--radius)',
      borderBottomRightRadius: 'var(--radius)',
      paddingBottom: '2px',
    },
    // The read-only render kept below an image's markup while it is revealed.
    '.lp-image-preview': {
      display: 'block',
      margin: '4px 0 2px',
    },
    // The PDF counterpart -- no tools, just the frame.
    '.lp-pdf-preview': {
      display: 'block',
      margin: '4px 0 2px',
    },
  },
  { dark: true },
);
