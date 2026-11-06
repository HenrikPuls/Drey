/**
 * The literal-string guard (ADR-0091): finds user-visible text written
 * straight into a `.ts` or `.html` source instead of coming from the
 * catalog. It runs as a spec (`literal-guard.spec.ts`) over the guarded
 * paths — the directories of the surfaces decided on 2026-11-06, listed
 * in `guarded-paths.json` — and over any file that opts in with the
 * marker `// i18n: catalog` (`<!-- i18n: catalog -->` in a template) in its first lines. Nothing outside those
 * paths is scanned: the existing UI migrates area by area (roadmap).
 *
 * The detector is a heuristic with a bias towards catching text. It is
 * tuned so the ordinary non-text literals of a component — selectors,
 * class lists, keys, ids, paths, CSS values, catalog keys — pass without
 * a marker; an unavoidable text literal (a product name, a mono id the
 * owner wants verbatim) is exempted per line with `i18n-ignore` in a
 * comment on the same or the preceding line.
 */
import * as ts from 'typescript';
import { MESSAGE_KEY_PATTERN } from './catalog';

export interface LiteralFinding {
  /** 1-based line. */
  readonly line: number;
  /** The literal's text, as written. */
  readonly text: string;
  /** What made it a finding. */
  readonly reason: 'text' | 'unknown-key';
}

/** The marker that puts a file under the guard wherever it lives. */
export const OPT_IN_MARKER = /^\s*(?:\/\/|<!--)\s*i18n:\s*catalog\b/m;

/** The per-line exemption, in a comment on the same or the preceding line. */
export const IGNORE_MARKER = 'i18n-ignore';

/** Attributes whose plain value the user reads. */
const TEXT_ATTRIBUTES = ['title', 'aria-label', 'aria-description', 'placeholder', 'alt', 'label'];

/** The call names whose first string argument is a catalog key, not text. */
const KEY_CALLS = new Set(['t', 'lookup', 'has']);

/** A word made of letters only, with optional trailing punctuation. */
const LETTER_WORD = /^[A-Za-z]{2,}[.,!?…:;]?$/;

/**
 * True when a string literal reads like text a person is meant to see:
 * it starts with a capital letter followed by lowercase letters (`Accept`,
 * `Ready to try`) and is no PascalCase identifier (`McState`), or it holds
 * at least two letter-only words (`in total`, `no estimate yet (first
 * run)`). Catalog keys, URLs, paths, selectors, class lists, CSS values
 * and SCREAMING_CASE names read as code.
 */
