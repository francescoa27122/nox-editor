import { Signal } from '@core/signal';

/**
 * Transient messages. Deliberately minimal: Nox shows failures and one-line
 * confirmations, never a stream of chatter. Anything that needs a decision is
 * a modal, not a toast.
 */

export type NotificationKind = 'info' | 'success' | 'warning' | 'error';

export interface Notification {
  id: number;
  kind: NotificationKind;
  message: string;
  detail?: string;
  /** Milliseconds before auto-dismiss. Errors stay until dismissed. */
  timeout: number;
}

const DEFAULT_TIMEOUTS: Record<NotificationKind, number> = {
  info: 3200,
  success: 2400,
  warning: 6000,
  error: 0,
};

export class NotificationService {
  readonly items = new Signal<Notification[]>([]);
  #nextId = 1;
  #timers = new Map<number, ReturnType<typeof setTimeout>>();

  notify(
    kind: NotificationKind,
    message: string,
    options: { detail?: string; timeout?: number } = {},
  ): number {
    const id = this.#nextId++;
    const timeout = options.timeout ?? DEFAULT_TIMEOUTS[kind];
    const notification: Notification = { id, kind, message, timeout };
    if (options.detail) notification.detail = options.detail;

    // Keep the stack short; the oldest is the least relevant.
    this.items.update((list) => [...list, notification].slice(-4));

    if (timeout > 0) {
      this.#timers.set(
        id,
        setTimeout(() => this.dismiss(id), timeout),
      );
    }
    return id;
  }

  info(message: string, detail?: string): number {
    return this.notify('info', message, detail ? { detail } : {});
  }
  success(message: string, detail?: string): number {
    return this.notify('success', message, detail ? { detail } : {});
  }
  warn(message: string, detail?: string): number {
    return this.notify('warning', message, detail ? { detail } : {});
  }
  error(message: string, detail?: string): number {
    return this.notify('error', message, detail ? { detail } : {});
  }

  dismiss(id: number): void {
    const timer = this.#timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(id);
    }
    this.items.update((list) => list.filter((n) => n.id !== id));
  }

  clear(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.items.set([]);
  }
}
