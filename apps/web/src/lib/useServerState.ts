import { useEffect, useState } from "react";
import { probeToken, reportUnauthorized, sseUrl } from "./api";
import { shareUnchanged } from "./shareUnchanged";
import type { Project, Settings, StateEvent, ThreadSummary } from "./types";

const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 8000;

export interface ServerState {
  projects: Project[];
  threads: ThreadSummary[];
  settings: Settings | null;
  /** False between a drop and the next `state` event. */
  connected: boolean;
}

const EMPTY: ServerState = { projects: [], threads: [], settings: null, connected: false };

/**
 * `GET /api/state` (SSE) as React state, with exponential-backoff reconnect.
 * `EventSource` reconnects on its own, but only while the server answers; a
 * server that is down (or returns 401) needs us to rebuild the source.
 */
export function useServerState(token: string): ServerState {
  const [state, setState] = useState<ServerState>(EMPTY);

  useEffect(() => {
    let disposed = false;
    /** Set when the token was rejected: no further attempt may be scheduled. */
    let halted = false;
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = RETRY_MIN_MS;

    const connect = () => {
      if (disposed || halted) return;
      // Bound to this attempt, not to the mutable `source`: a late error from a
      // superseded EventSource must close *itself*, or it keeps reconnecting in
      // the background and every retry spawns another one.
      const instance = new EventSource(sseUrl("/api/state", token));
      source = instance;
      instance.addEventListener("state", (event) => {
        delay = RETRY_MIN_MS;
        const payload = JSON.parse((event as MessageEvent<string>).data) as StateEvent;
        // Every push is a fresh parse of everything. What did not change keeps its
        // identity, so a change to one task re-renders that task and not the list.
        setState((previous) => {
          const projects = shareUnchanged(previous.projects, payload.projects);
          const threads = shareUnchanged(previous.threads, payload.threads);
          const settings = shareUnchanged(previous.settings, payload.settings);
          return previous.connected && projects === previous.projects && threads === previous.threads && settings === previous.settings
            ? previous
            : { projects, threads, settings, connected: true };
        });
      });
      instance.onerror = () => {
        instance.close();
        if (source !== instance || disposed) return;
        setState((previous) => (previous.connected ? { ...previous, connected: false } : previous));
        // `EventSource` gives no status code, so a rejected token looks exactly
        // like a server that is down — and retrying it forever is the storm.
        // One probe tells the two apart.
        void probeToken(token)
          .then((valid) => {
            if (disposed || halted || source !== instance) return;
            if (!valid) {
              halted = true;
              reportUnauthorized();
              return;
            }
            timer = setTimeout(connect, delay);
            delay = Math.min(RETRY_MAX_MS, delay * 2);
          })
          .catch(() => {
            // The probe itself could not reach the server: treat it as a drop.
            if (disposed || halted || source !== instance) return;
            timer = setTimeout(connect, delay);
            delay = Math.min(RETRY_MAX_MS, delay * 2);
          });
      };
    };

    connect();
    return () => {
      disposed = true;
      if (timer != null) clearTimeout(timer);
      source?.close();
    };
  }, [token]);

  return state;
}
