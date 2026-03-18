'use client';

import { usePathname } from 'next/navigation';
import { ThemeProvider as NextThemesProvider } from 'next-themes';
import * as React from 'react';
import { Toaster } from 'sonner';
import { SWRConfig } from 'swr';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store';

// SWR configuration
const swrConfig = {
  revalidateOnFocus: false,
  revalidateIfStale: true,
  shouldRetryOnError: true,
  errorRetryCount: 2,
  dedupingInterval: 2000,
};

// Auth provider to initialize auth state
function AuthProvider({ children }: { children: React.ReactNode }) {
  const { apiKey, refresh } = useAuthStore();
  const [isInitialized, setIsInitialized] = React.useState(false);

  React.useEffect(() => {
    const init = async () => {
      if (apiKey) {
        api.setApiKey(apiKey);
        await refresh();
      }
      setIsInitialized(true);
    };
    init();
  }, [apiKey, refresh]);

  if (!isInitialized) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return <>{children}</>;
}

// Keyboard shortcuts provider
interface ShortcutContextType {
  registerShortcut: (
    key: string,
    handler: () => void,
    options?: { ctrl?: boolean; shift?: boolean; alt?: boolean },
  ) => void;
  unregisterShortcut: (key: string) => void;
}

const ShortcutContext = React.createContext<ShortcutContextType | null>(null);

export function useShortcuts() {
  const context = React.useContext(ShortcutContext);
  if (!context)
    throw new Error('useShortcuts must be used within ShortcutProvider');
  return context;
}

function ShortcutProvider({ children }: { children: React.ReactNode }) {
  const shortcutsRef = React.useRef<
    Map<
      string,
      {
        handler: () => void;
        options: { ctrl?: boolean; shift?: boolean; alt?: boolean };
      }
    >
  >(new Map());

  const registerShortcut = React.useCallback(
    (key: string, handler: () => void, options = {}) => {
      shortcutsRef.current.set(key, { handler, options });
    },
    [],
  );

  const unregisterShortcut = React.useCallback((key: string) => {
    shortcutsRef.current.delete(key);
  }, []);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger in input fields
      if (
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(
          (e.target as HTMLElement).tagName,
        )
      )
        return;

      shortcutsRef.current.forEach(({ handler, options }, key) => {
        const ctrlMatch = !options.ctrl || e.ctrlKey || e.metaKey;
        const shiftMatch = !options.shift || e.shiftKey;
        const altMatch = !options.alt || e.altKey;

        if (
          e.key.toLowerCase() === key.toLowerCase() &&
          ctrlMatch &&
          shiftMatch &&
          altMatch
        ) {
          e.preventDefault();
          handler();
        }
      });
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <ShortcutContext.Provider value={{ registerShortcut, unregisterShortcut }}>
      {children}
    </ShortcutContext.Provider>
  );
}

// Online status provider
interface OnlineContextType {
  isOnline: boolean;
}

const OnlineContext = React.createContext<OnlineContextType>({
  isOnline: true,
});

export function useOnlineStatus() {
  return React.useContext(OnlineContext);
}

function OnlineProvider({ children }: { children: React.ReactNode }) {
  const [isOnline, setIsOnline] = React.useState(true);

  React.useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return (
    <OnlineContext.Provider value={{ isOnline }}>
      {children}
      {!isOnline && (
        <div className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-80 p-4 bg-destructive text-destructive-foreground rounded-lg shadow-lg z-50 animate-in slide-in-from-bottom">
          <p className="font-medium">You're offline</p>
          <p className="text-sm opacity-90">
            Some features may not work properly
          </p>
        </div>
      )}
    </OnlineContext.Provider>
  );
}

// Modal context for global modals
interface ModalContextType {
  openModal: (name: string, props?: Record<string, unknown>) => void;
  closeModal: () => void;
  modal: { name: string; props?: Record<string, unknown> } | null;
}

const ModalContext = React.createContext<ModalContextType | null>(null);

export function useModal() {
  const context = React.useContext(ModalContext);
  if (!context) throw new Error('useModal must be used within ModalProvider');
  return context;
}

function ModalProvider({ children }: { children: React.ReactNode }) {
  const [modal, setModal] = React.useState<{
    name: string;
    props?: Record<string, unknown>;
  } | null>(null);

  const openModal = React.useCallback(
    (name: string, props?: Record<string, unknown>) => {
      setModal({ name, props });
    },
    [],
  );

  const closeModal = React.useCallback(() => {
    setModal(null);
  }, []);

  // Close on escape
  React.useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && modal) closeModal();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [modal, closeModal]);

  return (
    <ModalContext.Provider value={{ openModal, closeModal, modal }}>
      {children}
    </ModalContext.Provider>
  );
}

// Scroll restoration
function ScrollRestoration({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const scrollPositions = React.useRef<Map<string, number>>(new Map());

  React.useEffect(() => {
    // Save scroll position before navigation
    const saveScroll = () => {
      scrollPositions.current.set(pathname, window.scrollY);
    };

    // Restore scroll position
    const savedPosition = scrollPositions.current.get(pathname);
    if (savedPosition !== undefined) {
      window.scrollTo(0, savedPosition);
    } else {
      window.scrollTo(0, 0);
    }

    window.addEventListener('beforeunload', saveScroll);
    return () => window.removeEventListener('beforeunload', saveScroll);
  }, [pathname]);

  return <>{children}</>;
}

// Main providers wrapper
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig value={swrConfig}>
      <NextThemesProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        <AuthProvider>
          <OnlineProvider>
            <ShortcutProvider>
              <ModalProvider>
                <ScrollRestoration>{children}</ScrollRestoration>
              </ModalProvider>
            </ShortcutProvider>
          </OnlineProvider>
        </AuthProvider>
        <Toaster position="bottom-right" richColors closeButton />
      </NextThemesProvider>
    </SWRConfig>
  );
}
