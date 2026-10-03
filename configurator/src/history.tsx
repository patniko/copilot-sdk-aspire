import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

const LIMIT = 50;
const COALESCE_MS = 800;

export interface History<T> {
  value: T;
  /** Records a change. Changes with the same key within a short window merge (typing). */
  set: (next: T | ((current: T) => T), key?: string) => void;
  /** Replaces the value and clears history (after load or save). */
  reset: (value: T) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useHistory<T>(initial: T): History<T> {
  const [state, setState] = useState<{ past: T[]; present: T; future: T[] }>({ past: [], present: initial, future: [] });
  const last = useRef<{ key?: string; at: number }>({ at: 0 });

  const set = useCallback((next: T | ((current: T) => T), key?: string) => {
    setState((s) => {
      const value = typeof next === "function" ? (next as (current: T) => T)(s.present) : next;
      if (Object.is(value, s.present)) return s;
      const now = Date.now();
      const coalesce = key !== undefined && key === last.current.key && now - last.current.at < COALESCE_MS && s.past.length > 0;
      last.current = { key, at: now };
      return {
        past: coalesce ? s.past : [...s.past, s.present].slice(-LIMIT),
        present: value,
        future: [],
      };
    });
  }, []);
  const reset = useCallback((value: T) => {
    last.current = { at: 0 };
    setState({ past: [], present: value, future: [] });
  }, []);
  const undo = useCallback(() => {
    last.current = { at: 0 };
    setState((s) => (s.past.length === 0 ? s : { past: s.past.slice(0, -1), present: s.past.at(-1) as T, future: [s.present, ...s.future] }));
  }, []);
  const redo = useCallback(() => {
    last.current = { at: 0 };
    setState((s) => (s.future.length === 0 ? s : { past: [...s.past, s.present], present: s.future[0] as T, future: s.future.slice(1) }));
  }, []);

  return { value: state.present, set, reset, undo, redo, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}

// ---------------------------------------------------------------------------
// Draft autosave (browser only; files change only on explicit save)
// ---------------------------------------------------------------------------

export interface Draft<T> {
  value: T;
  savedAt: string;
  /** Serialized on-disk content the draft was based on; differs if the file changed since. */
  baseline: string;
}

const PREFIX = "configurator-draft:";

export function readDraft<T>(key: string): Draft<T> | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as Draft<T>) : undefined;
  } catch {
    return undefined;
  }
}

export function clearDraft(key: string): void {
  localStorage.removeItem(PREFIX + key);
}

/** Saves `value` as a draft while it differs from `baseline` (the serialized on-disk state). */
export function useDraftAutosave<T>(key: string | undefined, value: T | undefined, baseline: string | undefined, enabled: boolean): void {
  useEffect(() => {
    if (!key || value === undefined || baseline === undefined || !enabled) return;
    const timer = setTimeout(() => {
      if (JSON.stringify(value) === baseline) {
        clearDraft(key);
      } else {
        const draft: Draft<T> = { value, savedAt: new Date().toISOString(), baseline };
        try {
          localStorage.setItem(PREFIX + key, JSON.stringify(draft));
        } catch {
          // Storage full or disabled; drafts are a convenience.
        }
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [key, value, baseline, enabled]);
}

// ---------------------------------------------------------------------------
// Editor actions shown in the global header
// ---------------------------------------------------------------------------

export interface EditorActions {
  /** What is being edited, e.g. "insights-team 1.0.0". */
  label: string;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  dirty: boolean;
  saving: boolean;
  save: () => void;
  exportJson?: () => void;
}

const EditorContext = createContext<{
  actions?: EditorActions;
  register: (actions: EditorActions | undefined) => void;
}>({ register: () => undefined });

export function EditorActionsProvider({ children }: { children: ReactNode }) {
  const [actions, setActions] = useState<EditorActions>();
  const value = useMemo(() => ({ actions, register: setActions }), [actions]);
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditorActions(): EditorActions | undefined {
  return useContext(EditorContext).actions;
}

/** Registers the current editor's actions with the header while the editor is mounted. */
export function useRegisterEditorActions(actions: EditorActions | undefined): void {
  const { register } = useContext(EditorContext);
  const ref = useRef(actions);
  ref.current = actions;
  const signature = actions
    ? `${actions.label}|${actions.canUndo}|${actions.canRedo}|${actions.dirty}|${actions.saving}|${Boolean(actions.exportJson)}`
    : "";
  useEffect(() => {
    const current = ref.current;
    register(
      current && {
        ...current,
        undo: () => ref.current?.undo(),
        redo: () => ref.current?.redo(),
        save: () => ref.current?.save(),
        exportJson: current.exportJson ? () => ref.current?.exportJson?.() : undefined,
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, register]);
  useEffect(() => () => register(undefined), [register]);
}

/** Ctrl/Cmd+S saves; Ctrl/Cmd+Z undoes and Ctrl/Cmd+Shift+Z or Ctrl+Y redoes outside text fields. */
export function useEditorShortcuts(actions: EditorActions | undefined): void {
  useEffect(() => {
    if (!actions) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        if (actions.dirty && !actions.saving) actions.save();
        return;
      }
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (typing) return;
      if (key === "z" && !e.shiftKey && actions.canUndo) {
        e.preventDefault();
        actions.undo();
      } else if (((key === "z" && e.shiftKey) || key === "y") && actions.canRedo) {
        e.preventDefault();
        actions.redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions]);
}
