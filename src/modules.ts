import { Activity, Bell, Bot, Compass, Layers, ListTodo, Music2, Timer } from "lucide-react";

/**
 * Single source of truth for notch modules. Adding a feature = one entry here + its render branch;
 * navigation icons, cycling order and the overflow menu are all derived from this list.
 */
export type ModuleId =
  | "media"
  | "notifications"
  | "todo"
  | "shelf"
  | "perf"
  | "pomodoro"
  | "prayer"
  | "agent";

export interface ModuleDef {
  id: ModuleId;
  label: string;
  icon: typeof Music2;
}

export const MODULES: ModuleDef[] = [
  { id: "media", label: "Media Player", icon: Music2 },
  { id: "notifications", label: "Notifikasi HP & Laptop", icon: Bell },
  { id: "todo", label: "To-Do List", icon: ListTodo },
  { id: "shelf", label: "Quick Shelf & Stash", icon: Layers },
  { id: "perf", label: "Performance HUD", icon: Activity },
  { id: "pomodoro", label: "Pomodoro", icon: Timer },
  { id: "prayer", label: "Jadwal Sholat", icon: Compass },
  { id: "agent", label: "AI Agent", icon: Bot },
];

export const MODULE_IDS: ModuleId[] = MODULES.map((m) => m.id);

/** Hard cap for the header icon strip; the rest live in the "Menu lainnya" overflow */
export const MAX_NAV_ICONS = 5;

export const DEFAULT_PINNED: ModuleId[] = [...MODULE_IDS];

export function isModuleId(value: unknown): value is ModuleId {
  return typeof value === "string" && MODULE_IDS.includes(value as ModuleId);
}

/** Keeps the user's order, drops unknown ids, caps at MAX_NAV_ICONS. Absent = defaults; empty = no icons. */
export function resolvePinned(pinned?: string[]): ModuleId[] {
  if (!pinned) return DEFAULT_PINNED.slice(0, MAX_NAV_ICONS);
  return [...new Set(pinned.filter(isModuleId))].slice(0, MAX_NAV_ICONS);
}

export function moduleDef(id: ModuleId): ModuleDef {
  return MODULES.find((m) => m.id === id) ?? MODULES[0];
}
