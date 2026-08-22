<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import type { NoxApp } from '../src/app';
  import { provideApp } from '../src/ui/context';

  interface Props {
    app: NoxApp;
    children: Snippet;
  }

  let { app, children }: Props = $props();

  // Must run during initialisation: `setContext` is illegal once the component
  // has awaited anything. That is the entire reason this is a second component
  // instead of an `{#await}` block inside NoxContext.
  //
  // `untrack` because context is set exactly once and a story never swaps its
  // app for another — so reading the initial value is the intent, not the bug
  // Svelte warns about when a prop is dereferenced outside a closure.
  untrack(() => provideApp(app));
</script>

{@render children()}
