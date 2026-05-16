export type VideoType = "direct" | "youtube" | "unsupported";

export interface ResolvedVideo {
  type: VideoType;
  resolvedUrl: string;
  originalUrl: string;
}

const DIRECT_EXT = /\.(mp4|webm|ogg|mov|m4v|mkv)(\?.*)?$/i;

const YOUTUBE_RE =
  /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/;

const DRIVE_RE = /drive\.google\.com\/file\/d\/([^/?#]+)/;

export function resolveVideoUrl(url: string): ResolvedVideo {
  const original = url;

  if (!url || url.trim() === "") {
    return { type: "unsupported", resolvedUrl: url, originalUrl: original };
  }

  // --- Platform-specific checks first (before extension sniffing) ---

  // YouTube → convert to nocookie embed
  const ytMatch = url.match(YOUTUBE_RE);
  if (ytMatch) {
    const videoId = ytMatch[1];
    const embedUrl = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0`;
    return { type: "youtube", resolvedUrl: embedUrl, originalUrl: original };
  }

  // Google Drive → use /preview embed (iframe-based player)
  const driveMatch = url.match(DRIVE_RE);
  if (driveMatch) {
    const fileId = driveMatch[1];
    const previewUrl = `https://drive.google.com/file/d/${fileId}/preview`;
    return { type: "youtube", resolvedUrl: previewUrl, originalUrl: original };
  }

  // Dropbox sharing URL → convert to direct-download CDN URL
  // Must run before extension check because sharing URLs contain .mp4 in path
  if (/dropbox\.com/i.test(url)) {
    let resolved = url
      .replace("www.dropbox.com", "dl.dropboxusercontent.com")
      .replace(/[?&]dl=0/, "");
    const sep = resolved.includes("?") ? "&" : "?";
    resolved = `${resolved}${sep}dl=1`;
    return { type: "direct", resolvedUrl: resolved, originalUrl: original };
  }

  // Direct video file extensions → pass through as-is
  if (DIRECT_EXT.test(url)) {
    return { type: "direct", resolvedUrl: url, originalUrl: original };
  }

  return { type: "unsupported", resolvedUrl: url, originalUrl: original };
}
