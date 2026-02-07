import { hostname } from "node:os";

const COORDINATOR_URL = "https://convertsmedia-api.keith-275.workers.dev";
const FLY_BANDWIDTH_LIMIT_GB = 100;

const isFly = Boolean(process.env.FLY_APP_NAME);

export const config = {
  port: parseInt(process.env.PORT || "8080", 10),
  coordinatorUrl: process.env.COORDINATOR_URL || COORDINATOR_URL,
  nodeName: process.env.NODE_NAME || (isFly ? `fly-${process.env.FLY_REGION || "unknown"}` : `node-${hostname()}`),
  nodeType: process.env.NODE_TYPE || (isFly ? "fly" : "residential"),
  region: process.env.REGION || process.env.FLY_REGION || "",
  bandwidthLimitGB: parseInt(process.env.BANDWIDTH_LIMIT_GB || (isFly ? String(FLY_BANDWIDTH_LIMIT_GB) : "0"), 10),
  baseUrl: isFly ? `https://${process.env.FLY_APP_NAME}.fly.dev` : undefined,
  heartbeatIntervalMs: 30_000,
};
