/**
 * Subscribe to the API's live stats stream (Server-Sent Events).
 * EventSource reconnects by itself, so a restarted API just reappears.
 */
import { useEffect, useState } from "react";

/**
 * @returns {{stats: Object|null, connected: boolean}} Latest snapshot and link state
 */
export function useStats() {
  const [stats, setStats] = useState(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (event) => {
      setConnected(true);
      setStats(JSON.parse(event.data));
    };
    return () => source.close();
  }, []);

  return { stats, connected };
}
