# Applied Decision Intelligence & Data Architecture — Course Site

For Economists · 8 modules · 80 days · Site Created by Jean Alegue, PhD

Static Next.js 16 site (React 19, Tailwind 4, Recharts 3). Every day of the course has its own page with:
a video slot (placeholder until you add a YouTube link), learning outcomes, a "Today's plan" chart,
the full written lesson and a table of contents. A sun/moon button in the header switches between
the dark and the light (mint) background; each visitor's choice is remembered in their browser.

---

## 1. Run it locally (Windows + VS Code)

1. Install **Node.js 20 LTS or newer** (https://nodejs.org) and **Git** (https://git-scm.com).
2. Unzip the project, then in VS Code: **File → Open Folder…** and choose the folder.
3. Open a terminal (**Terminal → New Terminal**, PowerShell is fine) and run:

```powershell
npm install
npm run dev
```

4. Open http://localhost:3000. Stop the server with `Ctrl + C`.

Before pushing, you can check that the production build works:

```powershell
npm run build
```

---

## 2. Add your YouTube videos (when they are recorded)

All 80 video slots live in **one file**: `content/videos.ts`. Each day has a line:

```ts
4: "",   // pandas Fundamentals: Series and DataFrames
```

Paste the link between the quotes:

```ts
4: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
```

Any of these formats work: `watch?v=…`, `youtu.be/…`, `/embed/…`, or just the 11-character ID.
"Unlisted" videos work too. Then check and publish:

```powershell
npm run check:videos     # reports how many are published and flags malformed links
git add content/videos.ts
git commit -m "Add videos for Module 1"
git push
```

Vercel redeploys automatically within about a minute. The home page and module pages update
their "videos published" counters on their own.

---

## 3. Put it on GitHub (first time only)

Create an **empty** repository on GitHub (no README), then in the VS Code terminal:

```powershell
git init
git add .
git commit -m "Initial course site"
git branch -M main
git remote add origin https://github.com/jeduclo/applied-decision-intelligence.git
git push -u origin main
```

## 4. Deploy on Vercel (first time only)

1. Go to https://vercel.com → **Add New… → Project** → import the GitHub repository.
2. Vercel detects **Next.js** automatically. Keep all defaults and click **Deploy**.
3. From then on, every `git push` to `main` redeploys the site.

No environment variables or database are needed: the site is fully static.

---

## 5. Where things live

| What | Where |
|---|---|
| Lesson notes (private, not downloadable) | `content/notes/*.md` |
| Module titles, colours, topics, tools | `lib/modules.ts` |
| YouTube links (one per day) | `content/videos.ts` |
| Day page layout | `app/module/[slug]/day/[day]/page.tsx` |
| Module page layout | `app/module/[slug]/page.tsx` |
| Home page | `app/page.tsx` |
| Colours, light/dark themes, typography | `app/globals.css` |
| Favicon | `app/icon.svg` |

To edit a lesson, edit its Markdown file in `content/notes` and push. These files are only read at
build time to create the pages; they are not published as files, so students cannot download them. Day pages are built from
`# DAY N — Title` headings, the time-table rows (`| 9:00 – 9:45 | … |`) and the `### Day N checklist`
items, so keep those patterns when editing.

Student progress ("Mark day complete") is stored in each visitor's browser only — no accounts needed.
