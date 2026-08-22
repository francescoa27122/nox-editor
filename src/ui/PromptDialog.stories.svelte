<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import { fn } from 'storybook/test';
  import PromptDialog from './PromptDialog.svelte';

  const { Story } = defineMeta({
    title: 'Dialogs/PromptDialog',
    component: PromptDialog,
    tags: ['autodocs'],
  });
</script>

<!--
  Every story here opens with the field focused and a selection already made —
  that is the behaviour worth watching. `selectTo` is what keeps a rename from
  eating the file extension, and it is invisible in any test that does not have
  a real caret.
-->
<Story
  name="Rename a file"
  args={{
    request: {
      title: 'Rename',
      label: 'src/services/workspace.ts',
      initialValue: 'workspace.ts',
      confirmLabel: 'Rename',
      // The stem only, so typing replaces the name and keeps `.ts`.
      selectTo: 'workspace'.length,
      resolve: fn(),
    },
  }}
/>

<!--
  No `selectTo`, so the whole value is selected. The difference between this
  story and the one above is the entire point of the prop.
-->
<Story
  name="Save as"
  args={{
    request: {
      title: 'Save As',
      label: 'Untitled buffer',
      initialValue: 'untitled.md',
      placeholder: 'File name',
      confirmLabel: 'Save',
      resolve: fn(),
    },
  }}
/>

<!--
  The error only appears once the field has been touched, so this story looks
  clean until you clear it or type a slash — which is the behaviour to check.
-->
<Story
  name="With validation"
  args={{
    request: {
      title: 'New File',
      label: 'src/ui',
      initialValue: '',
      placeholder: 'File name',
      confirmLabel: 'Create',
      validate: (value: string) => {
        if (value.trim() === '') return 'A name is required.';
        if (value.includes('/')) return 'A name cannot contain “/”.';
        return null;
      },
      resolve: fn(),
    },
  }}
/>

<!--
  An empty prompt with no label: the smallest the dialog gets.
-->
<Story
  name="Bare"
  args={{
    request: {
      title: 'Go to Line',
      initialValue: '',
      placeholder: 'Line number',
      confirmLabel: 'Go',
      resolve: fn(),
    },
  }}
/>
