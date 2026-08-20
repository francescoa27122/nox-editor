// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import SettingsPanel from '../src/ui/SettingsPanel.svelte';
import { mountComponent, type Mounted } from './support/component';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('the Settings footer', () => {
  it('shows the version this build was made from', () => {
    // The release gate holds package.json, tauri.conf.json and Cargo.toml
    // to one version, so package.json's — which the define reads — is the
    // bundle's.
    expect(__APP_VERSION__).toMatch(/^\d+\.\d+\.\d+/);
    mounted = mountComponent(SettingsPanel, {});
    expect(mounted.container.textContent).toContain(`Nox ${__APP_VERSION__}`);
  });
});
