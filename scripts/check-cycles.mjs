#!/usr/bin/env node
/**
 * Fails on RUNTIME import cycles across the four repo parts (electron/,
 * shared/, plugins/, src/) -- the A11 follow-up of the 2026-10-13
 * architecture review. A3 removed the two renderer cycles; nothing
 * stopped a new one, and `tsc`/esbuild both compile a cycle without
 * complaint (the failure shows up at runtime as an undefined import,
 * depending on load order).
 *
 * An edge is a runtime edge only when the importing file actually uses a
 * value of the imported module: `import type` never counts, and an import
 * clause whose every name resolves to an interface or type alias is
 * erased by the compilers (tsc elides it in the CJS build, esbuild drops
 * the unused specifiers), so it cannot cycle at runtime. Barrel re-exports
 * (`export … from`), side-effect imports, `require()` and dynamic
 * `import()` always count. The classification uses the TypeScript compiler
 * API (a devDependency; no extra tooling).
 *
 * Run via `npm run cycles` (CI runs it right after lint). Exit 1 lists
 * every distinct cycle as a chain, e.g. `a.ts -> b.ts -> a.ts`.
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOTS = ['electron', 'shared', 'plugins', 'src'];

/** Every .ts source under one root, relative to the repo root, `/`-separated. */
function tsFiles(root, out = []) {
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full.replaceAll('\\', '/'));
  }
  return out;
}

const files = [...new Set(ROOTS.flatMap((root) => tsFiles(root)))];
const program = ts.createProgram(files, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  esModuleInterop: true,
  skipLibCheck: true,
});
const checker = program.getTypeChecker();

/** The repo file a module specifier resolves to, or null (external). */
function repoFile(node) {
  const symbol = checker.getSymbolAtLocation(node);
  const decl = symbol?.declarations?.find((d) => ts.isSourceFile(d));
  return decl ? decl.fileName.replaceAll('\\', '/') : null;
}

/** True when every imported name is type-only in effect (a type or interface). */
function typeOnlyNames(clause, checker2) {
  const names = [];
  if (clause.name) names.push(clause.name);
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.push(clause.namedBindings.name);
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const el of clause.namedBindings.elements) names.push(el.propertyName ?? el.name);
  }
  return names.every((name) => {
    const symbol = checker2.getSymbolAtLocation(name);
    if (!symbol) return false; // unresolvable: treat as a value, conservatively
    const target = ts.SymbolFlags.Alias & symbol.flags ? checker2.getAliasedSymbol(symbol) : symbol;
    return (target.flags & ts.SymbolFlags.Value) === 0;
  });
}

/** Runtime edges of one source file, as repo-relative targets. */
function runtimeEdges(sourceFile) {
  const targets = new Set();
  const add = (node) => {
    if (!ts.isStringLiteralLike(node)) return;
    const target = repoFile(node);
    if (target) targets.add(target);
  };
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      // `import '...'` (side effect) or a clause with any value name: runtime.
      if (!clause || !typeOnlyNames(clause, checker)) add(statement.moduleSpecifier);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      add(statement.moduleSpecifier); // a barrel re-export ships values unless `export type`
      if (statement.isTypeOnly) targets.delete(repoFile(statement.moduleSpecifier) ?? '');
    }
  }
  return [...targets];
}

const graph = new Map(files.map((f) => [f, runtimeEdges(program.getSourceFile(f) ?? ts.createSourceFile(f, '', ts.ScriptTarget.ES2022))]));

// DFS with a path stack; a back edge to a node on the stack is a cycle.
const cycles = new Set();
const state = new Map(files.map((f) => [f, 'new']));
const visit = (file, stack) => {
  state.set(file, 'open');
  stack.push(file);
  for (const next of graph.get(file) ?? []) {
    if (state.get(next) === 'new') visit(next, stack);
    else if (state.get(next) === 'open') {
      const chain = stack.slice(stack.indexOf(next));
      cycles.add([...chain, next].join(' -> '));
    }
  }
  stack.pop();
  state.set(file, 'done');
};
for (const file of files) if (state.get(file) === 'new') visit(file, []);

if (cycles.size) {
  console.error(`runtime import cycles found (${cycles.size}):`);
  for (const cycle of [...cycles].sort()) console.error(`  ${cycle}`);
  process.exit(1);
}
console.log(`no runtime import cycles across ${files.length} files in ${ROOTS.join(', ')}`);
