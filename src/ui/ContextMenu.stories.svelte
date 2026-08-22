<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import { fn } from 'storybook/test';
  import ContextMenu from './ContextMenu.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/ContextMenu',
    component: ContextMenu,
    tags: ['autodocs'],
    // The menu positions itself in viewport coordinates and flips near an
    // edge, so it needs the canvas to be the viewport rather than a padded box.
    parameters: { layout: 'fullscreen' },
    args: { anchor: { x: 24, y: 24 }, onSelect: fn(), onDismiss: fn() },
  });
</script>

<!--
  The item sets are lifted from `ExplorerPanel.svelte`'s own menu builder, not
  invented. A workbench showing a menu the app never produces would be worse
  than no story at all.

  The menu is fully keyboard-operable — arrows, Home/End, type-ahead, Enter,
  Escape — and it opens focused, so all of that is reachable from here without
  touching the mouse.
-->
<Story
  name="One file selected"
  args={{
    items: [
      { id: 'explorer.newFile', label: 'New File…' },
      { id: 'explorer.newFolder', label: 'New Folder…' },
      { id: 'explorer.openSelection', label: 'Open', separatorBefore: true },
      { id: 'explorer.rename', label: 'Rename…', hint: 'F2' },
      { id: 'explorer.duplicate', label: 'Duplicate' },
      { id: 'explorer.delete', label: 'Delete…', hint: '⌫', danger: true },
      { id: 'explorer.copyPath', label: 'Copy Path', separatorBefore: true },
      { id: 'explorer.copyRelativePath', label: 'Copy Relative Path' },
      { id: 'explorer.revealInFileManager', label: 'Reveal in File Manager' },
      { id: 'explorer.refresh', label: 'Refresh', separatorBefore: true },
      { id: 'explorer.collapseAll', label: 'Collapse All' },
    ],
  }}
/>

<!--
  Multi-select. `Rename…` and `Reveal` go disabled because renaming several
  things at once needs a pattern UI rather than a prompt — the gap ROADMAP.md
  still lists under v0.2. This is the story to look at when that gets built,
  and the one that shows how a disabled row reads against a danger row.
-->
<Story
  name="Several selected"
  args={{
    items: [
      { id: 'explorer.newFile', label: 'New File…' },
      { id: 'explorer.newFolder', label: 'New Folder…' },
      { id: 'explorer.openSelection', label: 'Open 3 Files', separatorBefore: true },
      { id: 'explorer.rename', label: 'Rename…', hint: 'F2', disabled: true },
      { id: 'explorer.duplicate', label: 'Duplicate 3 Files' },
      { id: 'explorer.delete', label: 'Delete 4 Items…', hint: '⌫', danger: true },
      { id: 'explorer.copyPath', label: 'Copy 4 Paths', separatorBefore: true },
      { id: 'explorer.copyRelativePath', label: 'Copy 4 Relative Paths' },
      { id: 'explorer.revealInFileManager', label: 'Reveal in File Manager', disabled: true },
      { id: 'explorer.refresh', label: 'Refresh', separatorBefore: true },
      { id: 'explorer.collapseAll', label: 'Collapse All' },
    ],
  }}
/>

<!--
  Empty space in the explorer: nothing is selected, so only the create and
  view actions survive. The shortest the menu ever gets.
-->
<Story
  name="Nothing selected"
  args={{
    items: [
      { id: 'explorer.newFile', label: 'New File…' },
      { id: 'explorer.newFolder', label: 'New Folder…' },
      { id: 'explorer.refresh', label: 'Refresh', separatorBefore: true },
      { id: 'explorer.collapseAll', label: 'Collapse All' },
    ],
  }}
/>
