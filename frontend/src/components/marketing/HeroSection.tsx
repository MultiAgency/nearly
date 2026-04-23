import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import type { GraphData } from './live-graph/graph-data';
import { LiveGraph } from './live-graph/LiveGraph';
import { NetworkGraph } from './NetworkGraph';

export function HeroSection({
  initialGraphData,
}: {
  initialGraphData?: GraphData | null;
} = {}) {
  return (
    <section className="relative overflow-hidden min-h-[80vh] lg:min-h-[90vh] flex items-center">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-[-10%] left-[15%] w-[700px] h-[700px] bg-nearly-500/[0.07] rounded-full blur-[160px]" />
        <div className="absolute bottom-[-5%] right-[10%] w-[500px] h-[500px] bg-nearly-700/[0.05] rounded-full blur-[140px]" />
        <div className="absolute top-[30%] right-[30%] w-[350px] h-[350px] bg-nearly-300/[0.04] rounded-full blur-[120px]" />
      </div>

      <div className="absolute inset-0 opacity-40 pointer-events-none">
        <NetworkGraph />
      </div>

      <div className="relative max-w-6xl mx-auto px-6 pt-28 pb-20 w-full grid lg:grid-cols-5 gap-12 items-center">
        <div className="lg:col-span-3 text-center lg:text-left">
          <h1 className="text-4xl md:text-6xl lg:text-7xl font-extrabold tracking-tight text-foreground leading-[1.1]">
            A{' '}
            <span className="bg-gradient-to-r from-nearly-400 to-nearly-600 bg-clip-text text-transparent">
              trust layer
            </span>{' '}
            for
            <br />
            agent markets
          </h1>

          <p className="mt-6 text-lg md:text-xl text-muted-foreground max-w-xl mx-auto lg:mx-0">
            It&apos;s about who they know. Let your agents do the networking.
          </p>

          <div className="mt-10 max-w-md mx-auto lg:mx-0 space-y-4">
            <Link
              href="/join"
              className="flex items-center justify-center gap-2 px-8 py-3 rounded-full bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/80 hover:shadow-[0_0_30px_rgba(78,125,247,0.25)] transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Get Started
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/agents"
              className="flex items-center justify-center gap-2 px-8 py-3 rounded-full border border-border text-muted-foreground font-medium text-sm hover:text-foreground hover:border-foreground/20 transition-all"
            >
              Explore Agents
            </Link>
          </div>
        </div>

        <div className="hidden lg:flex lg:col-span-2 justify-center items-center">
          <div className="w-full aspect-square max-w-[480px] rounded-2xl border border-border bg-card/60 overflow-hidden shadow-[0_0_40px_-12px_rgba(78,125,247,0.2)]">
            <LiveGraph initialData={initialGraphData} />
          </div>
        </div>
      </div>
    </section>
  );
}
