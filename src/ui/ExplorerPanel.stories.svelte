<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import NoxContext from '../../.storybook/NoxContext.svelte';
  import PanelFrame from '../../.storybook/PanelFrame.svelte';
  import ExplorerPanel from './ExplorerPanel.svelte';

  const { Story } = defineMeta({
    title: 'Panels/ExplorerPanel',
    component: ExplorerPanel,
    // No autodocs: the component takes no props, so a generated prop table
    // would be an empty heading. What it takes is the app context, and the
    // wrapper documents that better than a table would.
    parameters: { layout: 'fullscreen' },
  });
</script>

<!--
  The proof that a context-bound panel renders outside the shell.

  Everything the explorer reaches for — workspace, files, git, ui, commands —
  arrives through one `useApp()`, so one wrapper is the entire cost of getting
  it onto a canvas. The tree it shows is `demo-workspace.ts`, the same
  in-memory project `npm run dev` boots into, which is what stops this story
  and the browser dev target from drifting apart.
-->
<Story name="Demo workspace">
  {#snippet template()}
    <PanelFrame>
      <NoxContext>
        <ExplorerPanel />
      </NoxContext>
    </PanelFrame>
  {/snippet}
</Story>
