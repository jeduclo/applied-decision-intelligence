"use client";

import { CircleCheck, Circle } from "lucide-react";
import { useProgress } from "@/components/ProgressProvider";

export default function CompleteButton({ day }: { day: number }) {
  const { isDone, toggle, ready } = useProgress();
  const done = ready && isDone(day);
  return (
    <button
      type="button"
      onClick={() => toggle(day)}
      aria-pressed={done}
      className={`inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium transition ${
        done
          ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
          : "border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white"
      }`}
    >
      {done ? <CircleCheck size={16} /> : <Circle size={16} />}
      {done ? "Day completed" : "Mark day as complete"}
    </button>
  );
}

export function DoneMark({ day }: { day: number }) {
  const { isDone, ready } = useProgress();
  if (!ready || !isDone(day)) return null;
  return <CircleCheck size={15} className="text-emerald-400" aria-label="completed" />;
}

export function ModuleProgress({ first, last }: { first: number; last: number }) {
  const { completed, ready } = useProgress();
  let n = 0;
  for (let d = first; d <= last; d++) if (completed.has(d)) n++;
  const total = last - first + 1;
  return (
    <div className="flex items-center gap-2 text-xs text-slate-400">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-800">
        <div className="h-full bg-emerald-400" style={{ width: `${ready ? (n / total) * 100 : 0}%` }} />
      </div>
      <span className="tabular-nums">
        {ready ? n : 0}/{total} days completed
      </span>
    </div>
  );
}
