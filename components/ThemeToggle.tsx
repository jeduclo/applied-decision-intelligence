"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

const KEY = "adi-theme";
type Theme = "dark" | "light";

/** Inline script for <head>: applies the saved theme before the first paint (no flash). */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* storage unavailable: the choice lasts for this visit only */
    }
  }

  const toLight = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-slate-700 text-slate-300 transition hover:border-slate-500 hover:text-white"
      aria-label={toLight ? "Switch to light background" : "Switch to dark background"}
      title={toLight ? "Light background" : "Dark background"}
    >
      {toLight ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}
