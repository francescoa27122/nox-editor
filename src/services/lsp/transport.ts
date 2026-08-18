/**
 * JSON-RPC 2.0 over whatever moves messages.
 *
 * Takes a `send` function and is fed complete messages through `receive`, so
 * it has no idea whether there is a process at the other end. That is what
 * makes the cases worth testing testable: an out-of-order reply, a request
 * that is never answered, a server asking for something Nox cannot do.
 *
 * Framing is not this layer's business — `src-tauri/src/lsp.rs` owns it,
 * because `Content-Length` counts bytes and every string here is measured in
 * UTF-16 code units.
 */

/** How long a request waits before it gives up rather than pending forever. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** JSON-RPC's own code for a method the receiver does not implement. */
const METHOD_NOT_FOUND = -32601;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Incoming {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface JsonRpcOptions {
  timeoutMs?: number;
}

export class JsonRpcTransport {
  #send: (message: string) => Promise<void>;
  #timeoutMs: number;
  #nextId = 0;
  #pending = new Map<number, Pending>();
  #notifications = new Map<string, ((params: unknown) => void)[]>();
  #requests = new Map<string, (params: unknown) => Promise<unknown>>();
  #errors: ((message: string) => void)[] = [];
  #disposed = false;

  constructor(send: (message: string) => Promise<void>, options: JsonRpcOptions = {}) {
    this.#send = send;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** How many requests are still waiting. Exposed so a leak is assertable. */
  pendingCount(): number {
    return this.#pending.size;
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.#disposed) {
      return Promise.reject(new Error(`lsp: ${method} after the transport closed`));
    }

    const id = ++this.#nextId;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Deleted first, so the late reply — if one ever comes — finds
        // nothing and is ignored rather than resolving a settled promise.
        this.#pending.delete(id);
        reject(new Error(`lsp: ${method} timed out after ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);

      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      void this.#write({ jsonrpc: '2.0', id, method, params }).catch((error: unknown) => {
        this.#settleWithError(id, error);
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.#disposed) return;
    await this.#write({ jsonrpc: '2.0', method, params });
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    const handlers = this.#notifications.get(method) ?? [];
    handlers.push(handler);
    this.#notifications.set(method, handlers);
  }

  /** Answer a request the *server* makes. One handler per method. */
  onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.#requests.set(method, handler);
  }

  /** Told about anything that could not be understood. */
  onError(handler: (message: string) => void): void {
    this.#errors.push(handler);
  }

  /** Feed one complete message in. */
  receive(raw: string): void {
    let message: Incoming;
    try {
      message = JSON.parse(raw) as Incoming;
    } catch {
      // Thrown from whatever is pumping messages, so this reports rather than
      // throws: an exception here would take down the pump, not the message.
      this.#report(`lsp: could not parse a message (${raw.slice(0, 80)})`);
      return;
    }

    if (message.method !== undefined) {
      if (message.id !== undefined) this.#answer(message.id, message.method, message.params);
      else this.#deliver(message.method, message.params);
      return;
    }

    if (message.id !== undefined) this.#settle(message);
  }

  /** Reject everything outstanding. Safe to call twice. */
  dispose(reason: string): void {
    this.#disposed = true;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
  }

  async #write(message: Record<string, unknown>): Promise<void> {
    // `params` is dropped when undefined rather than serialised as null: a
    // notification with `"params": null` is not the same message.
    const payload: Record<string, unknown> = { jsonrpc: '2.0' };
    if (message.id !== undefined) payload.id = message.id;
    if (message.method !== undefined) payload.method = message.method;
    if (message.params !== undefined) payload.params = message.params;
    if (message.result !== undefined) payload.result = message.result;
    if (message.error !== undefined) payload.error = message.error;

    await this.#send(JSON.stringify(payload));
  }

  #settle(message: Incoming): void {
    const id = typeof message.id === 'number' ? message.id : Number(message.id);
    const entry = this.#pending.get(id);
    // No entry means it timed out, or the transport was disposed. Either way
    // the caller has already been told; there is nothing left to resolve.
    if (!entry) return;

    this.#pending.delete(id);
    clearTimeout(entry.timer);

    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  }

  #settleWithError(id: number, error: unknown): void {
    const entry = this.#pending.get(id);
    if (!entry) return;
    this.#pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(error instanceof Error ? error : new Error(String(error)));
  }

  #deliver(method: string, params: unknown): void {
    for (const handler of this.#notifications.get(method) ?? []) handler(params);
  }

  #answer(id: number | string, method: string, params: unknown): void {
    const handler = this.#requests.get(method);

    if (!handler) {
      // Never silence. A server waiting on a reply that never arrives stalls,
      // and the stall is indistinguishable from a slow server.
      void this.#write({
        id,
        error: { code: METHOD_NOT_FOUND, message: `unknown method: ${method}` },
      });
      return;
    }

    void handler(params).then(
      (result) => this.#write({ id, result: result ?? null }),
      (error: unknown) => this.#write({ id, error: { code: -32603, message: String(error) } }),
    );
  }

  #report(message: string): void {
    for (const handler of this.#errors) handler(message);
  }
}
