/**
 * Registration and heartbeat loop for the extraction node.
 * Registers with the Cloudflare Worker coordinator, then sends
 * periodic heartbeats to stay in the healthy node pool.
 */

import { config } from "./config.js";

let nodeId: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export async function registerNode(baseUrl: string): Promise<string> {
  const body = {
    name: config.nodeName,
    baseUrl,
    nodeType: config.nodeType,
    region: config.region,
    bandwidthLimitGB: config.bandwidthLimitGB || undefined,
  };

  const response = await fetch(`${config.coordinatorUrl}/api/nodes/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Registration failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { nodeId: string; heartbeatIntervalMs: number };
  nodeId = data.nodeId;
  console.log(`[register] Registered as node ${nodeId} (${config.nodeName})`);

  return nodeId;
}

export function startHeartbeat(baseUrl: string): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }

  const sendHeartbeat = async () => {
    if (!nodeId) return;

    try {
      const response = await fetch(`${config.coordinatorUrl}/api/nodes/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId, baseUrl }),
      });

      if (!response.ok) {
        console.warn(`[heartbeat] Failed: HTTP ${response.status}`);
        return;
      }

      const data = (await response.json()) as {
        ok: boolean;
        bytesServed: number;
        bandwidthLimitBytes: number;
      };

      if (data.bandwidthLimitBytes > 0) {
        const usedGB = (data.bytesServed / 1073741824).toFixed(2);
        const limitGB = (data.bandwidthLimitBytes / 1073741824).toFixed(0);
        console.log(`[heartbeat] OK — bandwidth: ${usedGB}/${limitGB} GB`);
      } else {
        console.log(`[heartbeat] OK`);
      }
    } catch (error) {
      console.warn(`[heartbeat] Error:`, error instanceof Error ? error.message : String(error));
    }
  };

  heartbeatTimer = setInterval(sendHeartbeat, config.heartbeatIntervalMs);
  // Send first heartbeat immediately
  sendHeartbeat();
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
