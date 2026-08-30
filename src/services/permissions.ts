import { containsResolved } from '@core/path';
import { Signal } from '@core/signal';
import { authorLabel, type Author } from './transactions';

/**
 * The policy layer between programmatic callers and anything with a side
 * effect.
 *
 * Wired in now, with tests as the only non-user caller, because a permission
 * model retrofitted around an existing agent is a permission model with holes
 * in it. The shape to keep in mind: enforcement happens in exactly one place —
 * the command dispatcher — and the *user* never passes through it.
 *
 * See AGENT-PLATFORM.md §2.6.
 */

/**
 * What a command can do. Deliberately coarse: a capability the user cannot
 * reason about is a capability they will approve without reading.
 */
export type Capability =
  | 'fs.read'
  | 'fs.write'
  | 'fs.create'
  | 'fs.delete'
  | 'shell.exec'
  | 'net.request'
  | 'buffer.edit'
  | 'workspace.open'
  /**
   * Taking back a standing grant.
   *
   * The odd one out, and deliberately: the other eight are about the world,
   * this one is about the ledger. It is here because revoking is a real side
   * effect on state a principal depends on, and in this codebase a command's
   * `capabilities` declaration is the only thing that gates it — a revoke
   * command with none would be a side-effecting command any agent could reach.
   *
   * `DEFAULT_POLICY` denies it rather than prompting, which is why adding it
   * does not violate §2.6's "coarse enough to reason about": a denial throws,
   * so the user is never shown a dialog asking whether an agent may edit the
   * record of what they agreed to.
   */
  | 'permissions.revoke';

/**
 * Every capability, as values.
 *
 * The union above is the type; this is the vocabulary, for the one caller that
 * has to check a *string* against it — `core/plugin-manifest.ts`, reading a
 * capability a third party wrote down. `core/` does not import from
 * `services/`, so the list is handed to it rather than known by it.
 *
 * Built from a `Record<Capability, true>` rather than written as an array,
 * because that is exhaustive in **both** directions: a capability added to the
 * union and not here fails to compile, and so does one here that is not in the
 * union. An array with a `satisfies` only catches the second, and the first is
 * the one that matters — a capability the manifest parser does not know is a
 * capability no plugin can declare.
 */
const EVERY_CAPABILITY: Record<Capability, true> = {
  'fs.read': true,
  'fs.write': true,
  'fs.create': true,
  'fs.delete': true,
  'shell.exec': true,
  'net.request': true,
  'buffer.edit': true,
  'workspace.open': true,
  'permissions.revoke': true,
};

export const CAPABILITIES = Object.keys(EVERY_CAPABILITY) as readonly Capability[];

export type Decision = 'allow' | 'deny' | 'prompt';

/**
 * Who is asking.
 *
 * The same taxonomy as a change set's `Author`, and deliberately the same
 * type: the thing that requested an edit and the thing accountable for it are
 * not two different concepts, and two parallel enums would drift.
 */
export type Principal = Author;

export const USER: Principal = { kind: 'user' };

export interface Policy {
  /** Applied to any capability the rules do not name. */
  fallback: Decision;
  rules: Partial<Record<Capability, Decision>>;
}

/** Nothing gets in without being asked for. */
export const DEFAULT_POLICY: Policy = {
  fallback: 'prompt',
  rules: {
    // Reading is the one thing worth defaulting open: it cannot leave the
    // process on its own, and `net.request` is the gate that matters.
    'fs.read': 'allow',
    'shell.exec': 'deny',
    'net.request': 'deny',
    // The ledger is the user's, not the caller's. Nothing programmatic gets to
    // clear a record of what it was told it may do.
    'permissions.revoke': 'deny',
  },
};

export interface PermissionRequest {
  principal: Principal;
  capability: Capability;
  /** A path for `fs.*`, a command id or URL for the others. */
  resource?: string;
  /** What the caller is trying to do, for the prompt. */
  description?: string;
}

/** How a decision was reached. Recorded so an audit can tell them apart. */
export type DecisionSource =
  | 'user'
  | 'policy'
  | 'prompt'
  | 'remembered'
  | 'workspace-boundary'
  | 'no-prompter';

export interface PermissionDecision extends PermissionRequest {
  granted: boolean;
  source: DecisionSource;
  at: number;
}

/**
 * A "for this session" grant that is still in force.
 *
 * Only ever created by a `allow-session` answer, which is what makes the whole
 * list revocable: a policy `allow` and an `allow-once` both produce a
 * `PermissionDecision` and no `Grant`, so anything rendered from this list is
 * something the user chose and can choose again. Conflating the three would
 * offer a revoke button for a rule that revoking cannot touch.
 */
