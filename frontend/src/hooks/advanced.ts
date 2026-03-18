import {
  type DependencyList,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import { throttle } from '@/lib/utils';

// Optimistic update hook
export function useOptimisticUpdate<T>(
  initialValue: T,
  updateFn: (value: T) => Promise<T>,
  rollbackFn?: (error: Error, previousValue: T) => void,
) {
  const [value, setValue] = useState(initialValue);
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const previousValueRef = useRef(initialValue);

  const update = useCallback(
    async (newValue: T) => {
      previousValueRef.current = value;
      setValue(newValue); // Optimistic update
      setIsUpdating(true);
      setError(null);

      try {
        const result = await updateFn(newValue);
        setValue(result);
        return result;
      } catch (err) {
        const error = err as Error;
        setError(error);
        setValue(previousValueRef.current); // Rollback
        rollbackFn?.(error, previousValueRef.current);
        throw error;
      } finally {
        setIsUpdating(false);
      }
    },
    [value, updateFn, rollbackFn],
  );

  return { value, update, isUpdating, error };
}

// Infinite scroll with cursor pagination
export function useInfiniteCursor<T>(
  fetchFn: (cursor?: string) => Promise<{ data: T[]; nextCursor?: string }>,
  options: { enabled?: boolean; initialCursor?: string } = {},
) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState(options.initialCursor);
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;

    setIsLoadingMore(true);
    try {
      const result = await fetchFn(cursor);
      setItems((prev) => [...prev, ...result.data]);
      setCursor(result.nextCursor);
      setHasMore(!!result.nextCursor);
    } catch (err) {
      setError(err as Error);
    } finally {
      setIsLoadingMore(false);
    }
  }, [fetchFn, cursor, hasMore, isLoadingMore]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchFn();
      setItems(result.data);
      setCursor(result.nextCursor);
      setHasMore(!!result.nextCursor);
    } catch (err) {
      setError(err as Error);
    } finally {
      setIsLoading(false);
    }
  }, [fetchFn]);

  useEffect(() => {
    if (options.enabled !== false) refresh();
  }, [options.enabled, refresh]);

  return { items, loadMore, refresh, hasMore, isLoading, isLoadingMore, error };
}

// Mutation hook with loading and error states
export function useMutation<TInput, TOutput>(
  mutationFn: (input: TInput) => Promise<TOutput>,
  options?: {
    onSuccess?: (data: TOutput) => void;
    onError?: (error: Error) => void;
    onSettled?: () => void;
  },
) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<TOutput | null>(null);

  const mutate = useCallback(
    async (input: TInput) => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await mutationFn(input);
        setData(result);
        options?.onSuccess?.(result);
        return result;
      } catch (err) {
        const error = err as Error;
        setError(error);
        options?.onError?.(error);
        throw error;
      } finally {
        setIsLoading(false);
        options?.onSettled?.();
      }
    },
    [mutationFn, options],
  );

  const reset = useCallback(() => {
    setIsLoading(false);
    setError(null);
    setData(null);
  }, []);

  return { mutate, isLoading, error, data, reset };
}

// Form state machine hook
type FormState = 'idle' | 'submitting' | 'success' | 'error';
type FormAction =
  | { type: 'SUBMIT' }
  | { type: 'SUCCESS' }
  | { type: 'ERROR'; error: string }
  | { type: 'RESET' };

function formReducer(
  state: { status: FormState; error: string | null },
  action: FormAction,
) {
  switch (action.type) {
    case 'SUBMIT':
      return { status: 'submitting' as const, error: null };
    case 'SUCCESS':
      return { status: 'success' as const, error: null };
    case 'ERROR':
      return { status: 'error' as const, error: action.error };
    case 'RESET':
      return { status: 'idle' as const, error: null };
    default:
      return state;
  }
}

