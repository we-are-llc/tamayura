import type { Settings, Task } from "./types.ts";

const TASKS_KEY = "tamayura.tasks.v1";
const SETTINGS_KEY = "tamayura.settings.v1";
const CURRENT_KEY = "tamayura.currentTaskId.v1";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ストレージが使えない環境ではその場限りで動作する
  }
}

export function loadTasks(): Task[] {
  return read<Task[]>(TASKS_KEY, []);
}

export function saveTasks(tasks: Task[]): void {
  write(TASKS_KEY, tasks);
}

export function upsertTask(task: Task): Task[] {
  const tasks = loadTasks();
  const i = tasks.findIndex((t) => t.id === task.id);
  if (i >= 0) tasks[i] = task;
  else tasks.unshift(task);
  saveTasks(tasks);
  return tasks;
}

export function deleteTask(id: string): Task[] {
  const tasks = loadTasks().filter((t) => t.id !== id);
  saveTasks(tasks);
  return tasks;
}

export function loadSettings(): Settings {
  return read<Settings>(SETTINGS_KEY, { speech: true, downloadAccepted: false, preferSimple: false });
}

export function saveSettings(settings: Settings): void {
  write(SETTINGS_KEY, settings);
}

export function loadCurrentTaskId(): string | null {
  return read<string | null>(CURRENT_KEY, null);
}

export function saveCurrentTaskId(id: string | null): void {
  write(CURRENT_KEY, id);
}

export function clearAllData(): void {
  localStorage.removeItem(TASKS_KEY);
  localStorage.removeItem(SETTINGS_KEY);
  localStorage.removeItem(CURRENT_KEY);
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