export interface Grant {
  /** The key `check` matches against. The grant's identity. */
  key: string;
  principal: Principal;
  capability: Capability;
  /** The path the grant is confined to, absent when it was asked capability-wide. */
  resource?: string;
  /** When the user granted it. */
  at: number;
}

/** Thrown when a capability is refused. Never a silent no-op. */
export class PermissionError extends Error {
  readonly capability: Capability;
  readonly principal: Principal;
  readonly resource?: string;

  constructor(request: PermissionRequest) {
    super(
      `${authorLabel(request.principal)} is not allowed to ${request.capability}` +
        (request.resource ? ` on ${request.resource}` : ''),
    );
    this.name = 'PermissionError';
    this.capability = request.capability;
    this.principal = request.principal;
    if (request.resource !== undefined) this.resource = request.resource;
  }
}

/**
 * What the UI is asked when a decision needs a human.
 *
 * A function rather than a service dependency, so the permission layer has no
 * idea a UI exists and a test can answer for itself.
 */
export type Prompter = (request: PermissionRequest) => Promise<PromptAnswer>;

export type PromptAnswer = 'allow-once' | 'allow-session' | 'deny';

export class PermissionService {
  /** Every decision reached, newest last. The audit trail. */
  readonly decisions = new Signal<PermissionDecision[]>([]);

  /**
   * Every "for this session" grant still standing, oldest first.
   *
   * A `Signal` of an array rather than the `Set<string>` this used to be, and
   * the array *is* the lookup structure — there is no second copy to fall out
   * of step with it. The scan in `check` is linear, which is fine here and
   * nowhere near the typing path: the list is bounded by how many distinct
   * questions the user has answered "allow for this session" to, and a user
   * who has answered that a hundred times has a bigger problem than a loop.
   */
  readonly grants = new Signal<Grant[]>([]);

  #policies = new Map<string, Policy>();
  #default: Policy = DEFAULT_POLICY;
  #prompter: Prompter | null = null;
  #workspaceRoot: () => string | null;

  /**
   * `workspaceRoot` is a getter rather than the workspace service: the only
   * thing this layer needs to know about the project is where its edge is.
   */
  constructor(workspaceRoot: () => string | null = () => null) {
    this.#workspaceRoot = workspaceRoot;
  }

  setPrompter(prompter: Prompter | null): void {
    this.#prompter = prompter;
  }

  /** Policy for principals with no specific one. */
  setDefaultPolicy(policy: Policy): void {
    this.#default = policy;
  }

  setPolicy(principal: Principal, policy: Policy): void {
    this.#policies.set(principalKey(principal), policy);
  }

  policyFor(principal: Principal): Policy {
    return this.#policies.get(principalKey(principal)) ?? this.#default;
  }

  /** Grants held by one principal, oldest first. */
  grantsFor(principal: Principal): Grant[] {
    const key = principalKey(principal);
    return this.grants.get().filter((grant) => principalKey(grant.principal) === key);
  }

  /**
   * Forget every "for this session" grant — e.g. when an agent disconnects.
   *
   * Returns what it removed rather than nothing, so a caller can report a
   * count instead of announcing a revocation that revoked nothing.
   *
   * Nothing here touches a buffer, the transaction log or the decision trail,
   * and that is the whole point: revoking closes the door, it does not take
   * back what came through it while it was open. Until this grew a caller
   * other than `AgentRuntime.undoSession`, those two were the same action, and
   * a user who wanted to keep an agent's edits but stop it writing had to give
   * up one to get the other.
   */
  forgetSession(principal?: Principal): Grant[] {
    const held = principal ? new Set(this.grantsFor(principal)) : null;
    const forgotten = held ? [...held] : this.grants.get();
    if (forgotten.length === 0) return [];

    this.grants.update((current) => (held ? current.filter((grant) => !held.has(grant)) : []));
    return forgotten;
  }

