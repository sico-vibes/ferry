import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import simpleGit from 'simple-git';
import { glob } from 'tinyglobby';
import { z } from 'zod';
import { WorkspaceJail, isBinary } from './fs.js';

export const RepoMapInput = z.object({
  tokenBudget: z.number().int().min(200).max(20_000).default(2_500),
  maxFiles: z.number().int().min(1).max(500).default(100),
});
export interface RepoMapSymbol {
  name: string;
  kind: string;
  signature: string;
  line: number;
}
export interface RepoMapFile {
  path: string;
  score: number;
  modified: boolean;
  symbols: RepoMapSymbol[];
}
export interface RepoMapResult {
  text: string;
  tokenCount: number;
  files: RepoMapFile[];
}

interface SyntaxNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number };
  childCount: number;
  child(index: number): SyntaxNode | null;
  namedChildCount: number;
  namedChild(index: number): SyntaxNode | null;
  childForFieldName(name: string): SyntaxNode | null;
}
interface SyntaxTree {
  rootNode: SyntaxNode;
  delete(): void;
}
interface SyntaxParser {
  setLanguage(language: SyntaxLanguage): SyntaxParser;
  parse(source: string): SyntaxTree | null;
  delete(): void;
}
interface SyntaxLanguage {
  delete(): void;
}
interface TreeSitterModule {
  Parser: {
    init(options: { locateFile(file: string, folder: string): string }): Promise<void>;
    new (): SyntaxParser;
  };
  Language: { load(file: string): Promise<SyntaxLanguage> };
}
interface CachedParse {
  mtimeMs: number;
  size: number;
  hash: string;
  symbols: RepoMapSymbol[];
  imports: string[];
}
interface SourceFile extends CachedParse {
  path: string;
  modifiedAt: number;
}

const sourceGrammars: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'tsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'c-sharp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.h': 'cpp',
  '.hpp': 'cpp',
  '.rb': 'ruby',
  '.php': 'php',
};
const symbolTypes =
  /(?:function(?:_declaration|_definition|_item)?|class(?:_declaration|_definition|_specifier)?|interface(?:_declaration)?|struct(?:_declaration|_item|_specifier)?|enum(?:_declaration|_item|_specifier)?|trait(?:_item)?|type_alias_declaration|method(?:_declaration|_definition)?|constructor_declaration|namespace_definition|module|impl_item|variable_declarator|const_item|static_item)$/i;
const wrapperTypes = new Set([
  'program',
  'source_file',
  'source_file_input',
  'compilation_unit',
  'module',
  'export_statement',
  'type_declaration',
  'declaration_list',
  'lexical_declaration',
  'variable_declaration',
  'const_declaration',
  'mod_item',
  'use_declaration',
]);
const grammarCache = new Map<string, Promise<SyntaxLanguage>>();
const parseCache = new Map<string, CachedParse>();
let runtimePromise: Promise<{ runtime: TreeSitterModule; wasmDir: string }> | undefined;

