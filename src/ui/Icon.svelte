<script lang="ts" module>
  /**
   * The Nox icon set.
   *
   * Hand-drawn on a 16×16 grid with a 1.4px stroke so everything shares one
   * optical weight. Geometric and minimal — no rounded "friendly" shapes, no
   * filled glyphs except where a filled mark reads better at 16px.
   */
  export type IconName = keyof typeof PATHS;

  const PATHS = {
    'chevron-right': 'M6 3.5 10.5 8 6 12.5',
    'chevron-down': 'M3.5 6 8 10.5 12.5 6',
    folder: 'M2 4.25A1.25 1.25 0 0 1 3.25 3h2.9a1 1 0 0 1 .8.4l.9 1.2h5.15A1.25 1.25 0 0 1 14 5.85v6.4A1.25 1.25 0 0 1 12.75 13.5h-9.5A1.25 1.25 0 0 1 2 12.25Z',
    file: 'M4 2.5h4.6L12 5.9v7.6H4Z M8.5 2.5v3.6H12',
    // A page with ruled lines and deliberately no folded corner, so it does
    // not read as `file` at the rail's 15px.
    note: 'M3.5 2.5h9v11h-9Z M5.75 6h4.5M5.75 8.5h4.5M5.75 11h2.75',
    // A pushpin seen side-on rather than the head-on circle-and-dot: at 12px
    // the head-on version is a dot with a ring and reads as a bullet or a
    // radio button, neither of which suggests "held at the top".
    pin: 'M5.5 2.5h5 M6.6 2.5v4.2c0 .9-.6 1.5-1.5 1.9h5.8c-.9-.4-1.5-1-1.5-1.9V2.5 M8 8.6v4.9',
    // `close` was the alternative and is wrong: it means "dismiss this"
    // everywhere else, and delete here is permanent.
    trash: 'M3 4.5h10 M6.25 4.5V2.9a.4.4 0 0 1 .4-.4h2.7a.4.4 0 0 1 .4.4v1.6 M4.6 4.5l.5 8.2a.8.8 0 0 0 .8.8h4.2a.8.8 0 0 0 .8-.8l.5-8.2',
    close: 'M4 4l8 8M12 4l-8 8',
    // The three window controls, for the Windows build that draws its own.
    // Squarer and flatter than the rest of the set on purpose: these sit
    // where the OS would have drawn them, and every other platform's look
    // like this. `close` above is reused as the third.
    minimize: 'M4 8h8',
    maximize: 'M4 4h8v8H4Z',
    restore: 'M4 6.5h5.5V12H4Z M6.5 6.5V4H12v5.5H9.5',
    plus: 'M8 3.5v9M3.5 8h9',
    search: 'M7.25 11.5a4.25 4.25 0 1 0 0-8.5 4.25 4.25 0 0 0 0 8.5ZM10.4 10.4 13.5 13.5',
    // A dotted list of places — the References view. Added so it stops
    // sharing `search` with the Search view one button over.
    references: 'M6 4.5h7.5M6 8h7.5M6 11.5h7.5 M2.7 4.5h.1M2.7 8h.1M2.7 11.5h.1',
    replace:
      'M2.5 5.5h5.2a2.8 2.8 0 0 1 0 5.6H5.5 M4 4l-1.5 1.5L4 7 M9.5 10h4M9.5 13h4',
    'arrow-up': 'M8 12.5v-9M4.25 7.25 8 3.5l3.75 3.75',
    'arrow-down': 'M8 3.5v9M4.25 8.75 8 12.5l3.75-3.75',
    refresh:
      'M13 8a5 5 0 1 1-1.6-3.66 M13 2.6v2.9h-2.9',
    collapse: 'M4 6.5 8 3l4 3.5M4 12.5 8 9l4 3.5',
    settings:
      'M8 10.1a2.1 2.1 0 1 0 0-4.2 2.1 2.1 0 0 0 0 4.2Z M8 1.6l.9 1.6 1.8-.3.5 1.8 1.7.7-.6 1.7.6 1.7-1.7.7-.5 1.8-1.8-.3L8 14.4l-.9-1.6-1.8.3-.5-1.8-1.7-.7.6-1.7-.6-1.7 1.7-.7.5-1.8 1.8.3Z',
    sidebar: 'M2.5 3.5h11v9h-11Z M6.5 3.5v9',
    command: 'M5.5 3.5a1.5 1.5 0 1 0 1.5 1.5v6a1.5 1.5 0 1 0 1.5-1.5H5.5',
    dot: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    warning: 'M8 2.6 14.5 13.4h-13Z M8 6.6v3.2 M8 11.6v.1',
    error: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2',
    check: 'M3.5 8.5 6.5 11.5 12.5 4.5',
    info: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z M8 7.4v3.8 M8 5.1v.1',
    'case-sensitive': 'M2 12 5 4l3 8M3 9.6h4M10 12a2 2 0 1 1 0-4h2.5v3.5 M12.5 7.5V12',
    'whole-word': 'M2.5 4.5v7M13.5 4.5v7M5 10.5 7 5.5l2 5M5.6 9h2.8',
    regex: 'M8 4v6M5.4 5.2l5.2 3.6M10.6 5.2 5.4 8.8 M4 12.4h.1',
    keyboard: 'M1.5 4.5h13v7h-13Z M4 7h.1M6.4 7h.1M8.8 7h.1M11.2 7h.1M4.5 9.4h7',
    // Two commits on a trunk and one on a branch, joined by the curve —
    // the universal "branch" glyph, drawn in this set's stroke style.
    branch: 'M5 4.25h.1 M5 6.5v5.25h.1 M11 4.25h.1 M11 6.5c0 3-6 2.25-6 5',
    // Unstage. `minimize` is the same stroke but means "window control".
    minus: 'M3.5 8h9',
    logo: '',
  } as const;

  const FILLED = new Set<string>(['dot', 'folder']);
</script>

<script lang="ts">
  interface Props {
    name: IconName;
    size?: number;
    class?: string;
    strokeWidth?: number;
  }

  let { name, size = 16, class: className = '', strokeWidth = 1.4 }: Props = $props();
</script>

{#if name === 'logo'}
  <!-- The Nox mark: a crescent carved from a disc by an offset disc. -->
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    class="nox-icon {className}"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <mask id="nox-crescent">
        <rect width="16" height="16" fill="black" />
        <circle cx="8" cy="8" r="6" fill="white" />
        <circle cx="11.4" cy="6" r="5.2" fill="black" />
      </mask>
    </defs>
    <circle cx="8" cy="8" r="6" fill="currentColor" mask="url(#nox-crescent)" />
  </svg>
{:else}
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    class="nox-icon {className}"
    aria-hidden="true"
    focusable="false"
    fill={FILLED.has(name) ? 'currentColor' : 'none'}
    stroke="currentColor"
    stroke-width={FILLED.has(name) ? 0 : strokeWidth}
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d={PATHS[name]} />
  </svg>
{/if}

<style>
  .nox-icon {
    display: block;
    flex: none;
  }
</style>