  /**
   * Decide, prompting if the policy says to.
   *
   * The user is exempt and returns immediately. That is not an optimisation:
   * a model that can interrupt a human mid-keystroke is a model they will turn
   * off within a day, and a permission layer nobody runs protects nothing.
   */
  async check(request: PermissionRequest): Promise<boolean> {
    if (request.principal.kind === 'user') {
      // Not recorded either. A log of "the user was allowed to type" is noise
      // that would bury the entries an audit is actually looking for.
      return true;
    }

    const key = grantKey(request);
    if (this.grants.get().some((grant) => grant.key === key)) {
      return this.#record(request, true, 'remembered');
    }

    // The workspace edge overrides policy in one direction only: it turns an
    // `allow` into a question. It must never soften a `deny` into one, or a
    // policy that forbids something would end up merely asking about it —
    // which is a weaker rule wearing a stronger rule's name.
    const configured = this.#decide(request);
    const escalated = configured === 'allow' && this.#isOutsideWorkspace(request);
    const decision = escalated ? 'prompt' : configured;

    if (decision === 'allow') return this.#record(request, true, 'policy');
    if (decision === 'deny') return this.#record(request, false, 'policy');

    if (!this.#prompter) {
      // Nothing can answer, so the answer is no. Failing closed is the only
      // safe reading of "ask the user" when there is no user to ask.
      return this.#record(request, false, 'no-prompter');
    }

    const answer = await this.#prompter(request);
    // Only `allow-session` becomes a grant. `allow-once` is answered about
    // this one question and expires with it, so listing it among the standing
    // grants would offer the user a revoke button for something already gone.
    if (answer === 'allow-session') {
      this.grants.update((current) => [
        ...current,
        {
          key,
          principal: request.principal,
          capability: request.capability,
          ...(request.resource !== undefined ? { resource: request.resource } : {}),
          at: Date.now(),
        },
      ]);
    }
    return this.#record(request, answer !== 'deny', escalated ? 'workspace-boundary' : 'prompt');
  }

  /** `check`, but throws instead of returning false. */
  async require(request: PermissionRequest): Promise<void> {
    if (!(await this.check(request))) throw new PermissionError(request);
  }

  #decide(request: PermissionRequest): Decision {
    const policy = this.policyFor(request.principal);
    return policy.rules[request.capability] ?? policy.fallback;
  }

  #isOutsideWorkspace(request: PermissionRequest): boolean {
    if (!request.capability.startsWith('fs.')) return false;
    if (!request.resource) return false;
    const root = this.#workspaceRoot();
    // With no folder open there is no boundary to be outside of; the policy
    // is then the only thing deciding, which is what a scratch buffer wants.
    if (!root) return false;
    // Resolved, not a string prefix. `'/proj/../../etc/shadow'` reads as
    // being under `/proj` and is not, and the OS resolves it afterwards.
    return !containsResolved(root, request.resource);
  }

  #record(request: PermissionRequest, granted: boolean, source: DecisionSource): boolean {
    this.decisions.update((current) =>
      [...current, { ...request, granted, source, at: Date.now() }].slice(-500),
    );
    return granted;
  }
}

/** Plain-language phrasing for a prompt. "fs.write" is not a question. */
export function describeCapability(capability: Capability): string {
  switch (capability) {
    case 'fs.read':
      return 'read files';
    case 'fs.write':
      return 'change files on disk';
    case 'fs.create':
      return 'create files';
    case 'fs.delete':
      return 'delete files';
    case 'shell.exec':
      return 'run a command on your computer';
    case 'net.request':
      return 'access the network';
    case 'buffer.edit':
      return 'edit what is open';
    case 'workspace.open':
      return 'open a different folder';
    case 'permissions.revoke':
      return 'take back permissions you have granted';
  }
}

/** Stable identity for a principal, for policy and grant lookup. */
export function principalKey(principal: Principal): string {
  switch (principal.kind) {
    case 'user':
      return 'user';
    case 'agent':
      return `agent:${principal.sessionId}`;
    case 'plugin':
      return `plugin:${principal.pluginId}`;
    case 'script':
      return `script:${principal.name}`;
  }
}

/**
 * Capabilities whose grants are remembered per resource rather than wholesale.
 *
 * `fs.*` was always here: approving a write to `src/app.ts` must not quietly
 * approve one to `~/.ssh/config`. `buffer.edit` joined it once the editing
 * commands started naming the file they act on — without it, putting the
 * filename in the prompt would have narrowed only the *question*, leaving
 * "Allow for this session" answered about one buffer to cover every buffer
 * the user opens for the rest of the session.
 */
export function isResourceScoped(capability: Capability): boolean {
  return capability.startsWith('fs.') || capability === 'buffer.edit';
}

/**
 * Key for a remembered grant.
 *
 * A capability outside {@link isResourceScoped} remembers at the capability
 * level, which is the granularity it is asked at.
 */
function grantKey(request: PermissionRequest): string {
  const scope = isResourceScoped(request.capability) ? (request.resource ?? '') : '';
  // `\0` rather than a raw NUL byte: the same character to the compiler, but
  // a raw one makes this entire file binary to `grep`, `git diff` and every
  // other text tool. Not hypothetical — it is why `grep -rn "forgetSession"
  // src/` reported the call site in `runtime.ts` and never the definition in
  // this file, which is a good way to conclude a method does not exist.
  return `${principalKey(request.principal)}\0${request.capability}\0${scope}`;
}
