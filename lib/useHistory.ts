"use client";

import { useCallback, useState } from "react";

/**
 * Bounded undo/redo stacks of snapshots. The caller keeps owning its live
 * state: it hands the *current* snapshot to `record` just before applying an
 * edit, and to `undo`/`redo` when stepping (so the state being left can be
 * parked on the opposite stack). Both steps return the snapshot to restore,
 * or null at the end of the stack.
 */
export function useHistory<T>(limit = 50) {
  const [past, setPast] = useState<T[]>([]);
  const [future, setFuture] = useState<T[]>([]);

  const record = useCallback(
    (current: T) => {
      setPast((p) => {
        const next = [...p, current];
        return next.length > limit ? next.slice(next.length - limit) : next;
      });
      // A fresh edit invalidates anything that had been undone.
      setFuture([]);
    },
    [limit]
  );

  const undo = useCallback(
    (current: T): T | null => {
      if (past.length === 0) return null;
      setPast(past.slice(0, -1));
      setFuture((f) => [...f, current]);
      return past[past.length - 1];
    },
    [past]
  );

  const redo = useCallback(
    (current: T): T | null => {
      if (future.length === 0) return null;
      setFuture(future.slice(0, -1));
      setPast((p) => [...p, current]);
      return future[future.length - 1];
    },
    [future]
  );

  const reset = useCallback(() => {
    setPast([]);
    setFuture([]);
  }, []);

  return { canUndo: past.length > 0, canRedo: future.length > 0, record, undo, redo, reset };
}
