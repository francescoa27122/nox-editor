import { MemoryPlatform } from './memory';
import type { PlatformCapabilities } from './types';
import { DEMO_WORKSPACE, DEMO_ROOT } from './demo-workspace';

const CONFIG_PREFIX = 'nox:config:';

/**
 * Browser target. An in-memory workspace with settings persisted to
 * localStorage, so `npm run dev` gives a fully usable Nox without a Rust
 * build. Edits to files are intentionally not persisted — the browser target
 * is for developing the UI, not for storing your work.
 */
export class WebPlatform extends MemoryPlatform {
  override readonly capabilities: PlatformCapabilities = {
    nativeDialogs: false,
    windowTitle: true,
    persistentStorage: false,
    // Inherited from MemoryPlatform: watching reports changes Nox itself
    // makes. There is no external writer in a browser tab, but the wiring is
    // identical, which keeps the dev target honest.
    fileWatching: true,
    recoverableDelete: false,
    revealInFileManager: false,
    externalFileDrop: false,
    projectSearch: true,
    // A browser tab has no processes to start; see `MemoryPlatform.spawnAgent`.
    agentProcesses: false,
    // …and no pty. The panel says so rather than showing a dead terminal.
    terminals: false,
    // No model server reachable from a browser tab either; see
    // `MemoryPlatform.streamJsonLines`.
    localModels: false,
    // Inherited refusals from MemoryPlatform cover the methods; this is the
    // flag callers are told to check first.
    languageServers: false,
    // No git binary in a browser tab. `MemoryPlatform.gitFileBase` still
    // answers from whatever a test seeded, which is a lookup, not a lie.
    gitState: false,
    customWindowControls: false,
  };

  constructor() {
    super({ home: '/home/nox' });
    for (const [path, contents] of Object.entries(DEMO_WORKSPACE)) {
      this.seedFile(path, contents);
    }
  }

  /** The folder the browser build opens on launch. */
  get demoRoot(): string {
    return DEMO_ROOT;
  }

  override async pickFolder(): Promise<string | null> {
    return DEMO_ROOT;
  }

  override async readConfigFile(name: string): Promise<string | null> {
    try {
      return globalThis.localStorage?.getItem(CONFIG_PREFIX + name) ?? null;
    } catch {
      return null;
    }
  }

  override async writeConfigFile(name: string, contents: string): Promise<void> {
    try {
      globalThis.localStorage?.setItem(CONFIG_PREFIX + name, contents);
    } catch {
      /* Private browsing or a full quota — settings simply do not persist. */
    }
  }

  override async onCloseRequested(handler: () => Promise<void>): Promise<() => void> {
    // `pagehide` rather than `beforeunload`: it fires on the paths that
    // actually lose the tab, including mobile background eviction. Nothing
    // awaits the handler here, which is fine only because this target's
    // writes land in localStorage synchronously.
    const onHide = () => void handler();
    globalThis.addEventListener?.('pagehide', onHide);
    return () => globalThis.removeEventListener?.('pagehide', onHide);
  }
}
