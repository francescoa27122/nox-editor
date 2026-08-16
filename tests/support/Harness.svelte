<script lang="ts">
  import { untrack, type Component } from 'svelte';
  import type { NoxApp } from '../../src/app';
  import { provideApp } from '../../src/ui/context';

  /**
   * Puts a real `NoxApp` into Svelte context, the way `App.svelte` does, and
   * renders one component under it with no props.
   *
   * This exists because `context.ts`'s `KEY` is a module-private `Symbol` —
   * on purpose, so nothing outside `context.ts` can set context directly.
   * Going through `provideApp` here, instead of exporting `KEY` and passing a
   * `context` map to `mount`, keeps that private for tests too.
   */
  let {
    app,
    component: Rendered,
  }: { app: NoxApp; component: Component<Record<string, never>> } = $props();

  // `app` is supplied once by the caller and never reassigned for the life of
  // this mount, so reading it now is correct rather than a missed reactive
  // read. `untrack` says so, instead of leaving `state_referenced_locally`
  // for the next reader to puzzle over.
  provideApp(untrack(() => app));
</script>

<Rendered />
