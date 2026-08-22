<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import Gallery from '../../.storybook/Gallery.svelte';
  import Icon, { ICON_NAMES } from './Icon.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/Icon',
    component: Icon,
    tags: ['autodocs'],
    args: { name: 'folder', size: 16, strokeWidth: 1.4 },
    argTypes: {
      name: { control: 'select', options: ICON_NAMES },
      size: { control: { type: 'range', min: 10, max: 64, step: 1 } },
      strokeWidth: { control: { type: 'range', min: 0.5, max: 3, step: 0.1 } },
    },
  });
</script>

<Story name="Single" />

<!--
  The gallery is generated from ICON_NAMES rather than a list restated here, so
  a new icon appears in it the moment it is drawn. DESIGN.md §1 claims one
  optical weight across the set; this is where that claim is checkable at a
  glance, and where an icon drawn at the wrong weight stops being subtle.

  Turning the stroke-width control up exaggerates the difference, which is the
  fastest way to see whether a new path really is on the same 16×16 grid.
-->
<Story name="Gallery" args={{ size: 24 }}>
  {#snippet template(args)}
    <Gallery items={ICON_NAMES}>
      {#snippet cell(name)}
        <Icon {...args} name={name as typeof ICON_NAMES[number]} />
      {/snippet}
    </Gallery>
  {/snippet}
</Story>
