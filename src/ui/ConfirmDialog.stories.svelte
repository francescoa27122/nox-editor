<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import { fn } from 'storybook/test';
  import ConfirmDialog from './ConfirmDialog.svelte';

  const { Story } = defineMeta({
    title: 'Dialogs/ConfirmDialog',
    component: ConfirmDialog,
    tags: ['autodocs'],
  });
</script>

<!--
  Rendered bare rather than over a scrim: `Overlays.svelte` owns the backdrop,
  and this is the dialog on its own. What each story is really showing is which
  button took focus, because that is the component's one genuinely subtle
  behaviour and the only way to see it is to look.
-->

<!--
  Enter must not destroy. `Don't Save` carries `danger`, so the default falls to
  the first safe choice — Save — with no `defaultChoiceId` needed.
-->
<Story
  name="Unsaved changes"
  args={{
    request: {
      title: 'Save changes to README.md?',
      message: 'Your changes will be lost if you don’t save them.',
      choices: [
        { id: 'save', label: 'Save' },
        { id: 'discard', label: 'Don’t Save', danger: true },
        { id: 'cancel', label: 'Cancel' },
      ],
      resolve: fn(),
    },
  }}
/>

<!--
  The case the component's own comment says broke inference, kept as a story so
  it cannot regress unseen: two grants and a refusal, with `danger` on Deny —
  the *safe* answer. Position and `danger` alone would both put the keyboard on
  "Allow for Session", so `defaultChoiceId` names Deny explicitly. Enter must
  never grant a capability.
-->
<Story
  name="Permission prompt"
  args={{
    request: {
      title: 'Allow “review-agent” to write files?',
      message: 'It is asking to modify 3 files under src/services.',
      choices: [
        { id: 'once', label: 'Allow Once' },
        { id: 'session', label: 'Allow for Session' },
        { id: 'deny', label: 'Deny', danger: true },
      ],
      defaultChoiceId: 'deny',
      resolve: fn(),
    },
  }}
/>

<Story
  name="Destructive"
  args={{
    request: {
      title: 'Delete 4 items?',
      message: 'They will be moved to the Trash.',
      choices: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'delete', label: 'Delete', danger: true },
      ],
      resolve: fn(),
    },
  }}
/>

<!--
  Two words and no message. Worth having because the dialog has no minimum
  width of its own, and a short one is where that shows.
-->
<Story
  name="Terse"
  args={{
    request: {
      title: 'Discard?',
      message: '',
      choices: [
        { id: 'no', label: 'No' },
        { id: 'yes', label: 'Yes', danger: true },
      ],
      resolve: fn(),
    },
  }}
/>