export function looksLikeText(value: string): boolean {
  const text = value.trim();
  if (text.length < 2 || MESSAGE_KEY_PATTERN.test(text)) {
    return false;
  }
  if (/^[a-z]+:\/\/|^[./\\#]|^https?:|\.(ts|js|html|css|json|md|svg|png)$/i.test(text)) {
    return false;
  }
  const words = text.split(/\s+/);
  const letterWords = words.filter((word) => LETTER_WORD.test(word));
  if (letterWords.length >= 2) {
    return true;
  }
  if (words.length === 1) {
    const word = words[0];
    // `Accept`, `Paused`: capital, then lowercase letters only. `McState`
    // and `SCREAMING_CASE` carry a second capital and read as code.
    return /^[A-Z][a-z]{2,}[.,!?…:;]?$/.test(word);
  }
  return false;
}

/** The lines that carry the exemption marker, 1-based. */
function ignoredLines(source: string): Set<number> {
  const ignored = new Set<number>();
  source.split(/\r?\n/).forEach((line, index) => {
    if (line.includes(IGNORE_MARKER)) {
      ignored.add(index + 1);
      ignored.add(index + 2);
    }
  });
  return ignored;
}

/**
 * The string literals of a TypeScript source that read like text and sit
 * where a user could see them. Skipped: import / export specifiers,
 * property names, element-access keys, `case` labels, equality
 * comparisons, `console.*` arguments, decorator `selector` / `templateUrl`
 * / `styleUrl(s)` values, and the first argument of `t(..)` / `lookup(..)`
 * / `has(..)` (a key — checked against the catalog when `knownKeys` is
 * given, reported as `unknown-key` otherwise).
 */
export function findLiteralStrings(
  source: string,
  fileName = 'file.ts',
  knownKeys?: ReadonlySet<string>,
): LiteralFinding[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const ignored = ignoredLines(source);
  const findings: LiteralFinding[] = [];

  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const isKeyCall = (call: ts.CallExpression): boolean => {
    const callee = call.expression;
    const name = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isIdentifier(callee)
        ? callee.text
        : null;
    return name !== null && KEY_CALLS.has(name);
  };

  const isConsoleCall = (call: ts.CallExpression): boolean =>
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === 'console';

  const skipParent = (node: ts.Node, parent: ts.Node): boolean => {
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)) {
      return true;
    }
    if (ts.isPropertyAssignment(parent) && parent.name === node) {
      return true;
    }
    if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
      const key = parent.name.text;
      if (key === 'selector' || key === 'templateUrl' || key === 'styleUrl' || key === 'styleUrls') {
        return true;
      }
    }
    if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) {
      return true;
    }
    if (ts.isCaseClause(parent) || ts.isLiteralTypeNode(parent) || ts.isEnumMember(parent)) {
      return true;
    }
    if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken
      ) {
        return true;
      }
    }
    if (ts.isCallExpression(parent) && isConsoleCall(parent)) {
      return true;
    }
    return false;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const line = lineOf(node);
      const parent = node.parent;
      if (ignored.has(line) || skipParent(node, parent)) {
        return;
      }
      if (ts.isCallExpression(parent) && isKeyCall(parent) && parent.arguments[0] === node) {
        if (knownKeys !== undefined && !knownKeys.has(node.text)) {
          findings.push({ line, text: node.text, reason: 'unknown-key' });
        }
        return;
      }
      if (looksLikeText(node.text)) {
        findings.push({ line, text: node.text, reason: 'text' });
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

/** Text between tags with interpolations, control-flow braces and comments removed. */
function visibleText(fragment: string): string {
  return fragment
    .replace(/\{\{[\s\S]*?\}\}/g, ' ')
    .replace(/@(if|else if|else|for|switch|case|default|empty|defer|placeholder|loading|error|let)\b[^{]*\{?/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .trim();
}

/**
 * The text a template shows outside the catalog: text nodes with at
 * least one word of two letters, and the plain (unbound) values of the
 * attributes a user reads (`title`, `aria-label`, `placeholder`, `alt`,
 * `label`). `[title]="…"` bindings are expressions and pass; a `'…' | t`
 * pipe's key is checked against the catalog when `knownKeys` is given.
 */
export function findTemplateStrings(source: string, knownKeys?: ReadonlySet<string>): LiteralFinding[] {
  const ignored = ignoredLines(source);
  const findings: LiteralFinding[] = [];
  const lineAt = (offset: number): number => source.slice(0, offset).split(/\r?\n/).length;
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\r\n]/g, ' '));

  // Text nodes.
  const textNode = />([^<]+)</g;
  for (const match of withoutComments.matchAll(textNode)) {
    const text = visibleText(match[1]);
    // The line of the text's first character, not of the `>` before it.
    const leading = match[1].length - match[1].trimStart().length;
    const line = lineAt(match.index + 1 + leading);
    if (text !== '' && /[A-Za-z]{2,}/.test(text) && !ignored.has(line)) {
      findings.push({ line, text, reason: 'text' });
    }
  }

  // Plain text attributes.
  const attribute = new RegExp(`\\s(${TEXT_ATTRIBUTES.join('|')})="([^"]*)"`, 'g');
  for (const match of withoutComments.matchAll(attribute)) {
    const value = match[2].trim();
    const line = lineAt(match.index + 1);
    if (value !== '' && /[A-Za-z]{2,}/.test(value) && !ignored.has(line)) {
      findings.push({ line, text: value, reason: 'text' });
    }
  }

  // `'key' | t` pipes.
  if (knownKeys !== undefined) {
    const pipe = /'([^']+)'\s*\|\s*t\b/g;
    for (const match of withoutComments.matchAll(pipe)) {
      const line = lineAt(match.index + 1);
      if (!knownKeys.has(match[1]) && !ignored.has(line)) {
        findings.push({ line, text: match[1], reason: 'unknown-key' });
      }
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

/** True when a file opts into the guard by its marker. */
export function optsIn(source: string): boolean {
  return OPT_IN_MARKER.test(source.split(/\r?\n/).slice(0, 8).join('\n'));
}
