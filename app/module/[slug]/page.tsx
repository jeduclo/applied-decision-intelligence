import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, BookOpen, Clapperboard, ListChecks, Target, Wrench } from "lucide-react";
import Inline from "@/components/Inline";
import Markdown from "@/components/Markdown";
import { DoneMark, ModuleProgress } from "@/components/CompleteButton";
import { getModule } from "@/lib/content";
import { MODULES, PARTS, dayHref } from "@/lib/modules";
import { publishedCount, videoForDay } from "@/lib/video";

export const dynamicParams = false;

export function generateStaticParams() {
  return MODULES.map((m) => ({ slug: m.slug }));
}

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const mod = getModule(slug);
  return mod
    ? { title: `Module ${mod.meta.number}: ${mod.meta.title}`, description: mod.meta.focus }
    : {};
}

export default async function ModulePage({ params }: Params) {
  const { slug } = await params;
  const mod = getModule(slug);
  if (!mod) notFound();
  const { meta, days, goals, intro } = mod;
  const Icon = meta.icon;
  const part = PARTS.find((p) => p.id === meta.part)!;
  const published = publishedCount(days.map((d) => d.number));

  return (
    <div style={{ ["--accent-base" as string]: meta.accent }} className="space-y-8">
      {/* Module header */}
      <section className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 gap-4">
          <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-[var(--accent)]/15 ring-1 ring-[var(--accent)]/40">
            <Icon size={28} className="text-[var(--accent)]" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
              Module {meta.number} · Days {meta.firstDay}–{meta.lastDay} · Part {["I", "II", "III"][part.id - 1]}
            </div>
            <h1 className="mt-1 text-2xl font-bold text-white text-balance sm:text-3xl">{meta.title}</h1>
            <p className="mt-1 text-slate-400">{meta.focus}</p>
          </div>
        </div>
        <div className="flex flex-col items-start gap-3 lg:items-end">
          <Link href={dayHref(meta.firstDay)} className="btn-accent">
            Start Day {meta.firstDay} <ArrowRight size={16} />
          </Link>
          <div className="flex flex-wrap items-center gap-4">
            <ModuleProgress first={meta.firstDay} last={meta.lastDay} />
            <span className="flex items-center gap-1.5 text-xs text-slate-400">
              <Clapperboard size={14} /> {published}/{days.length} videos published
            </span>
          </div>
        </div>
      </section>

      {/* What you'll learn */}
      <section className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <div className="card p-5 sm:p-6">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Target size={16} className="text-[var(--accent)]" /> What you&apos;ll learn
          </h2>
          <ol className="mt-4 space-y-5">
            {meta.topics.map((t, i) => (
              <li key={t.days} className="flex gap-4">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--accent)]/15 font-mono text-xs font-semibold text-[var(--accent)] ring-1 ring-[var(--accent)]/40">
                  {i + 1}
                </span>
                <div>
                  <div className="font-mono text-xs text-slate-500">{t.days}</div>
                  <div className="font-medium text-white">{t.text}</div>
                  {goals[i] && <p className="mt-1 text-sm text-slate-400">By the end: <Inline text={goals[i].text} /></p>}
                </div>
              </li>
            ))}
          </ol>
        </div>
        <div className="space-y-6">
          <div className="card p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <Wrench size={16} className="text-[var(--accent)]" /> Tools
            </h2>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {meta.tools.map((t) => (
                <span key={t} className="chip">
                  {t}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Days */}
      <section>
        <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-white">
          <BookOpen size={18} className="text-[var(--accent)]" /> The ten days
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {days.map((d) => {
            const hasVideo = videoForDay(d.number) !== null;
            return (
              <Link
                key={d.number}
                href={dayHref(d.number)}
                className="card group flex flex-col p-4 transition hover:border-[var(--accent)]/60"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-semibold text-[var(--accent)]">DAY {d.number}</span>
                  <DoneMark day={d.number} />
                </div>
                <div className="mt-2 font-medium leading-snug text-white">
                  <Inline text={d.shortTitle} />
                </div>
                <div className="mt-auto flex items-center justify-between pt-4 text-xs text-slate-400">
                  <span className="flex items-center gap-1">
                    <ListChecks size={13} /> {d.outcomes.length} outcomes
                  </span>
                  <span
                    className={`flex items-center gap-1 ${hasVideo ? "text-[var(--accent)]" : "text-slate-500"}`}
                  >
                    <Clapperboard size={13} /> {hasVideo ? "Video" : "Soon"}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Module intro from the notes */}
      {intro && (
        <section className="card p-5 sm:p-6">
          <details>
            <summary className="cursor-pointer text-sm font-semibold text-[var(--accent)]">
              Before you start: module setup and project structure
            </summary>
            <div className="mt-4">
              <Markdown source={intro} />
            </div>
          </details>
        </section>
      )}
    </div>
  );
}
