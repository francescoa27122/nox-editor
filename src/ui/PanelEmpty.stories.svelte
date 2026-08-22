<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import PanelEmpty from './PanelEmpty.svelte';

  const { Story } = defineMeta({
    title: 'Sidebar/PanelEmpty',
    component: PanelEmpty,
    tags: ['autodocs'],
  });
</script>

<!--
  These templates pass props literally rather than spreading `args`. The
  component's message *is* its `children` snippet, and spreading args would
  supply a second one — svelte-check calls that out as an overwrite, correctly.

  "Honesty over cheer" is the component's own instruction to callers, so the
  copy here is the copy a panel should actually use: it says what is true and,
  where there is one, offers the way out.
-->
<Story name="Message only">
  {#snippet template()}
    <PanelEmpty>No folder is open.</PanelEmpty>
  {/snippet}
</Story>

<Story name="With a way out">
  {#snippet template()}
    <PanelEmpty action={{ label: 'Open Folder…', run: () => {} }}>
      No folder is open.
    </PanelEmpty>
  {/snippet}
</Story>

<Story name="Two sentences">
  {#snippet template()}
    <PanelEmpty action={{ label: 'Clear filter', run: () => {} }}>
      Nothing matches this filter. The tree still has 1,204 files in it.
    </PanelEmpty>
  {/snippet}
</Story>