export async function buildRepoMap(jail: WorkspaceJail, raw: unknown = {}): Promise<RepoMapResult> {
  const input = RepoMapInput.parse(raw);
  await jail.initialize();
  const entries = await glob('**/*', {
    cwd: jail.root,
    dot: true,
    onlyFiles: true,
    ignore: ['.git/**', 'node_modules/**', 'dist/**', 'build/**', 'coverage/**'],
  });
  const supported = entries.filter(
    (file) => sourceGrammars[path.posix.extname(file).toLowerCase()],
  );
  const gitModified = await modifiedFiles(jail);
  const files: SourceFile[] = [];
  for (const rel of supported) {
    const absolute = await jail.resolve(rel).catch(() => undefined);
    if (!absolute || (await jail.isIgnored(absolute))) continue;
    const stat = await fs.stat(absolute);
    if (stat.size > 1_000_000) continue;
    const buffer = await fs.readFile(absolute);
    if (isBinary(buffer)) continue;
    const source = buffer.toString('utf8').replace(/^\uFEFF/, '');
    const hash = createHash('sha256').update(buffer).digest('hex');
    const key = `${jail.root}\0${rel}`;
    const cached = parseCache.get(key);
    let parsed = cached;
    if (cached?.hash !== hash || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
      const grammar = sourceGrammars[path.posix.extname(rel).toLowerCase()];
      if (!grammar) continue;
      try {
        const language = await loadGrammar(grammar);
        const parser = (await loadRuntime()).runtime.Parser;
        const instance = new parser();
        try {
          instance.setLanguage(language);
          const tree = instance.parse(source);
          if (!tree) continue;
          try {
            parsed = {
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              hash,
              symbols: extractSymbols(tree.rootNode, source),
              imports: extractImports(source, path.posix.extname(rel).toLowerCase()),
            };
            parseCache.set(key, parsed);
          } finally {
            tree.delete();
          }
        } finally {
          instance.delete();
        }
      } catch {
        continue;
      }
    }
    if (!parsed) continue;
    files.push({ ...parsed, path: rel.split(path.sep).join('/'), modifiedAt: stat.mtimeMs });
  }
  const inbound = rankReferences(files);
  const newest = Math.max(...files.map((file) => file.modifiedAt), Date.now());
  const ranked: RepoMapFile[] = files
    .map((file) => {
      const ageDays = Math.max(0, (newest - file.modifiedAt) / 86_400_000);
      const modified = gitModified.has(file.path);
      const score = (inbound.get(file.path) ?? 0) * 3 + (modified ? 4 : 0) + 2 / (1 + ageDays / 7);
      return { path: file.path, score, modified, symbols: file.symbols };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, input.maxFiles);
  return renderMap(ranked, input.tokenBudget);
}

async function loadRuntime(): Promise<{ runtime: TreeSitterModule; wasmDir: string }> {
  runtimePromise ??= (async () => {
    const require = createRequire(import.meta.url);
    const runtimePath = require.resolve('@vscode/tree-sitter-wasm');
    const wasmDir = path.dirname(runtimePath);
    const runtime = require('@vscode/tree-sitter-wasm') as TreeSitterModule;
    await runtime.Parser.init({
      locateFile: (file, _folder) => path.join(wasmDir, path.basename(file)),
    });
    return { runtime, wasmDir };
  })();
  return runtimePromise;
}
async function loadGrammar(name: string): Promise<SyntaxLanguage> {
  let language = grammarCache.get(name);
  if (!language) {
    language = (async () => {
      const { runtime, wasmDir } = await loadRuntime();
      return runtime.Language.load(path.join(wasmDir, `tree-sitter-${name}.wasm`));
    })();
    grammarCache.set(name, language);
  }
  return language;
}
function extractSymbols(root: SyntaxNode, source: string): RepoMapSymbol[] {
  const symbols: RepoMapSymbol[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node !== root && symbolTypes.test(node.type)) {
      const nameNode = node.childForFieldName('name');
      const fieldName = nameNode?.text.trim() ?? '';
      const name = fieldName.length > 0 ? fieldName : fallbackName(node.text);
      if (name)
        symbols.push({
          name,
          kind: node.type,
          signature: signature(node, source),
          line: node.startPosition.row + 1,
        });
      return;
    }
    if (!wrapperTypes.has(node.type) && node !== root) return;
    for (let index = 0; index < node.namedChildCount; index++) {
      const child = node.namedChild(index);
      if (child) visit(child);
    }
  };
  visit(root);
  return symbols;
}
function signature(node: SyntaxNode, source: string): string {
  let end = node.endIndex;
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (
      child &&
      /^(?:statement_block|block|class_body|declaration_list|body|compound_statement)$/.test(
        child.type,
      )
    ) {
      end = child.startIndex;
      break;
    }
  }
  const value = source
    .slice(node.startIndex, end)
    .split(/\r?\n/)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value.slice(0, 240);
}
function fallbackName(value: string): string {
  return (
    /(?:function|class|interface|struct|enum|trait|type|fn|def|func|module|namespace)\s+([\w$]+)/i.exec(
      value,
    )?.[1] ?? ''
  );
}
function extractImports(source: string, extension: string): string[] {
  const imports: string[] = [];
  const patterns =
    extension === '.py'
      ? [/^\s*from\s+([\w.]+)\s+import\b/gm, /^\s*import\s+([\w.]+)/gm]
      : [
          /\bfrom\s*['"]([^'"]+)['"]/g,
          /\bimport\s*['"]([^'"]+)['"]/g,
          /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        ];
  for (const pattern of patterns)
    for (const match of source.matchAll(pattern)) if (match[1]) imports.push(match[1]);
  return imports;
}
function rankReferences(files: SourceFile[]): Map<string, number> {
  const aliases = new Map<string, string>();
  for (const file of files) {
    const normalized = file.path.replace(/\.[^.]+$/, '').replace(/\/index$/, '');
    aliases.set(normalized, file.path);
    aliases.set(path.posix.basename(normalized), file.path);
  }
  const inbound = new Map<string, number>();
  for (const file of files)
    for (const specifier of file.imports) {
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue;
      const target = path.posix
        .normalize(path.posix.join(path.posix.dirname(file.path), specifier))
        .replace(/\.[^.]+$/, '')
        .replace(/\/index$/, '');
      const targetPath = aliases.get(target) ?? aliases.get(path.posix.basename(target));
      if (targetPath && targetPath !== file.path)
        inbound.set(targetPath, (inbound.get(targetPath) ?? 0) + 1);
    }
  return inbound;
}
async function modifiedFiles(jail: WorkspaceJail): Promise<Set<string>> {
  try {
    const status = await simpleGit(jail.root).status();
    return new Set(
      [
        ...status.modified,
        ...status.created,
        ...status.not_added,
        ...status.renamed.map((entry) => entry.to),
      ].map((file) => file.split(path.sep).join('/')),
    );
  } catch {
    return new Set();
  }
}
function renderMap(files: RepoMapFile[], tokenBudget: number): RepoMapResult {
  const lines = ['# Repository map'];
  let used = estimateTokens(lines[0] ?? '');
  const included: RepoMapFile[] = [];
  for (const file of files) {
    const row = [`- ${file.path}${file.modified ? ' [modified]' : ''}`];
    for (const symbol of file.symbols)
      row.push(`  - ${symbol.kind} ${symbol.signature} (line ${String(symbol.line)})`);
    const text = row.join('\n');
    const tokens = estimateTokens(text);
    if (used + tokens > tokenBudget) continue;
    lines.push(text);
    used += tokens;
    included.push(file);
  }
  return { text: lines.join('\n'), tokenCount: used, files: included };
}
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
export function clearRepoMapCache(): void {
  parseCache.clear();
}
