import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight, Clock, ListChecks } from "lucide-react";
import CompleteButton, { DoneMark } from "@/components/CompleteButton";
import DayPlanChart from "@/components/DayPlanChart";
import Inline from "@/components/Inline";
import Markdown from "@/components/Markdown";
import VideoPlayer from "@/components/VideoPlayer";
import { allDays, getDay, getModule } from "@/lib/content";
import { TOTAL_DAYS, dayHref, moduleForDay } from "@/lib/modules";
import { videoForDay } from "@/lib/video";

export const dynamicParams = false;

export function generateStaticParams() {
  return allDays().map((d) => ({ slug: moduleForDay(d.number)!.slug, day: String(d.number) }));
}

type Params = { params: Promise<{ slug: string; day: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { day } = await params;
  const d = getDay(Number(day));
  return d ? { title: `Day ${d.number}: ${d.title.replace(/`/g, "")}` } : {};
}

export default async function DayPage({ params }: Params) {
  const { slug, day } = await params;
  const mod = getModule(slug);
  const d = getDay(Number(day));
  if (!mod || !d || d.module !== mod.meta.number) notFound();
  const { meta } = mod;
  const prev = d.number > 1 ? getDay(d.number - 1) : undefined;
  const next = d.number < TOTAL_DAYS ? getDay(d.number + 1) : undefined;
  const hours = d.schedule.reduce((a, b) => a + b.minutes, 0) / 60;

  return (
    <div style={{ ["--accent-base" as string]: meta.accent }} className="space-y-6">
      {/* Breadcrumb + day tabs */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <nav className="text-sm text-slate-400" aria-label="Breadcrumb">
          <Link href="/" className="hover:text-white">
            Overview
          </Link>
          <span className="mx-2 text-slate-600">/</span>
          <Link href={`/module/${meta.slug}`} className="hover:text-white">
            Module {meta.number}: {meta.short}
          </Link>
          <span className="mx-2 text-slate-600">/</span>
          <span className="text-slate-200">Day {d.number}</span>
        </nav>
        <div className="no-scrollbar flex gap-1 overflow-x-auto rounded-xl border border-slate-800 bg-slate-900 p-1">
          {mod.days.map((x) => (
            <Link
              key={x.number}
              href={dayHref(x.number)}
              aria-current={x.number === d.number ? "page" : undefined}
              className={`shrink-0 rounded-lg px-3 py-1.5 font-mono text-xs font-medium transition ${
                x.number === d.number ? "bg-[var(--accent)] text-slate-950" : "text-slate-400 hover:text-white"
              }`}
              title={x.title.replace(/`/g, "")}
            >
              D{x.number}
            </Link>
          ))}
        </div>
      </div>

      {/* Title */}
      <section>
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
          Module {meta.number} · Day {d.number} of {TOTAL_DAYS}
        </div>
        <h1 className="mt-1 text-2xl font-bold text-white text-balance sm:text-3xl">
          <Inline text={d.title} />
        </h1>
        <div className="mt-2 flex items-center gap-3 text-sm text-slate-400">
          <span className="flex items-center gap-1.5">
            <Clock size={14} /> About {Number(hours.toFixed(1))} hours
          </span>
          <DoneMark day={d.number} />
        </div>
      </section>

      {/* Video + outcomes */}
      <section className="grid gap-6 xl:grid-cols-[1.75fr_1fr]">
        <VideoPlayer
          videoId={videoForDay(d.number)}
          day={d.number}
          title={d.shortTitle.replace(/`/g, "")}
          moduleLabel={`Module ${meta.number}: ${meta.title}`}
        />
        <div className="card flex flex-col p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <ListChecks size={16} className="text-[var(--accent)]" /> What you&apos;ll learn today
          </h2>
          <ul className="mt-3 space-y-2.5 text-sm text-slate-300">
            {d.outcomes.map((o) => (
              <li key={o} className="flex gap-2.5">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
                <span>
                  <Inline text={o} />
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-auto pt-5">
            <CompleteButton day={d.number} />
          </div>
        </div>
      </section>

      {/* Day plan */}
      <section className="card p-5">
        <h2 className="text-sm font-semibold text-slate-100">Today&apos;s plan</h2>
        <p className="mb-4 mt-1 text-xs text-slate-400">Timed blocks for the day. Hover a bar for details.</p>
        <DayPlanChart blocks={d.schedule} />
      </section>

      {/* Lesson notes with table of contents */}
      <section className="grid gap-8 xl:grid-cols-[240px_1fr]">
        <aside className="hidden xl:block">
          <div className="sticky top-32 space-y-4">
            <div className="label">In this lesson</div>
            <ul className="space-y-1.5 border-l border-slate-800 text-sm">
              {d.headings.map((h) => (
                <li key={h.id}>
                  <a href={`#${h.id}`} className="-ml-px block border-l border-transparent pl-3 text-slate-400 hover:border-[var(--accent)] hover:text-white">
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </aside>
        <article className="card min-w-0 p-5 sm:p-8">
          <div className="label mb-2">Written lesson</div>
          <Markdown source={d.markdown} />
        </article>
      </section>

      {/* Prev / next */}
      <nav className="grid gap-3 sm:grid-cols-2" aria-label="Day navigation">
        {prev ? (
          <Link href={dayHref(prev.number)} className="card group p-4 transition hover:border-slate-600">
            <div className="flex items-center gap-1 text-xs text-slate-500">
              <ChevronLeft size={14} /> Day {prev.number}
            </div>
            <div className="mt-1 font-medium text-slate-200 group-hover:text-white">
              <Inline text={prev.shortTitle} />
            </div>
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link href={dayHref(next.number)} className="card group p-4 text-right transition hover:border-slate-600">
            <div className="flex items-center justify-end gap-1 text-xs text-slate-500">
              Day {next.number}
              {moduleForDay(next.number)!.number !== meta.number && ` · Module ${moduleForDay(next.number)!.number}`}
              <ChevronRight size={14} />
            </div>
            <div className="mt-1 font-medium text-slate-200 group-hover:text-white">
              <Inline text={next.shortTitle} />
            </div>
          </Link>
        )}
      </nav>
    </div>
  );
}
