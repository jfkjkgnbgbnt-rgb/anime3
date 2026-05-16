import { Router, type IRouter, type Request, type Response } from "express";
import { db, mediaTable, type Episode } from "../db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { requireAuth } from "./auth";

const router: IRouter = Router();

const ANIMEHEAVEN_BASE = "https://animeheaven.me";
const VIDEO_BASE = "https://cc.animeheaven.me/video.mp4";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function normaliseAnimeHeavenUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim().startsWith("http") ? raw.trim() : `https://${raw.trim()}`);
    if (!u.hostname.includes("animeheaven")) return null;
    return u.href;
  } catch {
    return null;
  }
}

interface ScrapedEpisode {
  number: number;
  title: string;
  url: string;
}

interface ScrapeResult {
  animeTitle: string;
  thumbnail: string | null;
  description: string | null;
  episodes: ScrapedEpisode[];
}

interface CatalogEntry {
  title: string;
  slug: string;
  url: string;
  thumbnail: string | null;
}

async function fetchHtml(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, Referer: ANIMEHEAVEN_BASE + "/" },
    redirect: "follow",
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

async function scrapeAnimeHeavenPage(pageUrl: string): Promise<ScrapeResult> {
  const html = await fetchHtml(pageUrl);

  const animeTitle =
    html.match(/property='og:title'\s+content='([^']+)'/)?.[1] ??
    html.match(/<title>([^<]+?)\s*(?:Anime|–|\|)/)?.[1]?.trim() ??
    "Unknown Anime";

  const thumbnail =
    html.match(/class='posterimg'[^>]+src='([^']+)'/)?.[1] ?? null;

  const description =
    html.match(/class='infodes[^']*'[^>]*>([^<]+)<\/div>/)?.[1]?.trim() ?? null;

  const episodePattern =
    /gatea\("([a-f0-9]{32})"\)[\s\S]*?<div class='watch2[^']*'>\s*(\d+)\s*<\/div>/g;

  const seen = new Set<number>();
  const episodes: ScrapedEpisode[] = [];

  let m: RegExpExecArray | null;
  while ((m = episodePattern.exec(html)) !== null) {
    const hash = m[1];
    const epNum = parseInt(m[2], 10);
    if (seen.has(epNum)) continue;
    seen.add(epNum);
    episodes.push({ number: epNum, title: `Episode ${epNum}`, url: `${VIDEO_BASE}?${hash}&d` });
  }

  episodes.sort((a, b) => a.number - b.number);
  return { animeTitle, thumbnail, description, episodes };
}

// ── Catalog scraper ────────────────────────────────────────────────────────────

async function scrapeAnimeHeavenCatalog(): Promise<CatalogEntry[]> {
  // Pages that list anime cards with links to anime.php?SLUG
  const listingPages = [
    `${ANIMEHEAVEN_BASE}/`,
    `${ANIMEHEAVEN_BASE}/new.php`,
    `${ANIMEHEAVEN_BASE}/popular.php`,
    `${ANIMEHEAVEN_BASE}/animes.php`,
  ];

  const seen = new Set<string>();
  const catalog: CatalogEntry[] = [];

  for (const page of listingPages) {
    let html: string;
    try {
      html = await fetchHtml(page);
    } catch {
      continue;
    }

    // Extract links of form href='anime.php?SLUG' or href="/anime.php?SLUG"
    const linkPat = /href=['"](?:\/)?anime\.php\?([^'"&#\s]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = linkPat.exec(html)) !== null) {
      const slug = m[1];
      if (seen.has(slug)) continue;
      seen.add(slug);

      // Try to grab a title near the link (look for a title/name div nearby)
      const linkIdx = m.index;
      const chunk = html.slice(Math.max(0, linkIdx - 20), linkIdx + 400);

      // Try common title patterns used by AnimeHeaven cards
      const titleMatch =
        chunk.match(/class='aname[^']*'[^>]*>([^<]+)<\//) ??
        chunk.match(/class='name[^']*'[^>]*>([^<]+)<\//) ??
        chunk.match(/alt='([^']+)'/) ??
        chunk.match(/title='([^']+)'/);

      const title = titleMatch?.[1]?.trim() ?? slug;

      // Try to grab thumbnail
      const thumbMatch = chunk.match(/src='((?:https?:\/\/|\/)[^']+\.(?:jpg|jpeg|png|webp)[^']*)'/);
      const thumbnail = thumbMatch?.[1] ?? null;

      catalog.push({ title, slug, url: `${ANIMEHEAVEN_BASE}/anime.php?${slug}`, thumbnail });
    }
  }

  return catalog;
}

// ── Routes ─────────────────────────────────────────────────────────────────────

