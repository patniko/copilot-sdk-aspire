import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  AzureStatus,
  EnvironmentStatus,
  HarnessDetail,
  LocalStackStatus,
  SettingsInfo,
  TaskInfo,
  TaskKind,
  WorkspaceInfo,
} from "../server/types";
import { api, errorMessage } from "./api";

export type View = "overview" | "harnesses" | "policy" | "local" | "deploy" | "try";

interface AppState {
  view: View;
  setView: (view: View) => void;
  workspace?: WorkspaceInfo;
  settings?: SettingsInfo;
  environment?: EnvironmentStatus;
  local?: LocalStackStatus;
  azure?: AzureStatus;
  azureError?: string;
  tasks: TaskInfo[];
  activeTask?: string;
  setActiveTask: (id: string | undefined) => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  selectedHarness?: string;
  setSelectedHarness: (folder: string | undefined) => void;
  loadError?: string;
  refreshWorkspace: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  refreshEnvironment: (force?: boolean) => Promise<void>;
  refreshLocal: () => Promise<void>;
  refreshAzure: () => Promise<void>;
  runTask: (kind: TaskKind) => Promise<TaskInfo | undefined>;
  toast: (message: string, tone?: "info" | "error" | "success") => void;
  toasts: Array<{ id: number; message: string; tone: "info" | "error" | "success" }>;
  /** Live validation result of the harness being edited (shown in the Live plan). */
  editorDetail?: HarnessDetail;
  setEditorDetail: (detail: HarnessDetail | undefined) => void;
}

const Context = createContext<AppState | undefined>(undefined);

export function useApp(): AppState {
  const value = useContext(Context);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [view, setViewState] = useState<View>(() => (window.location.hash.slice(1) as View) || "overview");
  const [workspace, setWorkspace] = useState<WorkspaceInfo>();
  const [settings, setSettings] = useState<SettingsInfo>();
  const [environment, setEnvironment] = useState<EnvironmentStatus>();
  const [local, setLocal] = useState<LocalStackStatus>();
  const [azure, setAzure] = useState<AzureStatus>();
  const [azureError, setAzureError] = useState<string>();
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [activeTask, setActiveTask] = useState<string>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedHarness, setSelectedHarness] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [toasts, setToasts] = useState<AppState["toasts"]>([]);
  const [editorDetail, setEditorDetail] = useState<HarnessDetail>();
  const toastId = useRef(0);

  const toast = useCallback((message: string, tone: "info" | "error" | "success" = "info") => {
    const id = ++toastId.current;
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), tone === "error" ? 8000 : 4000);
  }, []);

  const setView = useCallback((next: View) => {
    window.location.hash = next;
    setViewState(next);
  }, []);

  useEffect(() => {
    const onHash = () => setViewState((window.location.hash.slice(1) as View) || "overview");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const refreshWorkspace = useCallback(async () => {
    try {
      setWorkspace(await api<WorkspaceInfo>("/api/workspace"));
      setLoadError(undefined);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, []);
  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await api<SettingsInfo>("/api/settings"));
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }, [toast]);
  const refreshEnvironment = useCallback(async (force = false) => {
    try {
      setEnvironment(await api<EnvironmentStatus>(`/api/status/environment${force ? "?refresh=1" : ""}`));
    } catch {
      // Shown as unknown.
    }
  }, []);
  const refreshLocal = useCallback(async () => {
    try {
      setLocal(await api<LocalStackStatus>("/api/status/local"));
    } catch {
      setLocal({ running: false, resources: [] });
    }
  }, []);
  const refreshAzure = useCallback(async () => {
    try {
      setAzure(await api<AzureStatus>("/api/status/azure"));
      setAzureError(undefined);
    } catch (error) {
      setAzure(undefined);
      setAzureError(errorMessage(error));
    }
  }, []);

  const refreshTasks = useCallback(async () => {
    try {
      const { tasks: list } = await api<{ tasks: TaskInfo[] }>("/api/tasks");
      setTasks(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  const runTask = useCallback(
    async (kind: TaskKind) => {
      try {
        const task = await api<TaskInfo>("/api/tasks", { method: "POST", body: { kind } });
        setActiveTask(task.id);
        setDrawerOpen(true);
        await refreshTasks();
        return task;
      } catch (error) {
        toast(errorMessage(error), "error");
        return undefined;
      }
    },
    [refreshTasks, toast],
  );

  // Initial load.
  useEffect(() => {
    void refreshWorkspace();
    void refreshSettings();
    void refreshEnvironment();
    void refreshLocal();
    void refreshTasks();
  }, [refreshWorkspace, refreshSettings, refreshEnvironment, refreshLocal, refreshTasks]);

  // When tasks finish, refresh what they affect.
  const previous = useRef(new Map<string, string>());
  useEffect(() => {
    const running = tasks.some((t) => t.status === "running");
    const timer = setInterval(() => void refreshTasks(), running ? 1500 : 6000);
    for (const task of tasks) {
      const before = previous.current.get(task.id);
      if (before === "running" && task.status !== "running") {
        toast(`${task.title}: ${task.status}`, task.status === "succeeded" ? "success" : task.status === "cancelled" ? "info" : "error");
        if (task.kind.startsWith("local")) void refreshLocal();
        if (task.kind === "deploy") void refreshAzure();
        if (task.kind === "az-login") void refreshEnvironment(true);
        void refreshWorkspace();
      }
      previous.current.set(task.id, task.status);
    }
    return () => clearInterval(timer);
  }, [tasks, refreshTasks, refreshLocal, refreshAzure, refreshEnvironment, refreshWorkspace, toast]);

  // Keep the local stack status fresh while it is running or starting.
  useEffect(() => {
    const timer = setInterval(() => void refreshLocal(), local?.running ? 10_000 : 30_000);
    return () => clearInterval(timer);
  }, [local?.running, refreshLocal]);

  // Load Azure status for the selected target (it calls the Azure CLI, so only on change).
  useEffect(() => {
    if (settings?.selectedTarget) void refreshAzure();
  }, [settings?.selectedTarget, refreshAzure]);

  const value = useMemo<AppState>(
    () => ({
      view,
      setView,
      workspace,
      settings,
      environment,
      local,
      azure,
      azureError,
      tasks,
      activeTask,
      setActiveTask,
      drawerOpen,
      setDrawerOpen,
      selectedHarness,
      setSelectedHarness,
      loadError,
      refreshWorkspace,
      refreshSettings,
      refreshEnvironment,
      refreshLocal,
      refreshAzure,
      runTask,
      toast,
      toasts,
      editorDetail,
      setEditorDetail,
    }),
    [
      view,
      setView,
      workspace,
      settings,
      environment,
      local,
      azure,
      azureError,
      tasks,
      activeTask,
      drawerOpen,
      selectedHarness,
      loadError,
      refreshWorkspace,
      refreshSettings,
      refreshEnvironment,
      refreshLocal,
      refreshAzure,
      runTask,
      toast,
      toasts,
      editorDetail,
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
