import type { Platform } from './types';
import { WebPlatform } from './web';

export * from './types';
export { MemoryPlatform } from './memory';
export { WebPlatform } from './web';

/** True when running inside a Tauri window rather than a plain browser. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Resolve the platform for this runtime. The Tauri implementation is imported
 * dynamically so the browser build never pulls `@tauri-apps/*` into its bundle.
 */
export async function createPlatform(): Promise<Platform> {
  if (isTauri()) {
    const { TauriPlatform } = await import('./tauri');
    return new TauriPlatform();
  }
  return new WebPlatform();
}