router.get("/media/scrape", async (req: Request, res: Response) => {
  const rawUrl = req.query.url as string | undefined;

  if (!rawUrl) {
    res.status(400).json({ error: "url query param is required" });
    return;
  }

  const pageUrl = normaliseAnimeHeavenUrl(rawUrl);
  if (!pageUrl) {
    res.status(400).json({
      error: "URL must be an animeheaven.me anime page (e.g. https://animeheaven.me/anime.php?amsff)",
    });
    return;
  }

  try {
    const result = await scrapeAnimeHeavenPage(pageUrl);

    if (result.episodes.length === 0) {
      res.status(422).json({
        error: "No episodes found on that page. Make sure the URL is an anime page, not a watch page.",
      });
      return;
    }

    req.log.info({ url: pageUrl, count: result.episodes.length }, "scraper: episodes found");
    res.json(result);
  } catch (err) {
    req.log.error({ err, url: pageUrl }, "scraper: failed");
    res.status(502).json({ error: (err as Error).message ?? "Failed to scrape page" });
  }
});

// GET /api/media/catalog — scrape AnimeHeaven listing pages, return anime list
router.get("/media/catalog", requireAuth, async (req: Request, res: Response) => {
  try {
    const catalog = await scrapeAnimeHeavenCatalog();
    req.log.info({ count: catalog.length }, "catalog: scraped");
    res.json(catalog);
  } catch (err) {
    req.log.error({ err }, "catalog: failed");
    res.status(502).json({ error: (err as Error).message });
  }
});

// DELETE /api/media/auto-generated — delete all auto-generated media items
router.delete("/media/auto-generated", requireAuth, async (req: Request, res: Response) => {
  try {
    const rows = await db.select().from(mediaTable);
    const autoRows = rows.filter((r) => r.autoGenerated);
    for (const row of autoRows) {
      await db.delete(mediaTable).where(eq(mediaTable.id, row.id));
    }
    req.log.info({ deleted: autoRows.length }, "bulk-delete: auto-generated removed");
    res.json({ deleted: autoRows.length });
  } catch (err) {
    req.log.error({ err }, "bulk-delete: failed");
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/media/bulk-generate — SSE stream that scrapes catalog and creates all anime
router.get("/media/bulk-generate", requireAuth, async (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let aborted = false;
  req.on("close", () => { aborted = true; });

  try {
    send({ type: "status", message: "Scraping AnimeHeaven catalog…" });

    const catalog = await scrapeAnimeHeavenCatalog();

    if (catalog.length === 0) {
      send({ type: "error", message: "No anime found in catalog — AnimeHeaven may have changed its page structure." });
      res.end();
      return;
    }

    // Get existing titles to skip duplicates
    const existing = await db.select().from(mediaTable);
    const existingTitles = new Set(existing.map((r) => r.title.toLowerCase().trim()));

    const toImport = catalog.filter((c) => !existingTitles.has(c.title.toLowerCase().trim()));

    send({ type: "catalog", total: toImport.length, skipped: catalog.length - toImport.length });

    let imported = 0;
    let errors = 0;

    for (const entry of toImport) {
      if (aborted) break;

      send({ type: "progress", done: imported, total: toImport.length, title: entry.title, status: "fetching" });

      try {
        const scraped = await scrapeAnimeHeavenPage(entry.url);

        const id = randomUUID();
        const now = new Date();

        const episodes: Episode[] = scraped.episodes.map((ep) => ({
          episodeId: randomUUID(),
          episodeNumber: ep.number,
          episodeTitle: ep.title,
          videoUrl: ep.url,
        }));

        await db.insert(mediaTable).values({
          id,
          title: scraped.animeTitle || entry.title,
          description: scraped.description ?? "",
          thumbnail: scraped.thumbnail ?? entry.thumbnail ?? "",
          type: "series",
          movieUrl: null,
          episodes,
          autoGenerated: true,
          createdAt: now,
          updatedAt: now,
        });

        imported++;
        send({ type: "progress", done: imported, total: toImport.length, title: scraped.animeTitle || entry.title, status: "ok", episodes: episodes.length });
      } catch (err) {
        errors++;
        send({ type: "progress", done: imported, total: toImport.length, title: entry.title, status: "err", error: (err as Error).message });
      }

      // Small delay to be polite to AnimeHeaven servers
      await new Promise((r) => setTimeout(r, 300));
    }

    send({ type: "done", imported, errors, skipped: catalog.length - toImport.length });
  } catch (err) {
    req.log.error({ err }, "bulk-generate: failed");
    send({ type: "error", message: (err as Error).message });
  }

  res.end();
});

export default router;
