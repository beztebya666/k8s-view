// usePersistedState — useState backed by localStorage. Reads on first mount,
// writes on every set. Storage failures are non-fatal — the in-memory value
// stays correct, only persistence is lost.
//
// Why not zustand for this: these are tiny per-feature toggles (logs:
// "Show timestamps", "Show resource name", etc.) that don't need cross-
// component coordination. Reaching for the global store for a single boolean
// each is overkill, and the localStorage round-trip is the actual contract
// the user cares about — so keep it explicit.

import { useCallback, useEffect, useRef, useState } from "react";

export function usePersistedState<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readStored(key, initial));

  // Keep cross-tab state in sync — the storage event fires on every other
  // tab whenever localStorage is written, so toggling "Show timestamps" in
  // one logs tab is reflected in the others.
  const keyRef = useRef(key);
  keyRef.current = key;
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== window.localStorage) return;
      if (e.key !== keyRef.current) return;
      setValue(decode<T>(e.newValue, initial));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
    // `initial` deliberately not in deps — change of the initial value
    // shouldn't reset a stored choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = useCallback((next: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      try {
        window.localStorage.setItem(keyRef.current, JSON.stringify(resolved));
      } catch {
        // quota / private mode / disabled — ignore; in-memory value still updates
      }
      return resolved;
    });
  }, []);

  return [value, set];
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return decode<T>(raw, fallback);
  } catch {
    return fallback;
  }
}

function decode<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
