import { EditorView } from '@codemirror/view';

/**
 * Styling for the Live Preview decorations (`lp-*` classes). This must be an
 * `EditorView.theme`, not component CSS: the widget DOM is created by
 * CodeMirror, so Angular's emulated view encapsulation would never match it.
 * Values read the same design tokens as `editor-theme.ts`.
 */
export const livePreviewTheme = EditorView.theme(
  {
    '.lp-frontmatter': {
      color: 'var(--text-faint)',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.85em',
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

    '.lp-image img': {
      maxWidth: '100%',
      borderRadius: 'var(--radius-xs)',
      verticalAlign: 'text-bottom',
    },
    '.lp-image-missing': {
      color: 'var(--text-faint)',
      fontStyle: 'italic',
    },

    // A rendered ```mermaid diagram (ADR-0025).
    '.lp-mermaid': {
      display: 'block',
      margin: '6px 0',
      padding: '10px 12px',
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
    },

    '.lp-table': {
      padding: '4px 0',
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

    // The hover `✎` on rendered blocks: jump to the source (Obsidian-style).
    '.lp-table, .lp-html, .lp-mermaid': {
      position: 'relative',
    },
    '.lp-edit': {
      position: 'absolute',
      top: '4px',
      right: '4px',
      display: 'inline-flex',
      padding: '3px',
      border: '0',
      borderRadius: 'var(--radius-sm)',
      background: 'var(--hover-bg)',
      color: 'var(--text-6)',
      cursor: 'pointer',
      opacity: '0',
      transition: 'opacity 0.12s ease',
    },
    '.lp-table:hover .lp-edit, .lp-html:hover .lp-edit, .lp-mermaid:hover .lp-edit': {
      opacity: '1',
    },
    '.lp-edit:hover': {
      color: 'var(--text-primary)',
      background: 'var(--hover-bg-strong)',
    },
  },
  { dark: true },
);
