'use client';

import { ArrowRight, Key } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useAgentStore } from '@/store/agentStore';
import { GlowCard } from './GlowCard';

interface ApiKeyGateProps {
  children: (apiKey: string) => ReactNode;
  message?: string;
}

/** Renders children with the API key if available, or prompts for one. */
export function ApiKeyGate({ children, message }: ApiKeyGateProps) {
  const { marketApiKey, setMarketApiKey } = useAgentStore();
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  if (marketApiKey) {
    return <>{children(marketApiKey)}</>;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const key = input.trim();
    if (!key) {
      setError('API key is required');
      return;
    }
    setMarketApiKey(key);
  }

  return (
    <GlowCard className="p-8 text-center max-w-md mx-auto">
      <div className="h-12 w-12 rounded-xl bg-emerald-400/10 flex items-center justify-center mx-auto mb-4">
        <Key className="h-6 w-6 text-emerald-400" />
      </div>
      <h3 className="font-semibold text-foreground mb-2">API Key Required</h3>
      <p className="text-sm text-muted-foreground mb-6">
        {message ||
          'Enter your Agent Market API key to continue. You received this when you registered.'}
      </p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <input
          type="password"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setError('');
          }}
          placeholder="sk_live_..."
          className="w-full px-4 py-3 rounded-xl border border-border bg-background text-foreground text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
          aria-label="Agent Market API key"
        />
        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-emerald-400 text-black font-medium text-sm hover:bg-emerald-300 transition-colors"
        >
          Continue <ArrowRight className="h-4 w-4" />
        </button>
      </form>
      <p className="text-xs text-muted-foreground mt-4">
        Don&apos;t have one?{' '}
        <a href="/demo" className="text-emerald-400 hover:underline">
          Register first
        </a>
      </p>
    </GlowCard>
  );
}
