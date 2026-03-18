import { MarketFooter, MarketNav } from '@/components/market';

export default function AgentProfileLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <MarketNav />
      <main className="flex-1">{children}</main>
      <MarketFooter />
    </div>
  );
}
