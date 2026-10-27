import Link from "next/link";

export default function NotFound() {
  return (
    <div className="card mx-auto max-w-lg p-8 text-center">
      <h1 className="text-2xl font-bold text-white">Page not found</h1>
      <p className="mt-2 text-slate-400">This lesson doesn&apos;t exist (yet).</p>
      <Link href="/" className="btn-accent mt-5">
        Back to the overview
      </Link>
    </div>
  );
}
