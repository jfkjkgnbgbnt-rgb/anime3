import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";

const router: IRouter = Router();

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

// Any *.animeheaven.me CDN host
const ANIMEHEAVEN_CDN_RE = /^[a-z]+\.animeheaven\.me$/;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const AH_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Referer: "https://animeheaven.me/",
  Accept: "video/webm,video/mp4,video/*;q=0.9,*/*;q=0.8",
};

/**
 * Fetch gate.php with the episode key cookie and return ALL candidate
 * streaming URLs in order (primary first, fallbacks after).
 * The URLs have the form: https://<cdn>.animeheaven.me/video.mp4?HASH&TOKEN
 * (we strip any trailing &error / &error2 markers).
 */
async function resolveAnimeHeavenCandidates(hash: string): Promise<string[]> {
  try {
    const resp = await fetch("https://animeheaven.me/gate.php", {
      headers: {
        "User-Agent": UA,
        Referer: "https://animeheaven.me/",
        Cookie: `key=${hash}`,
      },
      redirect: "follow",
    });
    if (!resp.ok) return [];

    const html = await resp.text();

    // Extract every <source src='...'> URL from the page.
    // URLs look like: https://cu.animeheaven.me/video.mp4?HASH&TOKEN[&error[2]]
    // We want only the HASH&TOKEN part (no trailing &error flags).
    const seen = new Set<string>();
    const candidates: string[] = [];
    const re = /<source\s+src='(https:\/\/[a-z]+\.animeheaven\.me\/video\.mp4\?([^'&]+)&([^'&]+))[^']*'/g;

    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const clean = `${m[1]}`; // full URL without trailing &error flags (captured group 1 already stops at next &)
      if (!seen.has(clean)) {
        seen.add(clean);
        candidates.push(clean);
      }
    }

    return candidates;
  } catch {
    return [];
  }
}

/**
 * Try each candidate URL in order; return the first response that is a
 * successful video stream (2xx with video content-type or range response).
 * Returns null if every candidate fails.
 */
async function fetchFirstWorking(
  candidates: string[],
  extraHeaders: Record<string, string>,
): Promise<Response | null> {
  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers: { ...AH_HEADERS, ...extraHeaders }, redirect: "follow" });
      // Accept 200 OK or 206 Partial Content; skip 4xx/5xx
      if (r.status === 200 || r.status === 206) {
        const ct = r.headers.get("content-type") ?? "";
        if (ct.includes("video") || ct.includes("octet-stream")) {
          return r;
        }
      }
      // Body not needed — discard it
      await r.body?.cancel();
    } catch {
      // network error for this candidate — try next
    }
  }
  return null;
}

function pipeUpstream(upstream: Response, req: Request, res: Response): void {
  res.status(upstream.status);

  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;
    if (lower === "content-disposition") return;
    if (lower === "access-control-allow-origin") return;
    res.setHeader(key, value);
  });

  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=3600");

  if (!upstream.body) {
    res.end();
    return;
  }

  const nodeStream = Readable.fromWeb(
    upstream.body as import("stream/web").ReadableStream,
  );
  nodeStream.pipe(res);
  req.on("close", () => nodeStream.destroy());
}

router.get("/media/proxy", async (req: Request, res: Response) => {
  const rawUrl = req.query.url as string | undefined;

  if (!rawUrl) {
    res.status(400).json({ error: "url query param is required" });
    return;
  }

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  if (!ALLOWED_PROTOCOLS.has(target.protocol)) {
    res.status(400).json({ error: "Only http/https URLs are supported" });
    return;
  }

  try {
    // ── AnimeHeaven CDN URLs ──────────────────────────────────────────────
    // Stored as: https://cc.animeheaven.me/video.mp4?HASH&d
    // We resolve fresh signed URLs via gate.php and try each CDN in order
    // until one successfully streams (handles per-episode CDN variance).
    if (ANIMEHEAVEN_CDN_RE.test(target.hostname)) {
      const hash = target.search.replace(/^\?/, "").split("&")[0];

      if (!hash) {
        res.status(400).json({ error: "Missing AnimeHeaven episode hash" });
        return;
      }

      const rangeHeaders: Record<string, string> = {};
      if (req.headers.range) rangeHeaders["Range"] = req.headers.range;

      const candidates = await resolveAnimeHeavenCandidates(hash);
      if (candidates.length === 0) {
        res.status(502).json({ error: "Could not resolve AnimeHeaven video URL" });
        return;
      }

      req.log.info({ hash, candidates: candidates.length }, "proxy: trying AnimeHeaven candidates");

      const upstream = await fetchFirstWorking(candidates, rangeHeaders);
      if (!upstream) {
        res.status(502).json({ error: "All AnimeHeaven CDN sources failed for this episode" });
        return;
      }

      pipeUpstream(upstream, req, res);
      return;
    }

    // ── Generic video proxy ───────────────────────────────────────────────
    const hostParts = target.hostname.split(".");
    const refererHost =
      hostParts.length > 2
        ? `${hostParts[hostParts.length - 2]}.${hostParts[hostParts.length - 1]}`
        : target.hostname;

    const upstreamHeaders: Record<string, string> = {
      "User-Agent": UA,
      Referer: `${target.protocol}//${refererHost}/`,
      Origin: `${target.protocol}//${refererHost}`,
      Accept: "video/webm,video/mp4,video/*;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    };
    if (req.headers.range) upstreamHeaders["Range"] = req.headers.range;

    const upstream = await fetch(rawUrl, { headers: upstreamHeaders, redirect: "follow" });

    pipeUpstream(upstream, req, res);
  } catch (err) {
    req.log.error({ err }, "proxy: upstream fetch failed");
    if (!res.headersSent) {
      res.status(502).json({ error: "Failed to fetch upstream video" });
    }
  }
});

export default router;
