<script lang="ts">
  import { untrack, type Component } from 'svelte';
  import type { NoxApp } from '../../src/app';
  import { provideApp } from '../../src/ui/context';

  /**
   * Puts a real `NoxApp` into Svelte context, the way `App.svelte` does, and
   * renders one component under it, spreading `props` onto it.
   *
   * This exists because `context.ts`'s `KEY` is a module-private `Symbol` —
   * on purpose, so nothing outside `context.ts` can set context directly.
   * Going through `provideApp` here, instead of exporting `KEY` and passing a
   * `context` map to `mount`, keeps that private for tests too.
   *
   * Typed loosely, at `Record<string, unknown>` rather than a generic
   * parameter of its own: `mountComponent` in `component.ts` is the one with
   * the precisely-typed public signature (a generic overload), and it is
   * also the one place that widening from the caller's real prop type down
   * to this component's prop type is checked. Giving `Harness` its own
   * generic parameter `P` would not help here — `P` is opaque inside this
   * file, so `{...(props ?? {})}` below would still be spreading a
   * `Record<string, unknown>`-shaped value onto it, and `svelte-check`
   * rejects that at the spread with "Type '{ [x: string]: unknown; }' is not
   * assignable to type 'P'": you cannot manufacture a value of an unknown
   * type parameter, generic or not.
   */
  let {
    app,
    component: Rendered,
    props,
  }: { app: NoxApp; component: Component<Record<string, unknown>>; props?: Record<string, unknown> } =
    $props();

  // `app` is supplied once by the caller and never reassigned for the life of
  // this mount, so reading it now is correct rather than a missed reactive
  // read. `untrack` says so, instead of leaving `state_referenced_locally`
  // for the next reader to puzzle over.
  provideApp(untrack(() => app));
</script>

<Rendered {...(props ?? {})} />
