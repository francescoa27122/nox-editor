import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import svelteParser from 'svelte-eslint-parser';
import tseslint from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

/**
 * What this file is for, and what it deliberately is not.
 *
 * **It is not a formatter.** Three plan documents in `docs/superpowers/plans/`
 * say plainly "do not run prettier — this repo has no prettier config, and
 * running it rewrites the file to double quotes against house style". That
 * decision stands: single quotes, two-space indent and semicolons are matched
 * by hand, and nothing here has an opinion about whitespace. Every stylistic
 * rule is left to review, which is where it has always been.
 *
 * **It is for the rules a reviewer cannot be relied on to hold forever.** The
 * layering in ARCHITECTURE.md §2 has always been enforced by review alone —
 * CLAUDE.md says so in as many words: "Nothing lints this — it holds by
 * review." It held, which is the surprising part; a grep across all 41k lines
 * of `src/` finds zero violations of any of the four boundaries. This file is
 * what keeps that true on a day when the reviewer is tired, or is a stranger,
 * or is a program.
 */

/**
 * Everything under `src/` that is not the one directory allowed to touch the OS.
 *
 * Split into `files` plus `ignores` rather than a `!src/platform/**` entry in
 * `files`: flat config does not read a leading `!` inside `files` as a
 * negation, so that spelling silently matched `platform/` too and reported
 * `tauri.ts` — the one file whose whole job is importing Tauri — as a
 * violation of the rule it implements.
 */
const OUTSIDE_PLATFORM = {
  files: ['src/**/*.ts', 'src/**/*.svelte'],
  ignores: ['src/platform/**'],
};

/**
 * Rule 2 of CONTRIBUTING.md, as a lint rule.
 *
 * The written rule names `ui/`, `services/` and `core/`, but its stated reason
 * — "it is what lets the app run in a browser" — applies just as much to
 * `editor/` and to `app.ts`, and both are already clean. So the restriction is
 * "everywhere but `platform/`", which is the same rule stated from the other
 * side and is the form that cannot go stale when a directory is added.
 */
const NO_TAURI = {
  group: ['@tauri-apps/*', '@tauri-apps/**'],
  message:
    'Only src/platform/ may touch the OS. Add a method to the Platform interface and implement it in tauri.ts and memory.ts — see CONTRIBUTING.md rule 2.',
};

/**
 * The half of rule 2 that is not an import.
 *
 * `localStorage` is a global, so it reaches past a module boundary without an
 * import statement to catch it. `web.ts` is the only legitimate caller, and it
 * lives in `platform/`.
 */
const NO_LOCAL_STORAGE_MESSAGE =
  'Only src/platform/ may touch localStorage — it is what lets every service be tested against a fake disk. See CONTRIBUTING.md rule 2.';

