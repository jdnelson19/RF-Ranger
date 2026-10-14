import { useEffect, useState } from 'react';
import type { Snapshot } from './types';

export interface Live {
  snapshot: Snapshot | undefined;
  /** False while the browser has no live link to the RF Ranger server. */
  online: boolean;
  /** When the last snapshot arrived (browser clock). */
  receivedAt: number | undefined;
}

/** How long without a push before the UI treats what it shows as frozen. */
export const SERVER_SILENCE_MS = 3_000;

export function useSnapshot(): Live {
  const [state, setState] = useState<Live>({ snapshot: undefined, online: false, receivedAt: undefined });

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry: number | undefined;
    let closed = false;
    let attempt = 0;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws`);
      ws.onmessage = (e) => {
        attempt = 0;
        setState({ snapshot: JSON.parse(e.data as string) as Snapshot, online: true, receivedAt: Date.now() });
      };
      ws.onclose = () => {
        setState((s) => ({ ...s, online: false }));
        if (!closed) retry = window.setTimeout(connect, Math.min(5_000, 500 * 2 ** attempt++));
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    // The server pushes at least once a second; silence means the link is dead
    // even if the socket hasn't noticed yet.
    const watchdog = window.setInterval(() => {
      setState((s) => (s.online && s.receivedAt && Date.now() - s.receivedAt > SERVER_SILENCE_MS ? { ...s, online: false } : s));
    }, 1_000);

    return () => {
      closed = true;
      window.clearTimeout(retry);
      window.clearInterval(watchdog);
      ws?.close();
    };
  }, []);

  return state;
}
