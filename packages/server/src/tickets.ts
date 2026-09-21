/**
 * One-off addresses for「在浏览器打开」.
 *
 * The system browser cannot send the token header, and the token itself must
 * not ride in a URL that ends up in a browser's history. So the client — which
 * does hold the token — registers a ticket: a random, short-lived address that
 * serves exactly one picture and nothing else. The ticket id is the secret.
 *
 * The client picks the id, because it has to open the window in the same tick
 * as the click (a window opened after an `await` is a blocked popup) and only
 * then gets to tell the server what the address should serve. `read` therefore
 * waits a moment for a ticket that is not there yet.
 */
export interface TicketContent {
  mediaType: string;
  bytes: Uint8Array;
}

export interface Tickets {
  /** `false` when the id is not one we would accept as a secret, or is taken. */
  register(id: string, content: TicketContent): boolean;
  /** The content, for as long as the ticket lives; a browser may fetch it more than once. */
  read(id: string): Promise<TicketContent | undefined>;
}

export interface CreateTicketsOptions {
  ttlMs?: number;
  /** How long `read` waits for a ticket whose registration is still on its way. */
  waitMs?: number;
  /** The oldest ticket is dropped beyond this many: what is held is whole files, in memory. */
  max?: number;
  now?: () => number;
}

/** At least 128 bits of base64url or hex, which is what `crypto.getRandomValues` gives the client. */
const TICKET_ID = /^[\w-]{32,64}$/;

export function createTickets(options: CreateTicketsOptions = {}): Tickets {
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const waitMs = options.waitMs ?? 3000;
  const max = options.max ?? 20;
  const now = options.now ?? Date.now;
  const held = new Map<string, { content: TicketContent; expiresAt: number }>();
  const waiting = new Map<string, Array<() => void>>();

  const sweep = (): void => {
    for (const [id, entry] of held) if (entry.expiresAt <= now()) held.delete(id);
    while (held.size > max) held.delete(held.keys().next().value as string);
  };

  return {
    register(id, content) {
      sweep();
      if (!TICKET_ID.test(id) || held.has(id)) return false;
      held.set(id, { content, expiresAt: now() + ttlMs });
      sweep();
      for (const wake of waiting.get(id) ?? []) wake();
      waiting.delete(id);
      return true;
    },
    async read(id) {
      sweep();
      if (!held.has(id) && TICKET_ID.test(id) && waitMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, waitMs);
          const wake = (): void => {
            clearTimeout(timer);
            resolve();
          };
          waiting.set(id, [...(waiting.get(id) ?? []), wake]);
        });
        waiting.delete(id);
      }
      return held.get(id)?.content;
    },
  };
}
