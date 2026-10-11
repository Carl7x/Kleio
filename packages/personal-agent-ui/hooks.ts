import { useCallback, useEffect, useRef, useState } from 'react';

export function useResource<T>(key: string, load: (signal: AbortSignal) => Promise<T>, poll = 0) {
  const loader = useRef(load);
  loader.current = load;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ key: string; data?: T; error?: string; loading: boolean }>({ key, loading: true });
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setState(previous => ({ key, data: previous.key === key ? previous.data : undefined, loading: true }));
    loader.current(controller.signal).then(data => {
      if (!controller.signal.aborted) setState({ key, data, loading: false });
    }, error => {
      if (!controller.signal.aborted) setState(previous => ({ ...previous, key, loading: false, error: error.message || '读取失败，请重试。' }));
    });
    return () => controller.abort();
  }, [key, revision]);
  useEffect(() => {
    if (!poll) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, poll);
    return () => clearInterval(timer);
  }, [poll, refresh]);
  return { ...state, data: state.key === key ? state.data : undefined, refresh };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = useCallback(async <T,>(action: () => Promise<T>, onSuccess?: (result: T) => void, message = '') => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await action();
      if (alive.current) { onSuccess?.(result); setNotice(message); }
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : '操作未完成，请重试。');
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);
  return { busy, error, notice, run, clear: () => { setError(''); setNotice(''); } };
}

export function useDebounced(value: string, wait = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setSettled(value), wait); return () => clearTimeout(timer); }, [value, wait]);
  return settled;
}
