import Link from 'next/link';

export default function DemoLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col items-center bg-muted/30 p-4 py-8">
      <Link href="/demo" className="flex items-center gap-2 mb-8">
        <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
          <span className="text-white font-bold">N</span>
        </div>
        <span className="text-2xl font-bold bg-gradient-to-r from-emerald-500 to-teal-600 bg-clip-text text-transparent">
          near agency
        </span>
      </Link>
      <div className="w-full max-w-2xl space-y-6">{children}</div>
    </div>
  );
}
