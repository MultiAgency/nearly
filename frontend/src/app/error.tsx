'use client';

import { AlertTriangle, Home, RefreshCcw, WifiOff } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo } from 'react';
import { Button } from '@/components/ui';

function classifyError(error: Error): {
  title: string;
  description: string;
  icon: React.ReactNode;
} {
  const msg = error.message.toLowerCase();

  if (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('econnrefused') ||
    msg.includes('net::err_')
  ) {
    return {
      title: 'Cannot reach the server',
      description:
        'The API server appears to be offline. Make sure the backend is running.',
      icon: <WifiOff className="h-8 w-8 text-destructive" />,
    };
  }

  if (
    msg.includes('unauthorized') ||
    msg.includes('authentication') ||
    /\b401\b/.test(msg) ||
    msg.includes('403') ||
    msg.includes('forbidden')
  ) {
    return {
      title: 'Access denied',
      description: 'This action requires authentication via the API.',
      icon: <AlertTriangle className="h-8 w-8 text-destructive" />,
    };
  }

  return {
    title: 'Something went wrong',
    description: 'An unexpected error occurred. Please try again.',
    icon: <AlertTriangle className="h-8 w-8 text-destructive" />,
  };
}

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Application error:', error);
  }, [error]);

  const classified = useMemo(() => classifyError(error), [error]);

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      role="alert"
      aria-live="assertive"
    >
      <div className="text-center max-w-md">
        <div
          className="h-16 w-16 mx-auto mb-6 rounded-full bg-destructive/10 flex items-center justify-center"
          aria-hidden="true"
        >
          {classified.icon}
        </div>
        <h1 className="text-2xl font-bold mb-2">{classified.title}</h1>
        <p className="text-muted-foreground mb-6">{classified.description}</p>
        <div className="flex gap-2 justify-center">
          <Button onClick={reset} variant="outline">
            <RefreshCcw className="h-4 w-4 mr-2" />
            Try again
          </Button>
          <Link href="/">
            <Button>
              <Home className="h-4 w-4 mr-2" />
              Go home
            </Button>
          </Link>
        </div>
        {error.digest && (
          <p className="text-xs text-muted-foreground mt-4">
            Error ID: {error.digest}
          </p>
        )}
        <details className="mt-4 text-left">
          <summary className="text-xs text-muted-foreground cursor-pointer">
            Technical details
          </summary>
          <pre className="mt-2 text-xs text-muted-foreground bg-muted p-3 rounded-md overflow-auto max-h-32">
            {error.message}
          </pre>
        </details>
      </div>
    </div>
  );
}
