/**
 * A small, dependency-free syntax tokenizer for fenced code in chat
 * answers. It is deliberately approximate — comments, strings, numbers,
 * keywords, calls and type-like names for the C-like / scripting
 * families models usually answer in — and produces plain tokens the
 * renderer turns into DOM nodes (never `innerHTML`).
 */

export type CodeTokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'function' | 'type' | 'plain';

export interface CodeToken {
  kind: CodeTokenKind;
  text: string;
}

interface Family {
  line: readonly string[];
  block: readonly [string, string] | null;
  keywords: ReadonlySet<string>;
  caseInsensitive?: boolean;
}

const words = (list: string): ReadonlySet<string> => new Set(list.split(/\s+/).filter(Boolean));

const C_LIKE = words(
  `abstract as async await break case catch class const continue default delete do else enum export extends
   false final finally for foreach from function get if implements import in instanceof interface internal is let
   namespace new null of override private protected public readonly return sealed set static struct super switch
   this throw true try type typeof undefined using var virtual void while with yield fn impl mod pub use mut match
   trait loop where unsafe go func defer chan select package range nil int long float double bool string char`,
);
const SCRIPT = words(
  `and as assert async await break case class continue def del do done elif else elseif end esac except False fi
   finally for foreach from function global if import in is lambda local None nonlocal not or pass raise return
   self then True try until while with yield echo exit export set switch param begin process filter`,
);
const SQL = words(
  `select from where insert into values update set delete create table alter drop index join inner outer left
   right on group by order having limit offset as and or not null is in like distinct union all case when then
   else end primary key foreign references default`,
);
const DATA = words('true false null');

const FAMILIES: Record<string, Family> = {
  clike: { line: ['//'], block: ['/*', '*/'], keywords: C_LIKE },
  script: { line: ['#'], block: null, keywords: SCRIPT },
  sql: { line: ['--'], block: ['/*', '*/'], keywords: SQL, caseInsensitive: true },
  json: { line: [], block: null, keywords: DATA },
  yaml: { line: ['#'], block: null, keywords: DATA },
  css: { line: [], block: ['/*', '*/'], keywords: words('important') },
  markup: { line: [], block: ['<!--', '-->'], keywords: new Set() },
};

const ALIASES: Record<string, string> = {
  ts: 'clike', tsx: 'clike', typescript: 'clike', js: 'clike', jsx: 'clike', javascript: 'clike',
  mjs: 'clike', java: 'clike', c: 'clike', h: 'clike', cpp: 'clike', 'c++': 'clike', cs: 'clike',
  csharp: 'clike', go: 'clike', rust: 'clike', rs: 'clike', kotlin: 'clike', swift: 'clike', php: 'clike',
  dart: 'clike',
  py: 'script', python: 'script', sh: 'script', bash: 'script', shell: 'script', zsh: 'script',
  ps1: 'script', powershell: 'script', pwsh: 'script', rb: 'script', ruby: 'script', toml: 'yaml',
  yml: 'yaml', yaml: 'yaml', json: 'json', jsonc: 'json', sql: 'sql', css: 'css', scss: 'css',
  html: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
};

export function familyFor(lang: string): string | null {
  return ALIASES[lang.trim().toLowerCase()] ?? null;
}

const STRING_QUOTES = new Set(['"', "'", '`']);
const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;

function push(tokens: CodeToken[], kind: CodeTokenKind, text: string): void {
  if (text === '') {
    return;
  }
  const last = tokens[tokens.length - 1];
  if (last !== undefined && last.kind === kind) {
    last.text += text;
  } else {
    tokens.push({ kind, text });
  }
}

/** Splits `code` into tokens; an unknown language yields one plain token. */
export function tokenize(code: string, lang: string): CodeToken[] {
  const key = familyFor(lang);
  if (key === null) {
    return [{ kind: 'plain', text: code }];
  }
  const family = FAMILIES[key];
  const tokens: CodeToken[] = [];
  let i = 0;
  while (i < code.length) {
    const lineMark = family.line.find((mark) => code.startsWith(mark, i));
    if (lineMark !== undefined) {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? code.length : end;
      push(tokens, 'comment', code.slice(i, stop));
      i = stop;
      continue;
    }
    if (family.block !== null && code.startsWith(family.block[0], i)) {
      const end = code.indexOf(family.block[1], i + family.block[0].length);
      const stop = end === -1 ? code.length : end + family.block[1].length;
      push(tokens, 'comment', code.slice(i, stop));
      i = stop;
      continue;
    }
    const ch = code[i];
    if (STRING_QUOTES.has(ch) && key !== 'markup') {
      let j = i + 1;
      while (j < code.length && code[j] !== ch && (code[j] !== '\n' || ch === '`')) {
        j += code[j] === '\\' ? 2 : 1;
      }
      const stop = Math.min(j + 1, code.length);
      const text = code.slice(i, stop);
      // A JSON / YAML key reads as a property, not a value.
      const isKey = (key === 'json' || key === 'yaml') && /^\s*:/.test(code.slice(stop, stop + 4));
      push(tokens, isKey ? 'type' : 'string', text);
      i = stop;
      continue;
    }
    NUMBER.lastIndex = i;
    if (/\d/.test(ch) && NUMBER.test(code) && NUMBER.lastIndex > i) {
      push(tokens, 'number', code.slice(i, NUMBER.lastIndex));
      i = NUMBER.lastIndex;
      continue;
    }
    IDENT.lastIndex = i;
    if (IDENT.test(code)) {
      const word = code.slice(i, IDENT.lastIndex);
      const probe = family.caseInsensitive === true ? word.toLowerCase() : word;
      const next = code[IDENT.lastIndex];
      let kind: CodeTokenKind = 'plain';
      if (family.keywords.has(probe)) {
        kind = 'keyword';
      } else if (key === 'markup' && /[<\/]$/.test(code.slice(Math.max(0, i - 2), i))) {
        kind = 'keyword';
      } else if (next === '(') {
        kind = 'function';
      } else if (/^[A-Z][a-z]/.test(word) && key !== 'sql') {
        kind = 'type';
      }
      push(tokens, kind, word);
      i = IDENT.lastIndex;
      continue;
    }
    push(tokens, 'plain', ch);
    i += 1;
  }
  return tokens;
}