export function useFormState() {
  const [state, dispatch] = useReducer(formReducer, {
    status: 'idle',
    error: null,
  });

  return {
    ...state,
    isIdle: state.status === 'idle',
    isSubmitting: state.status === 'submitting',
    isSuccess: state.status === 'success',
    isError: state.status === 'error',
    submit: () => dispatch({ type: 'SUBMIT' }),
    success: () => dispatch({ type: 'SUCCESS' }),
    setError: (error: string) => dispatch({ type: 'ERROR', error }),
    reset: () => dispatch({ type: 'RESET' }),
  };
}

// Lazy load hook
export function useLazyLoad<T>(loadFn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    if (loadedRef.current) return data;

    setIsLoading(true);
    try {
      const result = await loadFn();
      setData(result);
      loadedRef.current = true;
      return result;
    } catch (err) {
      setError(err as Error);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [loadFn, data]);

  return { data, load, isLoading, error, isLoaded: loadedRef.current };
}

// Interval hook
export function useInterval(callback: () => void, delay: number | null) {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delay === null) return;
    const id = setInterval(() => savedCallback.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}

// Timeout hook
export function useTimeout(callback: () => void, delay: number | null) {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delay === null) return;
    const id = setTimeout(() => savedCallback.current(), delay);
    return () => clearTimeout(id);
  }, [delay]);
}

// Lock body scroll
export function useLockBodyScroll(lock: boolean) {
  useEffect(() => {
    if (!lock) return;

    const originalStyle = window.getComputedStyle(document.body).overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = originalStyle;
    };
  }, [lock]);
}

// Focus trap hook
export function useFocusTrap(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active || !ref.current) return;

    const element = ref.current;
    const focusableElements = element.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    };

    firstElement?.focus();
    element.addEventListener('keydown', handleKeyDown);
    return () => element.removeEventListener('keydown', handleKeyDown);
  }, [active]);

  return ref;
}

// Async effect hook
export function useAsyncEffect(
  effect: () => Promise<undefined | (() => void)>,
  deps: DependencyList,
) {
  useEffect(() => {
    let cleanup: undefined | (() => void);
    let cancelled = false;

    (async () => {
      try {
        cleanup = await effect();
      } catch (error) {
        if (!cancelled) console.error('Async effect error:', error);
      }
    })();

    return () => {
      cancelled = true;
      if (typeof cleanup === 'function') cleanup();
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: deps passed by caller
  }, deps);
}

// Event listener hook
export function useEventListener<K extends keyof WindowEventMap>(
  eventName: K,
  handler: (event: WindowEventMap[K]) => void,
  element: Window | HTMLElement | null = typeof window !== 'undefined'
    ? window
    : null,
) {
  const savedHandler = useRef(handler);

  useEffect(() => {
    savedHandler.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!element) return;

    const eventListener = (event: Event) =>
      savedHandler.current(event as WindowEventMap[K]);
    element.addEventListener(eventName, eventListener);
    return () => element.removeEventListener(eventName, eventListener);
  }, [eventName, element]);
}

// Hover state hook
export function useHover<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  boolean,
] {
  const [isHovered, setIsHovered] = useState(false);
  const ref = useRef<T>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const handleMouseEnter = () => setIsHovered(true);
    const handleMouseLeave = () => setIsHovered(false);

    node.addEventListener('mouseenter', handleMouseEnter);
    node.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      node.removeEventListener('mouseenter', handleMouseEnter);
      node.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, []);

  return [ref, isHovered];
}

// Window size hook
export function useWindowSize() {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const handleResize = () => {
      setSize({ width: window.innerWidth, height: window.innerHeight });
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return size;
}

// Scroll position hook
export function useScrollPosition() {
  const [scrollPosition, setScrollPosition] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handleScroll = throttle(() => {
      setScrollPosition({ x: window.scrollX, y: window.scrollY });
    }, 100);

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return scrollPosition;
}

// Document title hook
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = title;
    return () => {
      document.title = previousTitle;
    };
  }, [title]);
}
