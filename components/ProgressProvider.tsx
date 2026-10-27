"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * Per-browser progress ("I finished this day"), stored in localStorage.
 * No account or backend needed; it simply stays on the student's device.
 */
const KEY = "adi-course-progress-v1";

type Progress = {
  completed: Set<number>;
  ready: boolean;
  toggle: (day: number) => void;
  isDone: (day: number) => boolean;
};

const Ctx = createContext<Progress | null>(null);

export function ProgressProvider({ children }: { children: React.ReactNode }) {
  const [completed, setCompleted] = useState<Set<number>>(new Set());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) setCompleted(new Set(JSON.parse(raw) as number[]));
    } catch {
      /* storage unavailable (private mode): progress just isn't saved */
    }
    setReady(true);
  }, []);

  const toggle = useCallback((day: number) => {
    setCompleted((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      try {
        window.localStorage.setItem(KEY, JSON.stringify([...next].sort((a, b) => a - b)));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const value = useMemo<Progress>(
    () => ({ completed, ready, toggle, isDone: (d) => completed.has(d) }),
    [completed, ready, toggle],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProgress() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useProgress must be used inside <ProgressProvider>");
  return ctx;
}
