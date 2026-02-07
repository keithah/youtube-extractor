/**
 * YouTube audio extraction using standard youtubei.js (Node.js build).
 *
 * Adapted from apps/worker/src/utils/youtube-extract.ts but uses the
 * standard build (not cf-worker) — native eval support, no custom evaluator needed.
 *
 * Falls back to yt-dlp if youtubei.js fails to produce a downloadable URL.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import Innertube from "youtubei.js";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

const YOUTUBE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const YOUTUBE_ORIGIN = "https://www.youtube.com";
const CHUNK_SIZE = 524287; // 512KB - 1 (inclusive end byte)
const PER_CLIENT_TIMEOUT_MS = 10_000;
const MAX_FULL_GET_SIZE = 50 * 1024 * 1024; // 50MB safety cap for full GET

let innertubeInstance: Innertube | null = null;

async function getInnertube(): Promise<Innertube> {
  if (innertubeInstance) return innertubeInstance;
  innertubeInstance = await Innertube.create({
    generate_session_locally: true,
    retrieve_player: true,
  });
  return innertubeInstance;
}

export interface ExtractedAudio {
  data: Buffer;
  title: string;
  duration: number;
  author: string;
  thumbnail: string;
  mimeType: string;
}

export async function extractAudio(
  videoId: string,
  poToken?: string,
  visitorData?: string,
  clientOrder?: string[],
): Promise<ExtractedAudio> {
  const innertube = await getInnertube();

  const VALID_CLIENTS = new Set(["WEB", "ANDROID", "TV_EMBEDDED"]);
  const defaultOrder = config.nodeType === "residential"
    ? ["WEB", "ANDROID", "TV_EMBEDDED"]
    : ["ANDROID", "TV_EMBEDDED", "WEB"];
  const clients = clientOrder?.length
    ? clientOrder.filter((c) => VALID_CLIENTS.has(c))
    : defaultOrder;

  let lastError: unknown;

  // Try each client — verify we can get a downloadable URL before committing
  for (const client of clients) {
    try {
      const options: Record<string, unknown> = { client };
      if (poToken && client === "WEB") {
        options.po_token = poToken;
      }

      const clientPromise = innertube.getInfo(
        videoId,
        options as Parameters<typeof innertube.getInfo>[1],
      );
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${client} timed out`)), PER_CLIENT_TIMEOUT_MS),
      );

      const info = await Promise.race([clientPromise, timeout]);
      if (!info.streaming_data?.adaptive_formats?.length) {
        console.warn(`[extract] ${client} returned no adaptive formats for ${videoId}`);
        continue;
      }

      // Find best audio format
      const audioFormats = info.streaming_data.adaptive_formats.filter(
        (f) => f.mime_type?.startsWith("audio/") && f.has_audio !== false,
      );
      if (audioFormats.length === 0) {
        console.warn(`[extract] ${client} has no audio formats for ${videoId}`);
        continue;
      }

      const bestAudio = audioFormats.reduce((best, current) => {
        const currentBitrate = current.bitrate ?? current.average_bitrate ?? 0;
        const bestBitrate = best.bitrate ?? best.average_bitrate ?? 0;
        return currentBitrate > bestBitrate ? current : best;
      });

      // Try to resolve a downloadable URL
      const audioUrl = await resolveUrl(innertube, bestAudio);
      if (!audioUrl) {
        console.warn(`[extract] ${client} has formats but no usable URL for ${videoId}`);
        continue;
      }

      console.log(`[extract] ${client} succeeded for ${videoId}`);

      const mimeType = bestAudio.mime_type || "audio/webm";
      const basicInfo = info.basic_info;
      const title = basicInfo.title || `YouTube Video ${videoId}`;
      const duration = basicInfo.duration || 0;
      const author = basicInfo.channel?.name || "YouTube Channel";
      const thumbnail = basicInfo.thumbnail?.[0]?.url || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;

      // Try downloading
      try {
        const data = await downloadAudio(audioUrl, videoId);
        return { data, title, duration, author, thumbnail, mimeType };
      } catch (dlError) {
        lastError = dlError;
        console.warn(`[extract] ${client} URL download failed for ${videoId}:`,
          dlError instanceof Error ? dlError.message : String(dlError));
        // Try next client
      }
    } catch (error) {
      lastError = error;
      console.warn(`[extract] ${client} failed for ${videoId}:`,
        error instanceof Error ? error.message : String(error));
    }
  }

  // All youtubei.js clients failed — try yt-dlp as fallback
  console.log(`[extract] All clients failed for ${videoId}, trying yt-dlp fallback`);
  try {
    return await extractWithYtDlp(videoId);
  } catch (ytdlpError) {
    console.error(`[extract] yt-dlp fallback also failed for ${videoId}:`,
      ytdlpError instanceof Error ? ytdlpError.message : String(ytdlpError));
  }

  throw lastError || new Error("No client returned playable streaming data");
}

async function resolveUrl(
  innertube: Innertube,
  format: any,
): Promise<string | undefined> {
  const player = innertube.session?.player;

  if (player && typeof format.decipher === "function") {
    try {
      const url = await format.decipher(player);
      if (url) return url;
    } catch {
      // fall through
    }
  }

  if (player) {
    try {
      const cipher = format.signature_cipher ?? format.signatureCipher;
      const url = await player.decipher(
        format.url ?? undefined,
        cipher,
        format.cipher,
      );
      if (url) return url;
    } catch {
      // fall through
    }
  }

  return format.url ?? undefined;
}

async function downloadAudio(
  url: string,
  videoId: string,
): Promise<Buffer> {
  const headers: Record<string, string> = {
    "User-Agent": YOUTUBE_USER_AGENT,
    "Origin": YOUTUBE_ORIGIN,
    "Referer": `${YOUTUBE_ORIGIN}/`,
  };

  // Try full GET first (no Range header) — avoids YouTube's anti-abuse
  // that blocks chunked Range requests on some videos.
  try {
    console.log(`[extract] Trying full GET for ${videoId}`);
    const resp = await fetch(url, { headers });
    if (resp.ok) {
      const contentLength = parseInt(resp.headers.get("content-length") || "0", 10);
      if (contentLength > MAX_FULL_GET_SIZE) {
        console.log(`[extract] Full GET too large (${contentLength} bytes), falling back to chunked`);
        resp.body?.cancel();
      } else {
        const data = Buffer.from(await resp.arrayBuffer());
        if (data.byteLength > 0) {
          console.log(`[extract] Downloaded ${data.byteLength} bytes for ${videoId} (full GET)`);
          return data;
        }
      }
    } else {
      console.warn(`[extract] Full GET returned ${resp.status} for ${videoId}, trying chunked`);
    }
  } catch (error) {
    console.warn(`[extract] Full GET failed for ${videoId}:`,
      error instanceof Error ? error.message : String(error));
  }

  // Fallback: chunked Range requests
  return downloadChunked(url, headers, videoId);
}

async function downloadChunked(
  url: string,
  headers: Record<string, string>,
  videoId: string,
): Promise<Buffer> {
  console.log(`[extract] Trying chunked download for ${videoId}`);
  const firstResponse = await fetch(url, {
    headers: { ...headers, Range: `bytes=0-${CHUNK_SIZE}` },
  });

  if (!firstResponse.ok && firstResponse.status !== 206) {
    throw new Error(`Audio download failed: HTTP ${firstResponse.status}`);
  }

  const firstChunk = Buffer.from(await firstResponse.arrayBuffer());
  if (firstChunk.byteLength === 0) {
    throw new Error("Audio download returned empty response");
  }

  const contentRange = firstResponse.headers.get("content-range");
  let totalSize = 0;
  if (contentRange) {
    const match = contentRange.match(/bytes \d+-\d+\/(\d+)/);
    if (match) totalSize = parseInt(match[1], 10);
  }

  if (totalSize === 0 || firstChunk.byteLength >= totalSize) {
    console.log(`[extract] Downloaded ${firstChunk.byteLength} bytes for ${videoId} (single chunk)`);
    return firstChunk;
  }

  const chunks: Buffer[] = [firstChunk];
  for (let start = firstChunk.byteLength; start < totalSize; start += CHUNK_SIZE + 1) {
    const end = Math.min(start + CHUNK_SIZE, totalSize - 1);
    const resp = await fetch(url, {
      headers: { ...headers, Range: `bytes=${start}-${end}` },
    });
    if (!resp.ok && resp.status !== 206) {
      throw new Error(`Chunk download failed: HTTP ${resp.status} for bytes ${start}-${end}`);
    }
    chunks.push(Buffer.from(await resp.arrayBuffer()));
  }

  const data = Buffer.concat(chunks);
  console.log(`[extract] Downloaded ${data.byteLength} bytes for ${videoId} (${chunks.length} chunks)`);
  return data;
}

async function extractWithYtDlp(videoId: string): Promise<ExtractedAudio> {
  const outPath = join(tmpdir(), `yt-${videoId}-${Date.now()}`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    // Get metadata first
    const { stdout: metaJson } = await execFileAsync("yt-dlp", [
      "--dump-json",
      "--no-download",
      url,
    ], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });

    const meta = JSON.parse(metaJson);

    // Download audio
    await execFileAsync("yt-dlp", [
      "-f", "bestaudio",
      "-o", outPath + ".%(ext)s",
      "--no-playlist",
      "--no-part",
      url,
    ], { timeout: 120_000 });

    // Find the output file (extension is determined by yt-dlp)
    const { readdir } = await import("node:fs/promises");
    const dir = tmpdir();
    const prefix = `yt-${videoId}-`;
    const files = (await readdir(dir)).filter(f => f.startsWith(prefix));
    if (files.length === 0) {
      throw new Error("yt-dlp produced no output file");
    }
    const outputFile = join(dir, files[files.length - 1]);
    const data = await readFile(outputFile);
    await unlink(outputFile).catch(() => {});

    // Determine mime type from extension
    const ext = outputFile.split(".").pop() || "";
    const mimeMap: Record<string, string> = {
      "webm": "audio/webm; codecs=\"opus\"",
      "opus": "audio/webm; codecs=\"opus\"",
      "m4a": "audio/mp4; codecs=\"mp4a.40.2\"",
      "mp4": "audio/mp4; codecs=\"mp4a.40.2\"",
      "ogg": "audio/ogg; codecs=\"opus\"",
    };
    const mimeType = mimeMap[ext] || "audio/webm";

    const title = meta.title || `YouTube Video ${videoId}`;
    const duration = meta.duration || 0;
    const author = meta.uploader || meta.channel || "YouTube Channel";
    const thumbnail = meta.thumbnail || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;

    console.log(`[extract] yt-dlp downloaded ${data.byteLength} bytes for ${videoId}`);
    return { data, title, duration, author, thumbnail, mimeType };
  } catch (error: any) {
    // Clean up any temp files
    const { readdir: rd } = await import("node:fs/promises");
    const dir = tmpdir();
    const prefix = `yt-${videoId}-`;
    try {
      const files = (await rd(dir)).filter(f => f.startsWith(prefix));
      for (const f of files) await unlink(join(dir, f)).catch(() => {});
    } catch {}
    throw error;
  }
}
