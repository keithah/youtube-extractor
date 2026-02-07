/**
 * YouTube audio extraction using standard youtubei.js (Node.js build).
 *
 * Adapted from apps/worker/src/utils/youtube-extract.ts but uses the
 * standard build (not cf-worker) — native eval support, no custom evaluator needed.
 */

import Innertube from "youtubei.js";

const YOUTUBE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const YOUTUBE_ORIGIN = "https://www.youtube.com";
const CHUNK_SIZE = 524287; // 512KB - 1 (inclusive end byte)
const PER_CLIENT_TIMEOUT_MS = 10_000;

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
  const clients = clientOrder?.length
    ? clientOrder.filter((c) => VALID_CLIENTS.has(c))
    : ["WEB", "ANDROID", "TV_EMBEDDED"];

  let info: Awaited<ReturnType<typeof innertube.getInfo>> | null = null;
  let lastError: unknown;

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

      const result = await Promise.race([clientPromise, timeout]);
      if (result.streaming_data?.adaptive_formats?.length) {
        console.log(`[extract] ${client} succeeded for ${videoId}`);
        info = result;
        break;
      }
      console.warn(`[extract] ${client} returned no adaptive formats for ${videoId}`);
    } catch (error) {
      lastError = error;
      console.warn(`[extract] ${client} failed for ${videoId}:`,
        error instanceof Error ? error.message : String(error));
    }
  }

  if (!info) {
    throw lastError || new Error("No client returned playable streaming data");
  }

  const basicInfo = info.basic_info;
  const streamingData = info.streaming_data;
  if (!streamingData) throw new Error("Missing streaming data");

  // Find best audio-only format
  const audioFormats = streamingData.adaptive_formats.filter(
    (f) => f.mime_type?.startsWith("audio/") && f.has_audio !== false,
  );

  if (audioFormats.length === 0) {
    throw new Error("No audio stream available");
  }

  const bestAudio = audioFormats.reduce((best, current) => {
    const currentBitrate = current.bitrate ?? current.average_bitrate ?? 0;
    const bestBitrate = best.bitrate ?? best.average_bitrate ?? 0;
    return currentBitrate > bestBitrate ? current : best;
  });

  // Resolve the URL (decipher if needed)
  const player = innertube.session?.player;
  let audioUrl: string | undefined;

  if (player && typeof bestAudio.decipher === "function") {
    try {
      audioUrl = await bestAudio.decipher(player);
    } catch {
      // fall through to URL field
    }
  }

  if (!audioUrl && player) {
    try {
      const cipher = bestAudio.signature_cipher ?? (bestAudio as any).signatureCipher;
      audioUrl = await player.decipher(
        bestAudio.url ?? undefined,
        cipher,
        (bestAudio as any).cipher,
      );
    } catch {
      // fall through
    }
  }

  if (!audioUrl) {
    audioUrl = bestAudio.url ?? undefined;
  }

  if (!audioUrl) {
    throw new Error("No audio stream URL available");
  }

  const mimeType = bestAudio.mime_type || "audio/webm";

  // Download using chunked Range requests (same pattern as Worker)
  const fetchHeaders: Record<string, string> = {
    "User-Agent": YOUTUBE_USER_AGENT,
    "Origin": YOUTUBE_ORIGIN,
    "Referer": `${YOUTUBE_ORIGIN}/`,
  };

  const firstResponse = await fetch(audioUrl, {
    headers: { ...fetchHeaders, Range: `bytes=0-${CHUNK_SIZE}` },
  });

  if (!firstResponse.ok && firstResponse.status !== 206) {
    throw new Error(`Audio download failed: HTTP ${firstResponse.status}`);
  }

  const firstChunk = Buffer.from(await firstResponse.arrayBuffer());
  if (firstChunk.byteLength === 0) {
    throw new Error("Audio download returned empty response");
  }

  // Parse Content-Range to learn total size
  const contentRange = firstResponse.headers.get("content-range");
  let totalSize = 0;
  if (contentRange) {
    const match = contentRange.match(/bytes \d+-\d+\/(\d+)/);
    if (match) totalSize = parseInt(match[1], 10);
  }

  const title = basicInfo.title || `YouTube Video ${videoId}`;
  const duration = basicInfo.duration || 0;
  const author = basicInfo.channel?.name || "YouTube Channel";
  const thumbnail = basicInfo.thumbnail?.[0]?.url || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;

  if (totalSize === 0 || firstChunk.byteLength >= totalSize) {
    console.log(`[extract] Downloaded ${firstChunk.byteLength} bytes for ${videoId} (single chunk)`);
    return { data: firstChunk, title, duration, author, thumbnail, mimeType };
  }

  // Download remaining chunks sequentially
  const chunks: Buffer[] = [firstChunk];
  for (let start = firstChunk.byteLength; start < totalSize; start += CHUNK_SIZE + 1) {
    const end = Math.min(start + CHUNK_SIZE, totalSize - 1);
    const resp = await fetch(audioUrl, {
      headers: { ...fetchHeaders, Range: `bytes=${start}-${end}` },
    });
    if (!resp.ok && resp.status !== 206) {
      throw new Error(`Chunk download failed: HTTP ${resp.status} for bytes ${start}-${end}`);
    }
    chunks.push(Buffer.from(await resp.arrayBuffer()));
  }

  const data = Buffer.concat(chunks);
  console.log(`[extract] Downloaded ${data.byteLength} bytes for ${videoId} (${chunks.length} chunks)`);
  return { data, title, duration, author, thumbnail, mimeType };
}
