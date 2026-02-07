#!/bin/bash
set -e

COORDINATOR_URL="${COORDINATOR_URL:-https://convertsmedia-api.keith-275.workers.dev}"
NODE_NAME="${NODE_NAME:-node-$(hostname)}"
NODE_TYPE="${NODE_TYPE:-residential}"
REGION="${REGION:-}"

# Auto-detect Fly.io
if [ -n "$FLY_APP_NAME" ]; then
  NODE_TYPE="${NODE_TYPE:-fly}"
  NODE_NAME="${NODE_NAME:-fly-${FLY_REGION:-unknown}}"
  REGION="${REGION:-$FLY_REGION}"
  BANDWIDTH_LIMIT_GB="${BANDWIDTH_LIMIT_GB:-100}"
fi

# Start the extraction service
echo "[entrypoint] Starting extraction service on port 18943..."
node dist/index.js &
SERVICE_PID=$!

# Wait for health check
echo "[entrypoint] Waiting for service to be ready..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:18943/health > /dev/null 2>&1; then
    echo "[entrypoint] Service is ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[entrypoint] Service failed to start within 30s."
    exit 1
  fi
  sleep 1
done

# Determine the base URL for registration
if [ -n "$FLY_APP_NAME" ]; then
  # Fly.io: use the app's public URL directly
  BASE_URL="https://${FLY_APP_NAME}.fly.dev"
  echo "[entrypoint] Detected Fly.io — URL: $BASE_URL, region: $FLY_REGION, bandwidth cap: ${BANDWIDTH_LIMIT_GB:-100}GB"
else
  # Residential/other: start a Cloudflare Quick Tunnel
  echo "[entrypoint] Starting Cloudflare Quick Tunnel..."
  cloudflared tunnel --url http://localhost:18943 --no-autoupdate 2>&1 | tee /tmp/cloudflared.log &
  TUNNEL_PID=$!

  # Parse the tunnel URL from cloudflared output
  BASE_URL=""
  for i in $(seq 1 60); do
    TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cloudflared.log 2>/dev/null | head -1)
    if [ -n "$TUNNEL_URL" ]; then
      BASE_URL="$TUNNEL_URL"
      echo "[entrypoint] Tunnel URL: $BASE_URL"
      break
    fi
    if [ "$i" -eq 60 ]; then
      echo "[entrypoint] Failed to get tunnel URL within 60s."
      kill $SERVICE_PID 2>/dev/null || true
      exit 1
    fi
    sleep 1
  done
fi

# Register with the coordinator (open registration, no secret needed)
echo "[entrypoint] Registering with coordinator at $COORDINATOR_URL..."

BANDWIDTH_ARG=""
if [ -n "$BANDWIDTH_LIMIT_GB" ] && [ "$BANDWIDTH_LIMIT_GB" != "0" ]; then
  BANDWIDTH_ARG=", \"bandwidthLimitGB\": $BANDWIDTH_LIMIT_GB"
fi

REGISTER_RESPONSE=$(curl -sf -X POST "$COORDINATOR_URL/api/nodes/register" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"$NODE_NAME\", \"baseUrl\": \"$BASE_URL\", \"nodeType\": \"$NODE_TYPE\", \"region\": \"$REGION\"$BANDWIDTH_ARG}" 2>&1) || true

NODE_ID=$(echo "$REGISTER_RESPONSE" | grep -oP '"nodeId"\s*:\s*"\K[^"]+' 2>/dev/null || true)

if [ -n "$NODE_ID" ]; then
  echo "[entrypoint] Registered as node $NODE_ID"

  # Start heartbeat loop in background
  while true; do
    sleep 30
    curl -sf -X POST "$COORDINATOR_URL/api/nodes/heartbeat" \
      -H "Content-Type: application/json" \
      -d "{\"nodeId\": \"$NODE_ID\", \"baseUrl\": \"$BASE_URL\"}" > /dev/null 2>&1 || \
      echo "[heartbeat] Failed"
  done &
  HEARTBEAT_PID=$!
else
  echo "[entrypoint] Registration failed: $REGISTER_RESPONSE"
  echo "[entrypoint] Continuing anyway — service is still running locally."
fi

# Wait for the main service process
wait $SERVICE_PID
