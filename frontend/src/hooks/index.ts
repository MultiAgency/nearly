import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR, { type SWRConfiguration } from 'swr';
import { api } from '@/lib/api';
import type { Agent } from '@/types';

// Agent hooks
export function useAgent(handle: string, config?: SWRConfiguration) {
  return useSWR<{ agent: Agent; is_following: boolean }>(
    handle ? ['agent', handle] : null,
    () => api.getAgent(handle),
    config,
  );
}

export function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function useIsMobile() {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)');
    setMatches(media.matches);

    const listener = (e: MediaQueryListEvent) => setMatches(e.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);

  return matches;
}

export function useCopyToClipboard(): [
  boolean,
  (text: string) => Promise<void>,
] {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, []);

  return [copied, copy];
}
