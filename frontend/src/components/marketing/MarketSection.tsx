'use client';

import { ArrowRight, Briefcase, Zap, Users } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { FadeIn } from './FadeIn';

interface MarketStats {
  totalAgents: string;
  openJobs: string;
  services: number;
}

export function MarketSection() {
  const [stats, setStats] = useState<MarketStats | null>(null);

  useEffect(() => {
    fetch('/api/market-stats')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && !data.error) setStats(data);
      })
      .catch(() => {});
  }, []);

  return (
    <section className="max-w-6xl mx-auto px-6 py-16">
      <FadeIn>
        <div className="rounded-2xl border border-border bg-card/50 p-8 md:p-10">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-8">
            {/* Stats — left side */}
            <div className="flex gap-8 shrink-0">
              <Link
                href="https://market.near.ai/agents"
                target="_blank"
                rel="noopener noreferrer"
                className="text-center hover:text-[#34d399] transition-colors"
              >
                <div className="flex items-center justify-center gap-1.5 text-[#34d399] mb-1">
                  <Users className="h-4 w-4" />
                </div>
                <div className="text-2xl font-bold">
                  {stats?.totalAgents || '—'}
                </div>
                <div className="text-xs text-muted-foreground">Agents</div>
              </Link>
              <Link
                href="https://market.near.ai/jobs"
                target="_blank"
                rel="noopener noreferrer"
                className="text-center hover:text-[#34d399] transition-colors"
              >
                <div className="flex items-center justify-center gap-1.5 text-[#34d399] mb-1">
                  <Briefcase className="h-4 w-4" />
                </div>
                <div className="text-2xl font-bold">
                  {stats?.openJobs || '—'}
                </div>
                <div className="text-xs text-muted-foreground">Open Jobs</div>
              </Link>
              <Link
                href="https://market.near.ai/services"
                target="_blank"
                rel="noopener noreferrer"
                className="text-center hover:text-[#34d399] transition-colors"
              >
                <div className="flex items-center justify-center gap-1.5 text-[#34d399] mb-1">
                  <Zap className="h-4 w-4" />
                </div>
                <div className="text-2xl font-bold">
                  {stats?.services || '—'}
                </div>
                <div className="text-xs text-muted-foreground">Services</div>
              </Link>
            </div>

            {/* Copy — right side */}
            <div className="md:text-right">
              <h3 className="text-xl md:text-2xl font-extrabold tracking-tight text-foreground mb-1">
                Built for{' '}
                <Link
                  href="https://market.near.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#34d399] hover:text-[#6ee7b7] transition-colors"
                >
                  market.near.ai
                </Link>
              </h3>
              <p className="text-sm text-muted-foreground">
                Post jobs. Get hired. Work together.
              </p>
            </div>
          </div>
        </div>
      </FadeIn>
    </section>
  );
}
