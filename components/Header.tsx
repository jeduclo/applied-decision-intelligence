"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CircleCheck, GraduationCap, House } from "lucide-react";
import { COURSE, MODULES, TOTAL_DAYS } from "@/lib/modules";
import { useProgress } from "@/components/ProgressProvider";
import ThemeToggle from "@/components/ThemeToggle";

export default function Header() {
  const pathname = usePathname();
  const { completed, ready } = useProgress();
  const activeSlug = pathname.match(/^\/module\/([^/]+)/)?.[1] ?? null;
  const done = completed.size;

  return (
    <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6">
        <div className="flex items-center gap-4 py-3">
          <Link href="/" className="flex min-w-0 items-center gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-teal-400 to-indigo-500">
              <GraduationCap size={20} className="text-slate-950" />
            </div>
            <div className="min-w-0">
              <div className="truncate font-semibold leading-tight text-white">{COURSE.title}</div>
              <div className="truncate text-xs text-slate-400">
                {COURSE.program} · 8 modules · {TOTAL_DAYS} days
              </div>
            </div>
          </Link>
          <div className="ml-auto hidden shrink-0 items-center gap-2 text-xs text-slate-400 sm:flex" title="Saved in this browser">
            <div className="h-1.5 w-28 overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full bg-emerald-400 transition-all"
                style={{ width: `${ready ? (done / TOTAL_DAYS) * 100 : 0}%` }}
              />
            </div>
            <span className="tabular-nums">{ready ? done : 0}/{TOTAL_DAYS} days done</span>
          </div>
          <ThemeToggle />
        </div>

        <nav className="no-scrollbar -mb-px flex gap-1 overflow-x-auto" aria-label="Modules">
          <Link
            href="/"
            className={`flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition ${
              pathname === "/" ? "border-teal-400 text-white" : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <House size={14} /> Overview
          </Link>
          {MODULES.map((m) => {
            const isActive = m.slug === activeSlug;
            const finished =
              ready && Array.from({ length: m.lastDay - m.firstDay + 1 }, (_, i) => m.firstDay + i).every((d) =>
                completed.has(d),
              );
            return (
              <Link
                key={m.slug}
                href={`/module/${m.slug}`}
                style={{ ["--tab-base" as string]: m.accent }}
                aria-current={isActive ? "page" : undefined}
                className={`flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition ${
                  isActive ? "border-[var(--tab)] text-white" : "border-transparent text-slate-400 hover:text-slate-200"
                }`}
              >
                <span className={`font-mono text-xs ${isActive ? "text-[var(--tab)]" : "text-slate-500"}`}>
                  {String(m.number).padStart(2, "0")}
                </span>
                <span className="whitespace-nowrap">{m.short}</span>
                {finished && <CircleCheck size={13} className="text-emerald-400" aria-label="completed" />}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
