"use client";

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export type PlanBlock = {
  start: string;
  end: string;
  startMin: number;
  minutes: number;
  label: string;
  kind: "lesson" | "project" | "break";
};

// Validated (dataviz palette check) on the dark card surface: blue / orange, plus a neutral for breaks.
export const KIND_COLORS = { lesson: "#3987e5", project: "#d95926", break: "var(--color-slate-600)" } as const;
export const KIND_LABELS = { lesson: "Lesson", project: "Hands-on project", break: "Break" } as const;

function fmt(min: number) {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}

/** A Gantt-style view of the 2.5-hour day: each bar spans its block's start → end time. */
export default function DayPlanChart({ blocks }: { blocks: PlanBlock[] }) {
  const data = blocks.map((b, i) => ({
    key: `${i}`,
    name: b.kind === "break" ? "Break" : b.label.length > 46 ? b.label.slice(0, 44) + "…" : b.label,
    full: b.label,
    range: [b.startMin, b.startMin + b.minutes] as [number, number],
    minutes: b.minutes,
    time: `${b.start} – ${b.end}`,
    kind: b.kind,
  }));
  const total = blocks.length ? Math.max(...blocks.map((b) => b.startMin + b.minutes)) : 300;
  const ticks = Array.from({ length: Math.floor(total / 60) + 1 }, (_, i) => i * 60);

  return (
    <div>
      <div className="h-[var(--h)] w-full" style={{ ["--h" as string]: `${Math.max(220, data.length * 34 + 40)}px` }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, bottom: 4, left: 0 }} barCategoryGap={4}>
            <CartesianGrid horizontal={false} stroke="var(--color-slate-800)" />
            <XAxis
              type="number"
              domain={[0, total]}
              ticks={ticks}
              tickFormatter={(v) => `${v / 60}h`}
              tick={{ fill: "var(--color-slate-400)", fontSize: 11 }}
              axisLine={{ stroke: "var(--color-slate-700)" }}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="name"
              width={250}
              tick={{ fill: "var(--color-slate-300)", fontSize: 11.5 }}
              axisLine={false}
              tickLine={false}
              interval={0}
            />
            <Tooltip
              cursor={{ fill: "rgba(148,163,184,0.08)" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as (typeof data)[number];
                return (
                  <div className="max-w-xs rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs shadow-xl">
                    <div className="font-mono text-slate-400">
                      {p.time} · {p.minutes} min
                    </div>
                    <div className="mt-1 text-slate-100">{p.full}</div>
                    <div className="mt-1 text-slate-400">{KIND_LABELS[p.kind]}</div>
                  </div>
                );
              }}
            />
            <Bar dataKey="range" radius={4} isAnimationActive={false}>
              {data.map((d) => (
                <Cell key={d.key} fill={KIND_COLORS[d.kind]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-400">
        {(Object.keys(KIND_LABELS) as (keyof typeof KIND_LABELS)[]).map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: KIND_COLORS[k] }} />
            {KIND_LABELS[k]}
          </span>
        ))}
        <span className="ml-auto font-mono">{fmt(total)} total</span>
      </div>
    </div>
  );
}
