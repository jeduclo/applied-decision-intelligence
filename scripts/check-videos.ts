/**
 * Lists which day pages have a video and flags malformed links.
 * Run: npm run check:videos
 */
import { VIDEOS } from "../content/videos";
import { youtubeId } from "../lib/video";

let published = 0;
const problems: string[] = [];
for (let day = 1; day <= 80; day++) {
  const raw = (VIDEOS[day] ?? "").trim();
  if (!raw) continue;
  if (youtubeId(raw)) published++;
  else problems.push(`Day ${day}: could not read a YouTube video ID from "${raw}"`);
}
console.log(`Videos published: ${published}/80`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
