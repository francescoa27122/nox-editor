<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import PanelHeader from './PanelHeader.svelte';

  const { Story } = defineMeta({
    title: 'Sidebar/PanelHeader',
    component: PanelHeader,
    tags: ['autodocs'],
    args: { title: 'EXPLORER' },
  });
</script>

<Story name="Plain" />

<Story name="With summary" args={{ title: 'PROBLEMS', summary: '3 errors, 1 warning' }} />

<Story name="With actions" args={{ title: 'SOURCE CONTROL', summary: '2 staged' }}>
  {#snippet template(args)}
    <PanelHeader {...args}>
      {#snippet actions()}
        <button class="nox-button ghost small" type="button">Stage all</button>
        <button class="nox-button ghost small" type="button">Refresh</button>
      {/snippet}
    </PanelHeader>
  {/snippet}
</Story>

<!--
  The header is one fixed-height row (--nox-panelbar-h) shared with the tab bar
  so the two columns keep a baseline at the seam. A title long enough to fight
  the summary for that row is the case worth being able to look at, because
  nothing in the component's own tests can see it.
-->
<Story
  name="Overlong title"
  args={{ title: 'A PANEL WITH A NAME NOBODY WOULD CHOOSE', summary: '128 items' }}
/>
