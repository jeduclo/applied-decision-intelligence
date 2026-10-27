import "server-only";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { MODULES, moduleForDay, type ModuleMeta } from "@/lib/modules";
import { slugify } from "@/lib/slug";

/**
 * The course content lives in content/notes/*.md (private: not served to visitors).
 * This module parses them at BUILD time: every page is static HTML on Vercel.
 */

export type BlockKind = "lesson" | "project" | "break";

export type ScheduleBlock = {
  start: string;      // "0:40"
  end: string;        // "1:25"
  startMin: number;
  minutes: number;
  label: string;
  kind: BlockKind;
};

export type Heading = { id: string; text: string };

export type Day = {
  number: number;
  title: string;        // "pandas Fundamentals: Series and DataFrames"
  shortTitle: string;   // "pandas Fundamentals"
  module: number;
  file: string;         // source Markdown file name (for downloads)
  schedule: ScheduleBlock[];
  outcomes: string[];   // the end-of-day checklist = "what you'll learn"
  headings: Heading[];  // "## " sections, for the in-page table of contents
  markdown: string;     // the full lesson notes for the day
};

export type ModuleContent = {
  meta: ModuleMeta;
  goals: { range: string; text: string }[];   // "Goal by end of Day X" per notes file
  intro: string;                              // intro of the first notes file (Markdown)
  files: { name: string; label: string }[];   // notes files (internal)
  days: Day[];
};

const NOTES_DIR = path.join(process.cwd(), "content", "notes");
const DAY_HEADING = /^# DAY (\d+) — (.+)$/gm;


function toMinutes(t: string) {
  const [h, m] = t.trim().split(":").map(Number);
  return h * 60 + m;
}

function kindOf(label: string): BlockKind {
  if (/^break$/i.test(label.trim())) return "break";
  if (/mini-project|capstone|project|drills?\b|acceptance/i.test(label)) return "project";
  return "lesson";
}

function parseSchedule(md: string): ScheduleBlock[] {
  const rows: ScheduleBlock[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\|\s*(\d+:\d{2})\s*[–-]\s*(\d+:\d{2})\s*\|\s*(.+?)\s*\|\s*$/);
    if (m) {
      const startMin = toMinutes(m[1]);
      rows.push({
        start: m[1], end: m[2], startMin,
        minutes: toMinutes(m[2]) - startMin,
        label: m[3].replace(/`/g, ""),
        kind: kindOf(m[3]),
      });
    } else if (rows.length && line.trim() === "") {
      break;   // the schedule table is the first table of the day
    }
  }
  return rows;
}

function parseOutcomes(md: string, day: number): string[] {
  const start = md.search(new RegExp(`^### Day ${day} checklist`, "m"));
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of md.slice(start).split("\n").slice(1)) {
    const m = line.match(/^- \[[ x]\] (.+)$/);
    if (m) items.push(m[1]);
    else if (items.length) break;
  }
  return items;
}

function parseHeadings(md: string): Heading[] {
  const out: Heading[] = [];
  let inCode = false;
  for (const line of md.split("\n")) {
    if (line.startsWith("```")) inCode = !inCode;
    if (inCode) continue;
    const m = line.match(/^## (.+)$/);
    if (m) out.push({ id: slugify(m[1]), text: m[1].replace(/`/g, "") });
  }
  return out;
}

function fileLabel(name: string) {
  // "Module1_Days04-07_Pandas_TimeSeries.md" → "Days 4–7 · Pandas TimeSeries"
  const m = name.match(/Days(\d+)-(\d+)_(.+)\.md$/);
  if (!m) return name;
  return `Days ${Number(m[1])}–${Number(m[2])} · ${m[3].replace(/_/g, " ")}`;
}

let cache: { days: Day[]; modules: ModuleContent[] } | null = null;

function load() {
  if (cache) return cache;
  const files = readdirSync(NOTES_DIR).filter((f) => f.endsWith(".md")).sort((a, b) => {
    const n = (s: string) => Number(s.match(/Days(\d+)/)?.[1] ?? 0);
    return n(a) - n(b);
  });

  const days: Day[] = [];
  const perModule = new Map<number, { goals: ModuleContent["goals"]; intro: string; files: ModuleContent["files"] }>();

  for (const file of files) {
    const text = readFileSync(path.join(NOTES_DIR, file), "utf8").replace(/\r\n/g, "\n");
    const matches = [...text.matchAll(DAY_HEADING)];
    if (!matches.length) continue;

    const moduleNo = Number(file.match(/^Module(\d+)/)?.[1] ?? moduleForDay(Number(matches[0][1]))?.number ?? 0);
    const entry = perModule.get(moduleNo) ?? { goals: [], intro: "", files: [] };
    entry.files.push({ name: file, label: fileLabel(file) });

    const intro = text.slice(0, matches[0].index);
    const goal = intro.match(/\*\*Goal by end of Day[^*]*\*\*\s*([\s\S]*?)(?:\n\n|\n---)/);
    const range = file.match(/Days(\d+)-(\d+)/);
    if (goal) {
      entry.goals.push({
        range: range ? `Days ${Number(range[1])}–${Number(range[2])}` : "",
        text: goal[1].replace(/\n- /g, " ").replace(/\s+/g, " ").trim(),
      });
    }
    if (!entry.intro) {
      // Drop the H1/H2 title lines; keep the explanatory intro.
      entry.intro = intro.split("\n").filter((l) => !/^#{1,2} /.test(l)).join("\n").trim();
    }
    perModule.set(moduleNo, entry);

    matches.forEach((m, i) => {
      const number = Number(m[1]);
      const body = text
        .slice(m.index! + m[0].length, i + 1 < matches.length ? matches[i + 1].index : text.length)
        .replace(/\n---\s*$/g, "")
        .trim();
      const title = m[2].trim();
      days.push({
        number,
        title,
        shortTitle: title.split(":")[0].trim(),
        module: moduleNo,
        file,
        schedule: parseSchedule(body),
        outcomes: parseOutcomes(body, number),
        headings: parseHeadings(body),
        markdown: body,
      });
    });
  }

  days.sort((a, b) => a.number - b.number);
  const modules: ModuleContent[] = MODULES.map((meta) => {
    const e = perModule.get(meta.number) ?? { goals: [], intro: "", files: [] };
    return { meta, ...e, days: days.filter((d) => d.module === meta.number) };
  });
  cache = { days, modules };
  return cache;
}

export function allDays() {
  return load().days;
}

export function getDay(n: number) {
  return load().days.find((d) => d.number === n);
}

export function getModule(slug: string) {
  return load().modules.find((m) => m.meta.slug === slug);
}

export function allModules() {
  return load().modules;
}

/** Minutes per block kind for each module (for the course-overview chart). */
export function timeByModule() {
  return load().modules.map((m) => {
    const t = { lesson: 0, project: 0, break: 0 };
    for (const d of m.days) for (const b of d.schedule) t[b.kind] += b.minutes;
    return { module: m.meta, ...t };
  });
}
