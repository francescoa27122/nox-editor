<script lang="ts">
  import type { Snippet } from 'svelte';
  import { NoxApp } from '../src/app';
  import NoxProvider from './NoxProvider.svelte';

  /**
   * Gives a panel story the app context its component reaches for through
   * `useApp()`.
   *
   * This builds a *real* `NoxApp`, not a fake. `NoxApp.create()` resolves the
   * platform via `createPlatform()`, which outside Tauri is `WebPlatform` over
   * the in-memory filesystem — so a story runs the services that ship, against
   * a fake disk, with no mocking library anywhere. That is the Platform rule in
   * CLAUDE.md paying for itself: the browser target already existed, so panels
   * became renderable in isolation at no extra cost.
   *
   * One caveat before trusting a story: `WebPlatform` persists config and
   * session to localStorage, so state survives a preview reload. A story that
   * depends on a particular starting state must arrange it rather than assume
   * a clean one.
   */
  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();

  const ready = NoxApp.create();
</script>

{#await ready}
  <p class="status">Starting Nox services…</p>
{:then app}
  <NoxProvider {app}>{@render children()}</NoxProvider>
{:catch error}
  <p class="status failed">Nox services failed to start: {String(error)}</p>
{/await}

<style>
  .status {
    margin: 0;
    padding: var(--nox-sp-5);
    color: var(--nox-text-muted);
    font-family: var(--nox-font-ui);
    font-size: var(--nox-fs-sm);
  }

  .failed {
    color: var(--nox-danger);
  }
</style>
