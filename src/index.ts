/**
 * YouTube Extraction Node — Hono HTTP server.
 *
 * Endpoints:
 *   GET  /health         — Health check
 *   POST /extract-audio  — Extract and download YouTube audio
 *
 * The server is started by entrypoint.sh, which also handles
 * tunnel creation and registration with the coordinator.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { extractAudio } from "./extract.js";
import { config } from "./config.js";

const app = new Hono();

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    name: config.nodeName,
    type: config.nodeType,
    region: config.region,
  });
});

app.post("/extract-audio", async (c) => {
  let body: {
    videoId?: string;
    poToken?: string;
    visitorData?: string;
    clients?: string[];
  } | null = null;

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const videoId = body?.videoId;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return c.json({ error: "Invalid video ID" }, 400);
  }

  try {
    console.log(`[extract-audio] Starting extraction for ${videoId} (clients: ${(body?.clients || ["default"]).join(",")})`);
    const audio = await extractAudio(videoId, body?.poToken, body?.visitorData, body?.clients);

    const headers = new Headers();
    headers.set("content-type", audio.mimeType.split(";")[0].trim());
    headers.set("content-length", String(audio.data.byteLength));
    headers.set("x-video-title", encodeURIComponent(audio.title));
    headers.set("x-video-duration", String(audio.duration));
    headers.set("x-video-author", encodeURIComponent(audio.author));
    headers.set("x-audio-mime-type", audio.mimeType);
    headers.set("x-video-thumbnail", audio.thumbnail);

    console.log(`[extract-audio] Success for ${videoId} (${audio.data.byteLength} bytes)`);
    return new Response(audio.data as unknown as BodyInit, { status: 200, headers });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[extract-audio] Failed for ${videoId}: ${msg}`);
    return c.json({ error: "Extraction failed", detail: msg }, 422);
  }
});

const port = config.port;
console.log(`[extractor] Starting on port ${port} (${config.nodeName}, ${config.nodeType})`);
serve({ fetch: app.fetch, port });
