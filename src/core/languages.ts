/**
 * Language identity — pure data, no parsers.
 *
 * Split deliberately from `editor/languages.ts`, which owns the CodeMirror
 * grammar loaders. Detection is needed by the workspace, the status bar and
 * the explorer icons; none of them should pull a parser bundle in to ask what
 * a file is called.
 */

import { basename, extname } from './path';

export interface LanguageInfo {
  id: string;
  /** Shown in the status bar. */
  name: string;
  extensions: readonly string[];
  /** Exact filenames, for things like `Dockerfile` or `Makefile`. */
  filenames?: readonly string[];
  /** Line-comment token, used by the comment command where no grammar exists. */
  lineComment?: string;
}

export const LANGUAGES: readonly LanguageInfo[] = [
  {
    id: 'typescript',
    name: 'TypeScript',
    extensions: ['ts', 'mts', 'cts'],
    lineComment: '//',
  },
  { id: 'tsx', name: 'TypeScript React', extensions: ['tsx'], lineComment: '//' },
  {
    id: 'javascript',
    name: 'JavaScript',
    extensions: ['js', 'mjs', 'cjs'],
    lineComment: '//',
  },
  { id: 'jsx', name: 'JavaScript React', extensions: ['jsx'], lineComment: '//' },
  { id: 'json', name: 'JSON', extensions: ['json', 'jsonc', 'webmanifest'] },
  { id: 'html', name: 'HTML', extensions: ['html', 'htm', 'xhtml'] },
  { id: 'css', name: 'CSS', extensions: ['css'] },
  { id: 'scss', name: 'SCSS', extensions: ['scss', 'sass'], lineComment: '//' },
  { id: 'markdown', name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] },
  { id: 'python', name: 'Python', extensions: ['py', 'pyi', 'pyw'], lineComment: '#' },
  { id: 'rust', name: 'Rust', extensions: ['rs'], lineComment: '//' },
  {
    id: 'shell',
    name: 'Shell',
    extensions: ['sh', 'bash', 'zsh', 'fish'],
    filenames: ['.bashrc', '.zshrc', '.profile'],
    lineComment: '#',
  },
  {
    id: 'yaml',
    name: 'YAML',
    extensions: ['yml', 'yaml'],
    lineComment: '#',
  },
  { id: 'toml', name: 'TOML', extensions: ['toml'], filenames: ['Cargo.lock'], lineComment: '#' },
  { id: 'xml', name: 'XML', extensions: ['xml', 'svg', 'plist'] },
  { id: 'sql', name: 'SQL', extensions: ['sql'], lineComment: '--' },
  { id: 'go', name: 'Go', extensions: ['go'], lineComment: '//' },
  { id: 'c', name: 'C', extensions: ['c', 'h'], lineComment: '//' },
  { id: 'cpp', name: 'C++', extensions: ['cc', 'cpp', 'cxx', 'hpp', 'hh'], lineComment: '//' },
  { id: 'java', name: 'Java', extensions: ['java'], lineComment: '//' },
  { id: 'ruby', name: 'Ruby', extensions: ['rb'], lineComment: '#' },
  { id: 'php', name: 'PHP', extensions: ['php'], lineComment: '//' },
  { id: 'svelte', name: 'Svelte', extensions: ['svelte'] },
  { id: 'vue', name: 'Vue', extensions: ['vue'] },
  // The seven below are the languages `@codemirror/legacy-modes` already
  // shipped a mode for and Nox opened as plain text anyway. Makefile is not
  // among them: no mode exists, and a language named here with no grammar is
  // what `tests/grammars.test.ts` refuses.
  { id: 'csharp', name: 'C#', extensions: ['cs'], lineComment: '//' },
  { id: 'kotlin', name: 'Kotlin', extensions: ['kt', 'kts'], lineComment: '//' },
  { id: 'swift', name: 'Swift', extensions: ['swift'], lineComment: '//' },
  { id: 'lua', name: 'Lua', extensions: ['lua'], lineComment: '--' },
  { id: 'powershell', name: 'PowerShell', extensions: ['ps1', 'psm1', 'psd1'], lineComment: '#' },
  {
    id: 'ini',
    name: 'INI',
    extensions: ['ini', 'cfg', 'properties'],
    filenames: ['.env', '.editorconfig', '.gitconfig'],
    lineComment: '#',
  },
  {
    id: 'dockerfile',
    name: 'Dockerfile',
    extensions: ['dockerfile'],
    filenames: ['Dockerfile', 'Containerfile'],
    lineComment: '#',
  },
  {
    id: 'plaintext',
    name: 'Plain Text',
    extensions: ['txt', 'text', 'log'],
  },
];

const BY_EXTENSION = new Map<string, LanguageInfo>();
const BY_FILENAME = new Map<string, LanguageInfo>();
const BY_ID = new Map<string, LanguageInfo>();

for (const language of LANGUAGES) {
  BY_ID.set(language.id, language);
  for (const extension of language.extensions) {
    if (!BY_EXTENSION.has(extension)) BY_EXTENSION.set(extension, language);
  }
  for (const filename of language.filenames ?? []) {
    BY_FILENAME.set(filename.toLowerCase(), language);
  }
}

export const PLAINTEXT = BY_ID.get('plaintext')!;

/** Language for a path. Falls back to plaintext; never throws. */
export function detectLanguage(path: string | null): LanguageInfo {
  if (!path) return PLAINTEXT;
  const name = basename(path).toLowerCase();
  const byName = BY_FILENAME.get(name);
  if (byName) return byName;

  // Dotfiles: `.gitignore` has no extension in our model but is still text.
  const extension = extname(path);
  return BY_EXTENSION.get(extension) ?? PLAINTEXT;
}

export function languageById(id: string): LanguageInfo {
  return BY_ID.get(id) ?? PLAINTEXT;
}
