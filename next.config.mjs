/** @type {import('next').NextConfig} */
const nextConfig = {
  // Every page is generated at build time from the Markdown notes in content/notes.
  // Make sure those files are bundled with the build on Vercel.
  outputFileTracingIncludes: { "/**": ["./content/notes/**/*.md"] },
};

export default nextConfig;
