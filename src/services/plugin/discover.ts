import { parseManifest } from '@core/plugin-manifest';
import { join } from '@core/path';
import type { Platform } from '@platform/types';
import { CAPABILITIES } from '../permissions';
import type { DiscoveredPlugin, PluginConnection } from './host';

/**
 * Finding plugins, and opening a pipe to one.
 *
 * Split from `host.ts` for the reason `stdio.ts` is split from the agent
 * runtime: this is the only part that touches a filesystem or starts
 * anything, so keeping it here leaves the host testable against a `connect`
 * function and a fake.
 */

/** The folder inside the config directory that plugins live in. */
export const PLUGINS_DIRECTORY = 'plugins';

/** The file that makes a folder a plugin. */
export const MANIFEST_FILE = 'plugin.json';

export interface Discovery {
  plugins: DiscoveredPlugin[];
  /**
   * One sentence per folder that could not be loaded.
   *
   * Named rather than counted, and surfaced rather than swallowed: a plugin
   * that silently does not appear is indistinguishable from one that appeared
   * and does nothing, and the second is much harder to debug.
   */
  problems: string[];
}

/**
 * Every plugin in the config directory.
 *
 * A missing `plugins/` folder is not a problem — it is the state everyone
 * starts in. A folder without a `plugin.json` is skipped in silence too:
 * people keep notes and disabled copies next to their plugins, and complaining
 * about every one of them would train the user to ignore the message that
 * matters.
 */
export async function discoverPlugins(platform: Platform): Promise<Discovery> {
  const problems: string[] = [];
  const plugins: DiscoveredPlugin[] = [];

  const configDirectory = await platform.configDir().catch(() => null);
  if (configDirectory === null) return { plugins, problems };

  const root = join(configDirectory, PLUGINS_DIRECTORY);
  const entries = await platform.readDir(root).catch(() => null);
  if (entries === null) return { plugins, problems };

  const known = new Set<string>(CAPABILITIES);

  for (const entry of entries) {
    if (!entry.isDirectory) continue;

    const manifestPath = join(entry.path, MANIFEST_FILE);
    const raw = await platform.readTextFile(manifestPath).catch(() => null);
    if (raw === null) continue;

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      problems.push(
        `${entry.name}/${MANIFEST_FILE} is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    const parsed = parseManifest(value, known);
    if (!parsed.ok) {
      problems.push(`${entry.name}: ${parsed.reason}`);
      continue;
    }

    // The folder name is not the id. A plugin declares its own, and the id is
    // what every command, policy key and log line is written against — so a
    // folder renamed on disk must not silently become a different plugin with
    // different grants.
    if (plugins.some((existing) => existing.manifest.id === parsed.manifest.id)) {
      problems.push(`${entry.name}: a plugin with id "${parsed.manifest.id}" is already loaded`);
      continue;
    }

    problems.push(...parsed.problems.map((problem) => `${parsed.manifest.id}: ${problem}`));
    plugins.push({ manifest: parsed.manifest, directory: entry.path });
  }

  return { plugins, problems };
}

/**
 * Open a pipe to a plugin.
 *
 * Both transports come back as the same thing — an object that moves lines —
 * which is the whole reason `PluginConnection` is `AgentProcess`'s shape. A
 * child process satisfies it as-is; a worker satisfies it because
 * `startPluginWorker` adapts it behind the `Platform` boundary.
 */
export function connectorFor(platform: Platform) {
  return async (plugin: DiscoveredPlugin): Promise<PluginConnection> => {
    const { manifest, directory } = plugin;

    if (manifest.entry.kind === 'process') {
      return await platform.spawnAgent({
        command: manifest.entry.command,
        ...(manifest.entry.args ? { args: manifest.entry.args } : {}),
        // Its own folder, so a plugin can find files it shipped beside itself.
        cwd: directory,
      });
    }

    const file = join(directory, manifest.entry.file);
    const source = await platform.readTextFile(file);
    return await platform.startPluginWorker({ source, label: manifest.label });
  };
}
