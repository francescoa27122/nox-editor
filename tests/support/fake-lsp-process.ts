import type { LanguageServerProcess } from '../../src/platform/types';

/**
 * A language server that lives in the test.
 *
 * Speaks whole JSON-RPC messages, as `LanguageServerProcess` does — framing
 * is the platform's job and never reaches here. `initialize` is answered
 * with whatever capabilities the test asked for; any other request is
 * answered by a `handle`r if one is registered, and otherwise left pending,
 * which is what a slow server looks like from the outside.
 *
 * Buffered until a handler is attached, per the contract on
 * `LanguageServerProcess.onMessage`.
 */
export class FakeLanguageServer implements LanguageServerProcess {
  readonly written: { id?: number; method?: string; params?: unknown }[] = [];
  #capabilities: Record<string, unknown>;
  #handlers = new Map<string, (params: unknown) => unknown>();
  #messages: ((message: string) => void)[] = [];
  #stderr: ((line: string) => void)[] = [];
  #exits: ((code: number | null) => void)[] = [];
  #buffered: string[] = [];
  #exited: { code: number | null } | null = null;

  constructor(options: { capabilities?: Record<string, unknown> } = {}) {
    this.#capabilities = options.capabilities ?? {};
  }

  /** Answer `method` requests with `fn(params)`. */
  handle(method: string, fn: (params: unknown) => unknown): void {
    this.#handlers.set(method, fn);
  }

  async send(message: string): Promise<void> {
    const parsed = JSON.parse(message) as { id?: number; method?: string; params?: unknown };
    this.written.push(parsed);
    if (parsed.method === 'initialize') {
      this.say({ jsonrpc: '2.0', id: parsed.id, result: { capabilities: this.#capabilities } });
    } else if (parsed.method === 'shutdown') {
      this.say({ jsonrpc: '2.0', id: parsed.id, result: null });
    } else if (parsed.id !== undefined && parsed.method && this.#handlers.has(parsed.method)) {
      const result = this.#handlers.get(parsed.method)!(parsed.params);
      this.say({ jsonrpc: '2.0', id: parsed.id, result });
    }
  }

  onMessage(handler: (message: string) => void): void {
    this.#messages.push(handler);
    for (const message of this.#buffered.splice(0)) handler(message);
  }
  onStderr(handler: (line: string) => void): void {
    this.#stderr.push(handler);
  }
  onExit(handler: (code: number | null) => void): void {
    this.#exits.push(handler);
    if (this.#exited) handler(this.#exited.code);
  }
  async kill(): Promise<void> {}

  say(message: unknown): void {
    const raw = JSON.stringify(message);
    if (this.#messages.length === 0) this.#buffered.push(raw);
    else for (const handler of this.#messages) handler(raw);
  }

  publish(uri: string, diagnostics: unknown[], version?: number): void {
    this.say({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics, ...(version === undefined ? {} : { version }) },
    });
  }

  die(code: number | null = 1): void {
    this.#exited = { code };
    for (const handler of this.#exits) handler(code);
  }
}
