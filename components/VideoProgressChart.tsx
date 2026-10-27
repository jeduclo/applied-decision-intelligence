"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export type VideoRow = { module: string; title: string; published: number; pending: number };

const PUBLISHED = "#3987e5";
const PENDING = "var(--color-slate-700)";

/** How many of each module's 10 day-videos are published. Updates automatically from content/videos.ts. */
export default function VideoProgressChart({ rows }: { rows: VideoRow[] }) {
  return (
    <div>
      <div className="h-[300px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 0 }} barCategoryGap={6}>
            <CartesianGrid horizontal={false} stroke="var(--color-slate-800)" />
            <XAxis
              type="number"
              domain={[0, 10]}
              ticks={[0, 2, 4, 6, 8, 10]}
              tick={{ fill: "var(--color-slate-400)", fontSize: 11 }}
              axisLine={{ stroke: "var(--color-slate-700)" }}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="module"
              width={170}
              tick={{ fill: "var(--color-slate-300)", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              interval={0}
            />
            <Tooltip
              cursor={{ fill: "rgba(148,163,184,0.08)" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const r = payload[0].payload as VideoRow;
                return (
                  <div className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs shadow-xl">
                    <div className="text-slate-100">{r.title}</div>
                    <div className="mt-1 text-slate-400">
                      {r.published} of 10 videos published · {r.pending} coming soon
                    </div>
                  </div>
                );
              }}
            />
            <Bar dataKey="published" stackId="v" fill={PUBLISHED} name="Published" isAnimationActive={false} />
            <Bar
              dataKey="pending"
              stackId="v"
              fill={PENDING}
              name="Coming soon"
              radius={[0, 4, 4, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex gap-4 text-xs text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: PUBLISHED }} /> Published
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: PENDING }} /> Coming soon
        </span>
      </div>
    </div>
  );
}
