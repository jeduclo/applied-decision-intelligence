import Link from "next/link";
import { ArrowRight, BookOpen, CalendarClock, Clapperboard, Clock, Layers } from "lucide-react";
import VideoProgressChart, { type VideoRow } from "@/components/VideoProgressChart";
import { ModuleProgress } from "@/components/CompleteButton";
import { allModules } from "@/lib/content";
import { COURSE, PARTS, TOTAL_DAYS, dayHref } from "@/lib/modules";
import { publishedCount } from "@/lib/video";

export const dynamic = "force-static";

const CAPSTONE = [
  { component: "Extract & Load", tech: "Python, dlt, DuckDB", deliverable: "Automated ingestion of BoC, FRED and StatCan series." },
  { component: "Transform & Test", tech: "dbt, Great Expectations", deliverable: "Validated macro marts (yield spreads, real rates)." },
  { component: "Model & Forecast", tech: "DoubleML, XGBoost, Chronos", deliverable: "Causal impact models and next-quarter GDP forecasts." },
  { component: "Orchestrate & Visualise", tech: "Prefect, Plotly", deliverable: "A scheduled, monitored pipeline feeding interactive dashboards." },
];

export default function Home() {
  const modules = allModules();
  const allDayNumbers = modules.flatMap((m) => m.days.map((d) => d.number));
  const published = publishedCount(allDayNumbers);
  const rows: VideoRow[] = modules.map((m) => {
    const p = publishedCount(m.days.map((d) => d.number));
    return { module: `${m.meta.number} · ${m.meta.short}`, title: m.meta.title, published: p, pending: m.days.length - p };
  });

  const stats = [
    { icon: Layers, value: "8", label: "modules" },
    { icon: BookOpen, value: String(TOTAL_DAYS), label: "day lessons" },
    { icon: Clock, value: String(TOTAL_DAYS * COURSE.hoursPerDay), label: "hours of guided work" },
    { icon: Clapperboard, value: `${published}/${TOTAL_DAYS}`, label: "video lessons published" },
  ];

  return (
    <div className="space-y-12">
      {/* Hero */}
      <section className="grid gap-8 lg:grid-cols-[1.4fr_1fr] lg:items-end">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-teal-300">
            {COURSE.program} · 80-day technical curriculum
          </div>
          <h1 className="mt-2 text-3xl font-bold text-white text-balance sm:text-4xl">{COURSE.title}</h1>
          <p className="mt-3 max-w-2xl text-lg text-slate-300">{COURSE.tagline}</p>
          <p className="mt-3 max-w-2xl text-slate-400">
            Every day is one page with a video lesson, a timed 2.5-hour plan, the outcomes you should reach, and the full
            written lesson with step-by-step code. You work in GitHub Codespaces on real Canadian data from the Bank of
            Canada, Statistics Canada and FRED, and finish with a production pipeline, forecasts and causal estimates.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link href={dayHref(1)} className="btn-accent">
              Start Day 1 <ArrowRight size={16} />
            </Link>
            <a href="#modules" className="btn-ghost">
              Browse the modules
            </a>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {stats.map((s) => (
            <div key={s.label} className="card p-4">
              <s.icon size={18} className="text-teal-300" />
              <div className="mt-2 font-mono text-2xl font-semibold text-white">{s.value}</div>
              <div className="text-xs text-slate-400">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Video status */}
      <section className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="card p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Clapperboard size={16} className="text-teal-300" /> Video lessons by module
          </h2>
          <p className="mb-4 mt-1 text-xs text-slate-400">One video per day. Each module has ten.</p>
          <VideoProgressChart rows={rows} />
        </div>
        <div className="card p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <CalendarClock size={16} className="text-teal-300" /> How to use this site
          </h2>
          <ul className="mt-3 space-y-3 text-sm text-slate-300">
            <li>
              <span className="font-semibold text-white">Pick a module tab</span> to see what it covers, its tools and
              its ten days.
            </li>
            <li>
              <span className="font-semibold text-white">Open a day</span> to watch the video, follow the timed plan
              and work through the written lesson. Each day takes about two and a half hours.
            </li>
            <li>
              <span className="font-semibold text-white">Videos are being recorded.</span> Until a day&apos;s video is
              published, its page shows a placeholder; the written lesson is already complete.
            </li>
            <li>
              <span className="font-semibold text-white">Mark days complete</span> to track your progress. It&apos;s
              saved in this browser.
            </li>
          </ul>
        </div>
      </section>

      {/* Modules by part */}
      <section id="modules" className="space-y-10">
        {PARTS.map((part) => (
          <div key={part.id}>
            <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-xl font-bold text-white">
                Part {["I", "II", "III"][part.id - 1]}: {part.title}
              </h2>
              <span className="text-sm text-slate-500">{part.days}</span>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {modules
                .filter((m) => m.meta.part === part.id)
                .map(({ meta, days }) => {
                  const Icon = meta.icon;
                  const p = publishedCount(days.map((d) => d.number));
                  return (
                    <Link
                      key={meta.slug}
                      href={`/module/${meta.slug}`}
                      style={{ ["--accent-base" as string]: meta.accent }}
                      className="card group flex flex-col p-5 transition hover:border-[var(--accent)]/60"
                    >
                      <div className="flex items-start gap-3">
                        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--accent)]/15 ring-1 ring-[var(--accent)]/40">
                          <Icon size={22} className="text-[var(--accent)]" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--accent)]">
                            Module {meta.number} · Days {meta.firstDay}–{meta.lastDay}
                          </div>
                          <h3 className="mt-0.5 font-semibold text-white text-balance">{meta.title}</h3>
                        </div>
                      </div>
                      <p className="mt-3 text-sm text-slate-400">{meta.focus}</p>
                      <ul className="mt-3 space-y-1.5 text-sm text-slate-300">
                        {meta.topics.map((t) => (
                          <li key={t.days} className="flex gap-2">
                            <span className="w-[74px] shrink-0 font-mono text-xs leading-5 text-slate-500">{t.days}</span>
                            <span>{t.text}</span>
                          </li>
                        ))}
                      </ul>
                      <div className="mt-4 flex flex-wrap gap-1.5">
                        {meta.tools.map((t) => (
                          <span key={t} className="chip">
                            {t}
                          </span>
                        ))}
                      </div>
                      <div className="mt-auto flex items-center justify-between gap-3 pt-5">
                        <ModuleProgress first={meta.firstDay} last={meta.lastDay} />
                        <span className="flex items-center gap-1 text-xs text-slate-400">
                          <Clapperboard size={13} /> {p}/10
                        </span>
                      </div>
                      <div className="mt-3 flex items-center gap-1 text-sm font-medium text-[var(--accent)]">
                        Open module <ArrowRight size={15} className="transition group-hover:translate-x-0.5" />
                      </div>
                    </Link>
                  );
                })}
            </div>
          </div>
        ))}
      </section>

      {/* Capstone */}
      <section className="card p-5 sm:p-6">
        <h2 className="text-xl font-bold text-white">Final capstone</h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">
          The course ends with one integrated project: a Prefect-orchestrated pipeline linked to interactive dashboards,
          built on the architecture of the course&apos;s macro dashboard notebook.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
                <th className="py-2 pr-4 font-semibold">Component</th>
                <th className="py-2 pr-4 font-semibold">Technology</th>
                <th className="py-2 font-semibold">Capstone deliverable</th>
              </tr>
            </thead>
            <tbody>
              {CAPSTONE.map((r) => (
                <tr key={r.component} className="border-b border-slate-800/60 last:border-0">
                  <td className="py-3 pr-4 font-medium text-white">{r.component}</td>
                  <td className="py-3 pr-4 font-mono text-xs text-teal-300">{r.tech}</td>
                  <td className="py-3 text-slate-300">{r.deliverable}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