export default tseslint.config(
  {
    // `dist/` and the bundled grammars are build output; `e2e/` is a separate
    // npm package with its own dependency tree, and linting it from here
    // would resolve its imports against the wrong node_modules.
    ignores: [
      'dist/**',
      'node_modules/**',
      'e2e/**',
      'src-tauri/**',
      'storybook-static/**',
      'examples/**',
      'scripts/window-id/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // Match `tsconfig.json`'s own convention. `noUnusedLocals` and
      // `noUnusedParameters` are both on, and TypeScript exempts a leading
      // underscore; a linter that disagreed would be asking for a rename
      // TypeScript would then object to.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      /**
       * A warning, not an error, and the distinction is the point.
       *
       * Nine places in `services/` open a `let` with a defensive initializer
       * and overwrite it inside a `try`. The rule is right that the
       * initializer is dead — and it is also the thing that stops TypeScript
       * complaining about a read before assignment on the early-return paths.
       * Changing all nine inside `workspace.ts`, the file that owns unsaved
       * work, is its own change with its own reasoning; it is not a thing to
       * do in passing while installing a linter.
       */
      'no-useless-assignment': 'warn',
    },
  },

  // Type-aware rules, TypeScript files only. `.svelte` is deliberately left
  // out of this pass: type-aware linting across the Svelte parser needs the
  // project service to understand a virtual file per component, and the
  // payoff there is small — `npm run check` already type-checks components
  // through svelte-check, which is the tool that actually understands runes.
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'bench/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /**
       * The one type-aware rule this codebase most needs, and the one place it
       * has to be a warning rather than an error.
       *
       * `CommandRegistry.execute` reports *and* rethrows, and app.ts documents
       * that "nearly every call site discards the promise" on purpose — the
       * rejection backstop is what catches them. So a blanket error would
       * fail on deliberate code. Left on as a warning so a genuinely forgotten
       * `await` is still visible in the output.
       */
      '@typescript-eslint/no-floating-promises': 'warn',
      // Same reasoning: an event handler that returns a promise is how every
      // async command reaches a button, and the alternative is a wrapper
      // around every one of them.
      '@typescript-eslint/no-misused-promises': 'off',
      /**
       * Off, and not reluctantly.
       *
       * 179 of the first run's 441 findings were this one rule, and every one
       * of them was correct code: `Platform` is an async interface, and an
       * implementation that can answer synchronously — most of `memory.ts`,
       * every no-op in a fake — still has to return a promise to satisfy it.
       * The rule wants those written `Promise.resolve(x)` instead, which is
       * the same thing spelled worse. A rule that is wrong 179 times out of
       * 179 does not get to be the reason nobody reads the output.
       */
      '@typescript-eslint/require-await': 'off',
    },
  },

  ...svelte.configs.recommended,
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tseslint.parser,
        svelteConfig,
      },
      globals: globals.browser,
    },
    rules: {
      // svelte-check already reports a11y against the compiler's own rules,
      // and the codebase silences a handful of them with `svelte-ignore` plus
      // a written reason. eslint-plugin-svelte's copies do not read those
      // comments, so leaving them on would report, twice, findings that were
      // already argued for in the file.
      'svelte/no-at-html-tags': 'error',
      'svelte/require-each-key': 'error',
      'svelte/valid-each-key': 'error',
      /**
       * Off, on the evidence.
       *
       * All four places it fired build a `Set` or `Map` *inside* a
       * `$derived.by()` and return it — `ExplorerPanel`'s open/dirty path
       * sets, its git-letter map, `SettingsPanel`'s category grouping. None
       * is state that is mutated later; the derived re-runs and builds a
       * fresh one. `SvelteSet`/`SvelteMap` there would add a reactive proxy
       * to a value that is thrown away on the next recompute, which costs
       * something on a path `ExplorerPanel` documents as running per
       * keystroke.
       */
      'svelte/prefer-svelte-reactivity': 'off',
    },
  },

  {
    files: ['src/**/*.ts', 'src/**/*.svelte'],
    languageOptions: {
      globals: { ...globals.browser, __APP_VERSION__: 'readonly' },
    },
  },

  // ---------------------------------------------------------------------
  // The four boundaries. This is the part of the file that earns its keep.
  // ---------------------------------------------------------------------

  {
    name: 'nox/platform-is-the-only-door',
    ...OUTSIDE_PLATFORM,
    rules: {
      // Only the typescript-eslint version. Enabling the base rule as well
      // reports every violation twice, which is how the first run of this
      // config turned seven imports into fourteen errors.
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [NO_TAURI] }],
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: NO_LOCAL_STORAGE_MESSAGE },
        { name: 'sessionStorage', message: NO_LOCAL_STORAGE_MESSAGE },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'localStorage', message: NO_LOCAL_STORAGE_MESSAGE },
        { object: 'window', property: 'sessionStorage', message: NO_LOCAL_STORAGE_MESSAGE },
        { object: 'globalThis', property: 'localStorage', message: NO_LOCAL_STORAGE_MESSAGE },
      ],
    },
  },

  {
    /**
     * The rule that keeps `services/` and `core/` runnable headless.
     *
     * They use `@codemirror/state` and `@codemirror/commands` deliberately —
     * `workspace.ts` owns an `EditorState` per buffer, which is what makes
     * per-tab undo work. `@codemirror/view` is the one that drags in a DOM,
     * and it is the reason 138 test files run in Node in 23 seconds.
     */
    name: 'nox/headless-services',
    files: ['src/core/**/*.ts', 'src/services/**/*.ts'],
    rules: {
      /**
       * `NO_TAURI` is repeated here, and it has to be.
       *
       * Flat config *replaces* a rule's options when a later block names the
       * same rule — it does not merge them. So this block, which matches
       * every file `nox/platform-is-the-only-door` matches, silently dropped
       * that block's Tauri pattern for the whole of `services/` and `core/`.
       * A planted `import { invoke } from '@tauri-apps/api/core'` in
       * `services/jobs.ts` went unreported until this line was added; the
       * `core/` and `ui/` probes beside it were caught the whole time, which
       * is what made the hole hard to see.
       */
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            NO_TAURI,
            {
              group: ['@codemirror/view'],
              message:
                'services/ and core/ must run headless under Vitest. CodeMirror extensions live in src/editor/ — see CLAUDE.md.',
            },
          ],
        },
      ],
    },
  },

  {
    /**
     * Components render state and forward input; an `if` about *what should
     * happen* belongs in a service (CONTRIBUTING.md rule 1). That one is not
     * mechanically checkable, but its most common concrete symptom is — a
     * component reaching for the OS or constructing its own platform.
     */
    name: 'nox/components-do-not-construct-services',
    files: ['src/ui/**/*.svelte'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            NO_TAURI,
            {
              group: ['@platform/index', '**/platform/index'],
              message:
                'Components receive the platform through useApp(), never by constructing one. See CONTRIBUTING.md rule 1.',
            },
          ],
        },
      ],
    },
  },

  {
    /**
     * Tests reach into internals on purpose.
     *
     * The `no-unsafe-*` family is off here for one reason: a test double is
     * untyped at exactly the seam the rule watches. `tests/support/` hands
     * components a hand-built app object and the suite asserts against
     * `unknown` payloads coming back off a fake wire — that is what a fake
     * *is*. Those rules stay **on** for `src/`, which is where an `any`
     * leaking through a boundary would actually mean something.
     */
    files: ['tests/**/*.ts', 'tests/**/*.mjs', '.storybook/**/*.ts', '**/*.stories.svelte'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // `expect(fn).toHaveBeenCalled()` passes a method reference by design,
      // which is the entire pattern this rule exists to flag.
      '@typescript-eslint/unbound-method': 'off',
      // Awaiting a fake that resolves synchronously is how a test drives a
      // seam that is async in the real implementation.
      '@typescript-eslint/await-thenable': 'off',
    },
  },

  {
    // Config and tooling files at the root run in Node, not the browser.
    files: ['*.js', '*.mjs', '*.ts', '.storybook/**/*.{js,ts}', 'scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
    rules: {
      // vite.config.ts and friends are not part of the app's type-checked
      // program, so type-aware rules have no types to work from here.
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
);
