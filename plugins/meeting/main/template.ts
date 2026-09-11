/**
 * A tiny Handlebars-shaped evaluator for the meeting-section template
 * (`templates/meeting.md`). Deliberately not the `handlebars` package:
 * the repo hand-rolls this kind of thing (`shared/placeholders.ts`,
 * `shared/entry-compose.ts`) and only three constructs are needed —
 *
 *   {{key}}                      interpolate a scalar (missing -> '')
 *   {{#if key}} … {{/if}}        keep the body when `key` is truthy
 *   {{#each list}} … {{/each}}   repeat the body per item, `{{field}}`
 *                                resolving against the item ({{this}} for
 *                                a scalar item)
 *
 * `#if` / `#each` may be block-level or inline, and blocks may nest. A
 * block tag alone on its line drops that line (Handlebars "standalone"
 * rule) so the template reads naturally; after rendering, blank-line runs
 * collapse and the outer whitespace is trimmed.
 */

export type TemplateModel = { [key: string]: TemplateValue };

export type TemplateValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<TemplateModel | string | number>;

/**
 * Shipped default — English labels; the user edits `templates/meeting.md`
 * to taste (German, other layout, …). Every `{{#if}}` / `{{#each}}` that
 * can render empty sits alone on its line so it leaves no blank gap; the
 * date/time line keeps a non-conditional anchor so its inline `{{#if}}` is
 * safe.
 */
export const STARTER_MEETING_TEMPLATE = `## 📅 {{title}}

#mtg/{{slug}}

> **📆 {{date}}**{{#if start_time}} · **🕒 {{start_time}}–{{end_time}}**{{/if}}
{{#if end_date}}
> until {{end_date}}
{{/if}}
{{#if location}}
> **📍 {{location}}**
{{/if}}
{{#if organizer}}
> organized by {{organizer}}
{{/if}}

{{#if attendees}}
### 👥 Participants

{{#each attendees}}
- {{name}}
{{/each}}

{{/if}}
{{#if join_url}}
[Join meeting](<{{join_url}}>)

{{/if}}
{{#if description}}
### 📝 Invitation

{{description}}

{{/if}}
{{#if attachments}}
### 📎 Attachments

{{#each attachments}}
- {{filename}}
{{/each}}

{{/if}}
### ✍️ Notes

<!-- Your notes -->

---
`;

type Node =
  | { kind: 'text'; value: string }
  | { kind: 'var'; name: string }
  | { kind: 'if'; name: string; body: Node[] }
  | { kind: 'each'; name: string; body: Node[] };

/** `{{#if x}}` / `{{#each x}}` / `{{/if}}` / `{{/each}}` or `{{ x }}`. */
const TOKEN = /\{\{([#/])(if|each)(?:\s+([\w.-]+))?\s*\}\}|\{\{\s*([\w.-]+)\s*\}\}/g;

/** Removes the newline after a block tag that sits alone on its line. */
function stripStandaloneLines(src: string): string {
  return src.replace(/^[ \t]*(\{\{[#/](?:if|each)[^}]*\}\})[ \t]*\r?\n/gm, '$1');
}

function parse(src: string): Node[] {
  TOKEN.lastIndex = 0;
  const root: Node[] = [];
  const stack: Node[][] = [root];
  let cursor = 0;

  for (let m = TOKEN.exec(src); m !== null; m = TOKEN.exec(src)) {
    const [raw, marker, keyword, target, varName] = m;
    if (m.index > cursor) {
      stack[stack.length - 1].push({ kind: 'text', value: src.slice(cursor, m.index) });
    }
    cursor = m.index + raw.length;

    if (varName !== undefined) {
      stack[stack.length - 1].push({ kind: 'var', name: varName });
      continue;
    }
    if (marker === '#') {
      const node: Node =
        keyword === 'if'
          ? { kind: 'if', name: target ?? '', body: [] }
          : { kind: 'each', name: target ?? '', body: [] };
      stack[stack.length - 1].push(node);
      stack.push(node.body);
    } else if (stack.length > 1) {
      stack.pop();
    } else {
      // Stray `{{/if}}` with no opener — keep it literal so the typo shows.
      stack[stack.length - 1].push({ kind: 'text', value: raw });
    }
  }
  if (cursor < src.length) {
    stack[stack.length - 1].push({ kind: 'text', value: src.slice(cursor) });
  }
  return root;
}

function truthy(value: TemplateValue): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'string') {
    return value.trim() !== '';
  }
  return Boolean(value);
}

function scalar(value: TemplateValue): string {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return '';
  }
  return String(value);
}

function lookup(scope: TemplateModel, name: string): TemplateValue {
  return scope[name];
}

function render(nodes: Node[], scope: TemplateModel): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out += node.value;
        break;
      case 'var':
        out += scalar(lookup(scope, node.name));
        break;
      case 'if':
        if (truthy(lookup(scope, node.name))) {
          out += render(node.body, scope);
        }
        break;
      case 'each': {
        const list = lookup(scope, node.name);
        if (Array.isArray(list)) {
          for (const item of list) {
            const childScope: TemplateModel =
              item !== null && typeof item === 'object'
                ? (item as TemplateModel)
                : { this: item as TemplateValue };
            out += render(node.body, childScope);
          }
        }
        break;
      }
    }
  }
  return out;
}

/** Collapses runs of blank lines to one and trims leading / trailing blank lines. */
function tidy(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/, '');
    if (line === '') {
      if (kept.length > 0 && kept[kept.length - 1] !== '') {
        kept.push('');
      }
    } else {
      kept.push(line);
    }
  }
  while (kept.length > 0 && kept[0] === '') {
    kept.shift();
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') {
    kept.pop();
  }
  return kept.join('\n');
}

export function renderTemplate(template: string, model: TemplateModel): string {
  return tidy(render(parse(stripStandaloneLines(template)), model));
}
