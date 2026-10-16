/**
 * The vault tools as a model sees them (ADR-0071): names, descriptions
 * and parameters. These texts are prompt text — they are quoted in
 * `specs/classifier-spec.md`; change both together.
 *
 * Written the way one would brief a new colleague: what the tool is for,
 * what comes back, and what to do next. What cuts across tools (when to
 * call one at all, what an `Error:` result means) is in the assistant's
 * system prompt, not here.
 */
import { TASKS_LIST_SPEC } from '../../../shared/tasks-list-tool';
import type { McpToolDef } from './types';

const VAULT_ONE = {
  type: 'string',
  description:
    'Vault id. Leave it out when there is only one vault or you mean the active one.',
};

const VAULT_MANY = {
  type: 'string',
  description: 'Vault id, to look in one vault only. Leave it out to cover every available vault.',
};

export const VAULT_LIST: McpToolDef = {
  name: 'vault_list',
  description:
    'List the files of the vault — the way to see what exists before searching or reading. ' +
    'Returns one vault-relative path per line. Pass `path` to list one folder, `glob` to ' +
    'filter by name, and `headings` to see each note\'s headings (with their line numbers) ' +
    'under its path. A vault with many files comes back as its folders with file counts: ' +
    'list one of them next.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'A folder, vault-relative (e.g. "projects/website"). Default: the whole vault.' },
      glob: {
        type: 'string',
        description: 'Name pattern, e.g. "*.md", "daily/2026-10-*", "**/meeting*". `*` stays inside one folder, `**` crosses folders.',
      },
      headings: { type: 'boolean', description: 'Also show the headings of each note. Default false.' },
      vault: VAULT_MANY,
    },
  },
};

export const VAULT_SEARCH: McpToolDef = {
  name: 'vault_search',
  description:
    'Find text in notes — exact matching, like a search field. `query` is one or more words: ' +
    'a note section matches when it contains ALL of them (any order, upper or lower case), ' +
    'and the lines that carry them come back as `path`, heading and `line: text`. Put a ' +
    'phrase in double quotes to match it as written. Set `regex` to treat `query` as a ' +
    'JavaScript regular expression matched line by line. `tags` restricts to sections ' +
    'carrying all of those #tags. `path` restricts to one folder — or to ONE FILE, which is ' +
    'how you search inside a note. Use few, distinctive words; if nothing matches, try other ' +
    'words or fewer. Read a hit in full with vault_read.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words (all must occur), a "quoted phrase", or a regular expression with `regex`.' },
      regex: { type: 'boolean', description: 'Treat `query` as a regular expression. Default false.' },
      case_sensitive: { type: 'boolean', description: 'Match upper and lower case exactly. Default false.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tag names without the #; a section must carry all of them.' },
      path: { type: 'string', description: 'A folder or a single file to search in, vault-relative.' },
      context_lines: { type: 'integer', description: 'Lines to show before and after each matching line, 0 to 5. Default 0.' },
      max_results: { type: 'integer', description: 'Most matching lines to return. Default 30, at most 100.' },
      vault: VAULT_MANY,
    },
  },
};

export const VAULT_READ: McpToolDef = {
  name: 'vault_read',
  description:
    'Read one file. Each line comes back as `<line number>: <text>`; the numbers are not ' +
    'part of the file. A long file is returned in parts: the last line of the result says ' +
    'how many lines the file has and which `start_line` continues it. Pass `heading` to ' +
    'read just one section (its heading text, as vault_list or a search hit shows it), or ' +
    '`start_line` and `line_count` to read a range — a search hit\'s line number is a good ' +
    '`start_line`. A file that is open in the editor comes back as its tab shows it, ' +
    'unsaved changes included.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Vault-relative path, e.g. "daily/2026/10/2026-10-13.md".' },
      start_line: { type: 'integer', description: 'First line to return, 1-based. Default 1.' },
      line_count: { type: 'integer', description: 'How many lines to return. Default 400, at most 1000.' },
      heading: { type: 'string', description: 'Return only the section under this heading (without the # signs).' },
      vault: VAULT_ONE,
    },
    required: ['path'],
  },
};

export const VAULT_EDIT: McpToolDef = {
  name: 'vault_edit',
  description:
    'Change part of a file by replacing exact text — the tool for every change to an ' +
    'existing note. Each edit gives `old_text`, copied exactly from the file (same spaces ' +
    'and line breaks, WITHOUT the line numbers vault_read shows), and `new_text` to put in ' +
    'its place. `old_text` must occur exactly once in the file: include a neighbouring line ' +
    'when a short piece is ambiguous, or set `replace_all` to change every occurrence. ' +
    'Several edits in one call apply in order, and all or none: if one does not match, ' +
    'nothing is changed and the error says which. To insert, replace a line with itself ' +
    'plus the new lines; to delete, replace with an empty `new_text`. Read the file first.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Vault-relative path of an existing file.' },
      edits: {
        type: 'array',
        description: 'The replacements, applied in order.',
        items: {
          type: 'object',
          properties: {
            old_text: { type: 'string', description: 'Exact text to replace; must occur once.' },
            new_text: { type: 'string', description: 'The replacement; empty to delete.' },
            replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
          },
          required: ['old_text', 'new_text'],
        },
      },
      vault: VAULT_ONE,
    },
    required: ['path', 'edits'],
  },
};

export const VAULT_WRITE: McpToolDef = {
  name: 'vault_write',
  description:
    'Write a whole file. `mode` says what you mean: "create" makes a new file and fails if ' +
    'one is already there; "append" adds `content` to the end of a file (creating it if ' +
    'needed) — the way to add an entry to a log or a daily note; "overwrite" replaces ' +
    'everything in the file. To change part of an existing note use vault_edit instead: ' +
    'overwriting loses whatever you did not repeat. Notes are Markdown files ending in .md; ' +
    'missing folders are created.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Vault-relative path, e.g. "projects/website/ideas.md".' },
      content: { type: 'string', description: 'The text to write.' },
      mode: { type: 'string', enum: ['create', 'append', 'overwrite'], description: 'Required. See the description.' },
      vault: VAULT_ONE,
    },
    required: ['path', 'content', 'mode'],
  },
};

export const VAULT_MOVE: McpToolDef = {
  name: 'vault_move',
  description:
    'Move or rename a file or folder inside one vault. Links in other notes that point to ' +
    'it are rewritten, and a note\'s attachments move with it. `to` is the full new path, ' +
    'not just the folder; it must not exist yet.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Current vault-relative path.' },
      to: { type: 'string', description: 'New vault-relative path, including the file name.' },
      vault: VAULT_ONE,
    },
    required: ['from', 'to'],
  },
};

export const VAULT_DELETE: McpToolDef = {
  name: 'vault_delete',
  description:
    'Delete one file. It goes to the recycle bin, and the user is asked every time. Only ' +
    'when the user asked for the file to be deleted.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Vault-relative path of the file.' },
      vault: VAULT_ONE,
    },
    required: ['path'],
  },
};

export const TASKS_LIST: McpToolDef = {
  name: TASKS_LIST_SPEC.name,
  description: TASKS_LIST_SPEC.description,
  inputSchema: TASKS_LIST_SPEC.parameters,
};

/** The tools that only read. */
export const READ_TOOLS: readonly McpToolDef[] = [VAULT_LIST, VAULT_SEARCH, VAULT_READ];

/** The tools that change the vault. */
export const WRITE_TOOLS: readonly McpToolDef[] = [VAULT_EDIT, VAULT_WRITE, VAULT_MOVE, VAULT_DELETE];

export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(WRITE_TOOLS.map((tool) => tool.name));
