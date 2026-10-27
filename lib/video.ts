import { VIDEOS } from "@/content/videos";

const ID = /^[A-Za-z0-9_-]{11}$/;

/** Extract an 11-character YouTube video ID from a link or a bare ID. Returns null if absent/invalid. */
export function youtubeId(input: string | undefined | null): string | null {
  const s = (input ?? "").trim();
  if (!s) return null;
  if (ID.test(s)) return s;
  try {
    const url = new URL(s);
    const host = url.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return pick(url.pathname.slice(1));
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      const v = url.searchParams.get("v");
      if (v) return pick(v);
      const m = url.pathname.match(/\/(embed|shorts|live|v)\/([^/?#]+)/);
      if (m) return pick(m[2]);
    }
  } catch {
    /* not a URL */
  }
  return null;
}

function pick(candidate: string) {
  const id = candidate.split(/[?&#/]/)[0];
  return ID.test(id) ? id : null;
}

export function videoForDay(day: number): string | null {
  return youtubeId(VIDEOS[day]);
}

export function publishedCount(days: number[]): number {
  return days.filter((d) => videoForDay(d) !== null).length;
}
