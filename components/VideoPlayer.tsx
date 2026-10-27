"use client";

import { useState } from "react";
import { Clapperboard, Play } from "lucide-react";

type Props = {
  videoId: string | null;
  day: number;
  title: string;
  moduleLabel: string;
};

/**
 * One video per day page.
 * - With a YouTube ID: a lightweight "click to play" thumbnail that loads the
 *   privacy-enhanced player (youtube-nocookie.com) only when clicked.
 * - Without one: a "coming soon" placeholder in the same 16:9 frame.
 */
export default function VideoPlayer({ videoId, day, title, moduleLabel }: Props) {
  const [playing, setPlaying] = useState(false);

  if (!videoId) {
    return (
      <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-slate-800 bg-slate-950">
        <div
          className="absolute inset-0 opacity-90"
          style={{
            background:
              "radial-gradient(600px 300px at 20% 10%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 70%), radial-gradient(500px 300px at 90% 100%, rgba(99,102,241,0.18), transparent 70%)",
          }}
        />
        <div
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "linear-gradient(#94a3b8 1px, transparent 1px), linear-gradient(90deg, #94a3b8 1px, transparent 1px)",
            backgroundSize: "32px 32px",
          }}
        />
        <div className="relative flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="grid h-16 w-16 place-items-center rounded-full bg-[var(--accent)]/15 ring-1 ring-[var(--accent)]/50 sm:h-20 sm:w-20">
            <Clapperboard className="h-8 w-8 text-[var(--accent)] sm:h-9 sm:w-9" />
          </div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
            Video lesson coming soon
          </div>
          <div className="max-w-xl text-lg font-semibold text-white text-balance sm:text-2xl">
            Day {day} · {title}
          </div>
          <div className="text-xs text-slate-400 sm:text-sm">
            {moduleLabel} · The recording will appear here as soon as it is published. The written lesson below is
            available now.
          </div>
        </div>
      </div>
    );
  }

  if (playing) {
    return (
      <div className="aspect-video w-full overflow-hidden rounded-2xl border border-slate-800 bg-black">
        <iframe
          className="h-full w-full"
          src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1`}
          title={`Day ${day}: ${title}`}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setPlaying(true)}
      className="group relative block aspect-video w-full overflow-hidden rounded-2xl border border-slate-800 bg-black"
      aria-label={`Play video: Day ${day}, ${title}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`}
        alt=""
        className="h-full w-full object-cover opacity-80 transition group-hover:opacity-100"
        loading="lazy"
      />
      <span className="absolute inset-0 grid place-items-center">
        <span className="grid h-16 w-16 place-items-center rounded-full bg-[var(--accent)] shadow-xl transition group-hover:scale-105 sm:h-20 sm:w-20">
          <Play className="ml-1 h-8 w-8 fill-slate-950 text-slate-950" />
        </span>
      </span>
      <span className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4 text-left text-sm font-medium text-white">
        Day {day} · {title}
      </span>
    </button>
  );
}
