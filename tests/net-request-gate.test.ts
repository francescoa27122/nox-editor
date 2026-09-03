import { describe, expect, it, vi } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import type { PlatformCapabilities } from '../src/platform/types';
import { AGENTS_FILE } from '../src/services/agent/config';
import { CAPABILITIES, type Principal, type PromptAnswer } from '../src/services/permissions';

/**
 * Every command that can reach the network declares `net.request`.
 *
 * **This is the declaration the `fs.read` default rests on**, and until
 * 2026-08-31 it did not exist anywhere. `DEFAULT_POLICY` opens reading with
 * the comment "it cannot leave the process on its own, and `net.request` is
 * the gate that matters" (`permissions.ts:97-99`), `AGENT-PLATFORM.md:218`
 * says "`net.request` is the capability that matters **and it is checked**",
 * and `ARCHITECTURE.md` says it twice more. Enforcement is driven entirely
 * off `command.capabilities`, and **no command declared it**, so the gate was
 * a sentence rather than a check: a plugin could read a file with no prompt
 * (policy `allow`) and then dispatch `agents.run` to send it to a model, also
 * with no prompt.
 *
 * What bounded the damage was a mechanism none of those documents credit:
 * `http.rs`'s `is_loopback` refuses any non-loopback URL, so the local model
 * was the only reachable endpoint. That is a real defence and it is one layer,
 * in Rust, aimed at a different question. It is not the one the policy comment
 * points at, and ROADMAP's "Later: AI" plans remote model support, which is
 * where relying on it silently would have stopped working.
 *
 * Found by a security review on 2026-08-30.
 *
 * Mutation-checked on 2026-08-31: removing `capabilities: ['net.request']`
 * from `agents.run` fails the first test naming that command, and from
 * `app.checkForUpdates` fails it naming that one.
 *
 * What this does not catch: a *plugin's own process* opening a socket. That is
 * outside the model by design, and `ARCHITECTURE.md`'s "A plugin process is
 * not sandboxed" says so. The model governs what a plugin may ask **Nox** to
 * do, which is what this holds.
 *
 * Nor does it re-check that the **user** is exempt from all of this. That is
 * the permission model's own property rather than this gate's, and
 * `tests/permissions.test.ts:309` already holds it ("never consults the guard
 * for the user"). A second, weaker version of it here would have dispatched a
 * command that was disabled anyway, and proved nothing.
 */

const AGENT: Principal = { kind: 'agent', sessionId: 's1', label: 'test-agent' };

/**
 * Commands that cause Nox itself to make a network request.
 *
 * Written out rather than derived, because the point is to state which
 * commands reach the network and be told when the answer changes. A derived
 * list would agree with the code by construction and assert nothing.
 */
const REACH_THE_NETWORK = [
  'agents.run',
  'agents.runOnSelection',
  'agents.askAboutSelection',
  'agents.explainSelection',
  'app.checkForUpdates',
];

/**
 * A build that can reach a local model, with one agent configured.
 *
 * Needed because `CommandRegistry.execute` checks `enabled` **before** the
 * guard, so a command that cannot run is never permission-checked at all. A
 * test that dispatched a disabled command would watch it return false and
 * prove nothing about the gate. `MemoryPlatform` reports `localModels: false`,
 * which is what makes `agents.run` disabled by default.
 */
class ModelPlatform extends MemoryPlatform {
  override readonly capabilities: PlatformCapabilities = {
    ...new MemoryPlatform().capabilities,
    localModels: true,
  };
}

function app() {
  return new NoxApp(new MemoryPlatform());
}

async function appWithAnAgent() {
  const platform = new ModelPlatform();
  await platform.writeConfigFile(
    AGENTS_FILE,
    JSON.stringify({
      agents: [
        { id: 'local', label: 'Local', kind: 'ollama', host: 'http://127.0.0.1:11434', model: 'q' },
      ],
    }),
  );
  const nox = new NoxApp(platform);
  await nox.agentConfig.load();
  return nox;
}

describe('the net.request gate', () => {
  it.each(REACH_THE_NETWORK)('%s declares net.request', (id) => {
    const command = app().commands.all().find((entry) => entry.id === id);
    expect(command, `${id} is not registered`).toBeDefined();
    expect(command?.capabilities ?? []).toContain('net.request');
  });

  /**
   * The capability is denied by policy rather than prompted, so a plugin or an
   * agent asking for one of these is refused with no dialog at all. That is
   * `DEFAULT_POLICY`'s existing choice and this only checks it now reaches
   * something: before the declarations, the guard skipped every one of these
   * commands because `command.capabilities?.length` was falsy.
   */
  it('refuses a non-user principal without asking anyone', async () => {
    const nox = await appWithAnAgent();
    const prompter = vi.fn(async (): Promise<PromptAnswer> => 'allow-session');
    nox.permissions.setPrompter(prompter);

    // The command is enabled here, so this reaches the guard rather than
    // stopping at `enabled` the way a disabled one would.
    expect(nox.commands.all().find((entry) => entry.id === 'agents.run')?.enabled?.()).toBe(true);

    await expect(
      nox.commands.execute('agents.run', 'local', { principal: AGENT }),
    ).rejects.toThrow();

    // Denied by policy, so the user is never interrupted about it. Even a
    // prompter that would have said yes is never consulted.
    expect(prompter).not.toHaveBeenCalled();
  });

  /** The decision is recorded against the endpoint, so an audit names it. */
  it('records the host the request would have gone to', async () => {
    const nox = await appWithAnAgent();

    await expect(
      nox.commands.execute('agents.run', 'local', { principal: AGENT }),
    ).rejects.toThrow();

    const decision = nox.permissions.decisions.get().at(-1);
    expect(decision).toMatchObject({
      capability: 'net.request',
      granted: false,
      resource: 'http://127.0.0.1:11434',
    });
  });

  /**
   * A capability nothing declares is a capability that enforces nothing, which
   * is exactly how this defect survived. `permissions.revoke` is deliberately
   * exempt: it is declared by two commands, and it is the one capability whose
   * *absence* from a command is the safe direction.
   */
  it('leaves no capability in the vocabulary undeclared by every command', () => {
    const declared = new Set(
      app()
        .commands.all()
        .flatMap((command) => command.capabilities ?? []),
    );

    const orphaned = CAPABILITIES.filter((capability) => !declared.has(capability));
    expect(orphaned).toEqual([]);
  });
});
