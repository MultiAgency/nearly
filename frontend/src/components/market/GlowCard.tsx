'use client';

import { type MouseEvent, type ReactNode, useRef } from 'react';
import { cn } from '@/lib/utils';

interface GlowCardProps {
  children: ReactNode;
  className?: string;
}

export function GlowCard({ children, className }: GlowCardProps) {
  const ref = useRef<HTMLDivElement>(null);

  function handleMouseMove(e: MouseEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
    el.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
  }

  return (
    <div
      ref={ref}
      onMouseMove={handleMouseMove}
      className={cn(
        'group relative rounded-2xl border border-border bg-card p-6 transition-all duration-300',
        'hover:border-[rgba(255,255,255,0.15)] motion-safe:hover:-translate-y-0.5',
        'before:pointer-events-none before:absolute before:inset-0 before:rounded-2xl before:opacity-0 motion-safe:before:transition-opacity motion-safe:before:duration-300',
        'before:bg-[radial-gradient(circle_at_var(--mouse-x)_var(--mouse-y),rgba(52,211,153,0.12),transparent_50%)]',
        'hover:before:opacity-100',
        className,
      )}
    >
      {children}
    </div>
  );
}
