import React, { useState, useEffect } from "react";
import {
  Folder,
  FileText,
  Plus,
  Trash2,
  Copy,
  Check,
  X,
  Compass,
  UploadCloud,
  Terminal,
  Code,
  Globe,
  HardDrive,
  FileCode,
  Image as ImageIcon,
  Music,
  Music2,
  Video,
  Archive,
  Sparkles,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface ShortcutItem {
  id: string;
  title: string;
  path: string;
  type: "folder" | "file" | "app" | "url";
}

export interface StashedFile {
  id: string;
  name: string;
  path: string;
  extension: string;
  addedAt: number;
}

interface ShelfProps {
  accentColor?: string;
  fontSizeScale?: number;
}

const DEFAULT_SHORTCUTS: ShortcutItem[] = [
  {
    id: "sc-projects",
    title: "Projects",
    path: "D:\\Project",
    type: "folder",
  },
  {
    id: "sc-downloads",
    title: "Downloads",
    path: "Downloads",
    type: "folder",
  },
  {
    id: "sc-vscode",
    title: "VS Code",
    path: "code",
    type: "app",
  },
  {
    id: "sc-terminal",
    title: "Terminal",
    path: "cmd.exe",
    type: "app",
  },
];

export function Shelf({
  accentColor = "#38bdf8",
  fontSizeScale = 1.0,
}: ShelfProps) {
  // Shortcuts state
  const [shortcuts, setShortcuts] = useState<ShortcutItem[]>(() => {
    try {
      const saved = localStorage.getItem("notch_shelf_shortcuts");
      if (saved) return JSON.parse(saved);
    } catch {
      // fallback
    }
    return DEFAULT_SHORTCUTS;
  });

  // Stashed dropped files state
  const [stashedFiles, setStashedFiles] = useState<StashedFile[]>(() => {
    try {
      const saved = localStorage.getItem("notch_shelf_stash");
      if (saved) return JSON.parse(saved);
    } catch {
      // fallback
    }
    return [];
  });

  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [dragY, setDragY] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newPath, setNewPath] = useState("");
  const [newType, setNewType] = useState<"folder" | "file" | "app" | "url">("folder");

  // Save shortcuts
  useEffect(() => {
    try {
      localStorage.setItem("notch_shelf_shortcuts", JSON.stringify(shortcuts));
    } catch {}
  }, [shortcuts]);

  // Save stashed files
  useEffect(() => {
    try {
      localStorage.setItem("notch_shelf_stash", JSON.stringify(stashedFiles));
    } catch {}
  }, [stashedFiles]);

  // Resolve special paths like "Downloads" on mount if needed
  useEffect(() => {
    invoke<Record<string, string>>("get_system_quick_paths")
      .then((paths) => {
        if (paths.Downloads) {
          setShortcuts((prev) =>
            prev.map((s) =>
              s.id === "sc-downloads" && s.path === "Downloads"
                ? { ...s, path: paths.Downloads }
                : s
            )
          );
        }
      })
      .catch(() => {});
  }, []);

  // Helper to add files to stash from path list
  const addPathsToStash = (paths: string[]) => {
    if (!paths || paths.length === 0) return;
    const newItems: StashedFile[] = paths.map((p) => {
      // Extract file/folder name
      const cleanPath = p.replace(/\\/g, "/");
      const parts = cleanPath.split("/").filter(Boolean);
      const name = parts[parts.length - 1] || p;
      const extMatch = name.match(/\.([0-9a-z]+)$/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : "";

      return {
        id: "stash-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
        name,
        path: p,
        extension: ext,
        addedAt: Date.now(),
      };
    });

    setStashedFiles((prev) => {
      // Deduplicate by path
      const existingPaths = new Set(prev.map((f) => f.path.toLowerCase()));
      const filtered = newItems.filter((i) => !existingPaths.has(i.path.toLowerCase()));
      return [...filtered, ...prev];
    });
  };

  // Determine if a path points to an executable, application, or Windows shortcut
  const isAppOrShortcut = (pathStr: string) => {
    return /\.(lnk|exe|bat|cmd|url)$/i.test(pathStr);
  };

  const formatAppTitle = (pathStr: string) => {
    const clean = pathStr.replace(/\\/g, "/");
    const parts = clean.split("/").filter(Boolean);
    const fileName = parts[parts.length - 1] || pathStr;
    const baseName = fileName.replace(/\.(lnk|exe|bat|cmd|url)$/i, "");
    if (!baseName) return "App";
    return baseName.charAt(0).toUpperCase() + baseName.slice(1);
  };

  // Process dropped paths into shortcuts and/or stash based on type and drop target area
  const handleProcessDroppedPaths = (paths: string[], yLogical?: number) => {
    if (!paths || paths.length === 0) return;

    // Y <= 140 is the Quick Shortcuts area; Y > 140 is the File Stash dropzone
    const droppedOnShortcuts = yLogical !== undefined && yLogical <= 140;
    const droppedOnStash = yLogical !== undefined && yLogical > 140;

    const appsToAdd: ShortcutItem[] = [];
    const filesToStash: string[] = [];

    for (const p of paths) {
      const isApp = isAppOrShortcut(p);
      const isDir = !p.includes(".") || p.endsWith("\\") || p.endsWith("/");

      if (droppedOnShortcuts) {
        appsToAdd.push({
          id: "sc-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
          title: formatAppTitle(p),
          path: p,
          type: isDir ? "folder" : isApp ? "app" : "file",
        });
      } else if (droppedOnStash) {
        filesToStash.push(p);
        if (isApp) {
          appsToAdd.push({
            id: "sc-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
            title: formatAppTitle(p),
            path: p,
            type: "app",
          });
        }
      } else {
        if (isApp) {
          appsToAdd.push({
            id: "sc-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
            title: formatAppTitle(p),
            path: p,
            type: "app",
          });
          filesToStash.push(p);
        } else {
          filesToStash.push(p);
        }
      }
    }

    if (appsToAdd.length > 0) {
      setShortcuts((prev) => {
        const existingPaths = new Set(prev.map((s) => s.path.toLowerCase()));
        const unique = appsToAdd.filter((a) => !existingPaths.has(a.path.toLowerCase()));
        return [...prev, ...unique];
      });
    }

    if (filesToStash.length > 0) {
      addPathsToStash(filesToStash);
    }
  };

  // Tauri Native Drag & Drop listener via app events
  useEffect(() => {
    let unlistenEnter: (() => void) | undefined;
    let unlistenOver: (() => void) | undefined;
    let unlistenLeave: (() => void) | undefined;
    let unlistenDrop: (() => void) | undefined;

    const setupListeners = async () => {
      unlistenEnter = await listen<{ paths?: string[]; x: number; y: number }>(
        "notch-drag-enter",
        (event) => {
          setIsDraggingOver(true);
          if (event.payload && typeof event.payload.y === "number") {
            setDragY(event.payload.y / (window.devicePixelRatio || 1));
          }
        }
      );

      unlistenOver = await listen<{ x: number; y: number }>(
        "notch-drag-over",
        (event) => {
          setIsDraggingOver(true);
          if (event.payload && typeof event.payload.y === "number") {
            setDragY(event.payload.y / (window.devicePixelRatio || 1));
          }
        }
      );

      unlistenLeave = await listen("notch-drag-leave", () => {
        setIsDraggingOver(false);
        setDragY(null);
      });

      unlistenDrop = await listen<{ paths?: string[]; x: number; y: number }>(
        "notch-drag-drop",
        (event) => {
          setIsDraggingOver(false);
          setDragY(null);
          if (event.payload?.paths && event.payload.paths.length > 0) {
            const yLogical =
              typeof event.payload.y === "number"
                ? event.payload.y / (window.devicePixelRatio || 1)
                : undefined;
            handleProcessDroppedPaths(event.payload.paths, yLogical);
          }
        }
      );
    };

    setupListeners();

    return () => {
      if (unlistenEnter) unlistenEnter();
      if (unlistenOver) unlistenOver();
      if (unlistenLeave) unlistenLeave();
      if (unlistenDrop) unlistenDrop();
    };
  }, []);

  // Standard HTML5 Drop Fallback
  const handleHtmlDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setIsDraggingOver(true);
    setDragY(e.clientY);
  };

  const handleHtmlDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    setDragY(null);
  };

  const handleHtmlDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    setDragY(null);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const paths: string[] = [];
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const file = e.dataTransfer.files[i] as any;
        if (file.path) {
          paths.push(file.path);
        } else if (file.name) {
          paths.push(file.name);
        }
      }
      if (paths.length > 0) {
        handleProcessDroppedPaths(paths, e.clientY);
      }
    }
  };

  // Launch shortcut or file
  const handleOpen = async (path: String) => {
    try {
      await invoke("open_system_path", { path });
    } catch (err) {
      console.error("Failed to open path:", err);
    }
  };

  // Reveal in Windows Explorer
  const handleReveal = async (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await invoke("reveal_in_explorer", { path });
    } catch (err) {
      console.error("Failed to reveal:", err);
    }
  };

  // Copy path to clipboard
  const handleCopyPath = async (id: string, path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(path);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch (err) {
      console.error("Clipboard copy failed:", err);
    }
  };

  // Remove stashed file
  const handleRemoveStash = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setStashedFiles((prev) => prev.filter((f) => f.id !== id));
  };

  // Clear all stash
  const handleClearStash = (e: React.MouseEvent) => {
    e.stopPropagation();
    setStashedFiles([]);
  };

  // Delete shortcut
  const handleDeleteShortcut = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setShortcuts((prev) => prev.filter((s) => s.id !== id));
  };

  // Add custom shortcut submit
  const handleAddShortcut = (e: React.FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim();
    const path = newPath.trim();
    if (!title || !path) return;

    const item: ShortcutItem = {
      id: "sc-" + Date.now(),
      title,
      path,
      type: newType,
    };
    setShortcuts((prev) => [...prev, item]);
    setNewTitle("");
    setNewPath("");
    setShowAddModal(false);
  };

  // Get icon by extension
  const getFileIcon = (ext: string) => {
    switch (ext) {
      case "ts":
      case "tsx":
      case "js":
      case "jsx":
      case "rs":
      case "py":
      case "json":
      case "html":
      case "css":
        return <FileCode className="w-4 h-4 text-emerald-400 shrink-0" />;
      case "png":
      case "jpg":
      case "jpeg":
      case "gif":
      case "webp":
      case "svg":
        return <ImageIcon className="w-4 h-4 text-purple-400 shrink-0" />;
      case "mp3":
      case "wav":
      case "flac":
      case "ogg":
        return <Music className="w-4 h-4 text-amber-400 shrink-0" />;
      case "mp4":
      case "mkv":
      case "avi":
      case "mov":
        return <Video className="w-4 h-4 text-rose-400 shrink-0" />;
      case "zip":
      case "rar":
      case "7z":
      case "tar":
      case "gz":
        return <Archive className="w-4 h-4 text-orange-400 shrink-0" />;
      case "":
        return <Folder className="w-4 h-4 text-sky-400 shrink-0" />;
      default:
        return <FileText className="w-4 h-4 text-neutral-300 shrink-0" />;
    }
  };

  const getShortcutIcon = (type: ShortcutItem["type"], title: string) => {
    const t = title.toLowerCase();
    if (t.includes("discord")) {
      return <Sparkles className="w-3.5 h-3.5 text-indigo-400" />;
    }
    if (t.includes("spotify") || t.includes("music")) {
      return <Music2 className="w-3.5 h-3.5 text-emerald-400" />;
    }
    if (t.includes("chrome") || t.includes("edge") || t.includes("browser") || t.includes("firefox")) {
      return <Globe className="w-3.5 h-3.5 text-sky-400" />;
    }
    if (t.includes("terminal") || t.includes("cmd") || t.includes("powershell") || t.includes("bash")) {
      return <Terminal className="w-3.5 h-3.5 text-emerald-400" />;
    }
    if (t.includes("code") || t.includes("vs")) {
      return <Code className="w-3.5 h-3.5 text-blue-400" />;
    }
    switch (type) {
      case "folder":
        return <Folder className="w-3.5 h-3.5 text-amber-400" />;
      case "url":
        return <Globe className="w-3.5 h-3.5 text-sky-400" />;
      case "app":
        return <HardDrive className="w-3.5 h-3.5 text-violet-400" />;
      default:
        return <FileText className="w-3.5 h-3.5 text-neutral-300" />;
    }
  };

  return (
    <div
      onDragOver={handleHtmlDragOver}
      onDragLeave={handleHtmlDragLeave}
      onDrop={handleHtmlDrop}
      className="flex flex-col h-full justify-between gap-2 overflow-hidden select-none px-4"
    >
      {/* SECTION 1: QUICK SHORTCUTS GRID */}
      <div
        className={`flex flex-col gap-1.5 shrink-0 rounded-xl p-1.5 transition-all ${
          isDraggingOver && dragY !== null && dragY <= 140
            ? "border border-dashed bg-white/[0.06] shadow-[0_0_12px_rgba(255,255,255,0.08)]"
            : "border border-transparent"
        }`}
        style={{
          borderColor:
            isDraggingOver && dragY !== null && dragY <= 140
              ? accentColor
              : "transparent",
        }}
      >
        <div className="flex items-center justify-between px-0.5">
          <div className="flex items-center gap-1.5">
            <span
              className="text-[10px] font-mono tracking-wider uppercase text-neutral-400"
              style={{ fontSize: `${10 * fontSizeScale}px` }}
            >
              Quick Shortcuts
            </span>
            {isDraggingOver && dragY !== null && dragY <= 140 && (
              <span
                className="text-[9px] font-mono px-1.5 py-0.5 rounded animate-pulse"
                style={{ backgroundColor: `${accentColor}25`, color: accentColor }}
              >
                + Drop to add as Shortcut / App
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            title="Add Custom Shortcut"
            className="flex items-center gap-1 text-[10px] font-mono text-neutral-400 hover:text-white transition-colors px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 border border-white/5"
          >
            <Plus className="w-3 h-3" />
            <span>Add</span>
          </button>
        </div>

        {/* Shortcuts Horizontal/Grid List */}
        <div
          className="shelf-scroll grid grid-cols-4 gap-1.5 max-h-[72px] overflow-y-auto pr-0.5 no-scrollbar"
          style={{ scrollbarWidth: "none" }}
        >
          {shortcuts.map((sc) => (
            <div
              key={sc.id}
              onClick={() => handleOpen(sc.path)}
              className="group relative flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.1] border border-white/[0.06] hover:border-white/20 transition-all cursor-pointer shadow-sm"
              title={`${sc.title}\n${sc.path}`}
            >
              <div className="shrink-0">{getShortcutIcon(sc.type, sc.title)}</div>
              <span
                className="text-xs font-medium text-neutral-200 truncate flex-1"
                style={{ fontSize: `${11 * fontSizeScale}px` }}
              >
                {sc.title}
              </span>

              {/* Delete button on hover for non-default */}
              <button
                type="button"
                onClick={(e) => handleDeleteShortcut(sc.id, e)}
                title="Remove Shortcut"
                className="opacity-0 group-hover:opacity-100 p-0.5 text-neutral-400 hover:text-rose-400 transition-opacity"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* SECTION 2: FILE STASH / DRAG-AND-DROP SHELF */}
      <div className="flex-1 flex flex-col min-h-0 gap-1.5">
        <div className="flex items-center justify-between px-0.5">
          <div className="flex items-center gap-1.5">
            <span
              className="text-[10px] font-mono tracking-wider uppercase text-neutral-400"
              style={{ fontSize: `${10 * fontSizeScale}px` }}
            >
              File Shelf & Stash
            </span>
            {stashedFiles.length > 0 && (
              <span
                className="px-1.5 py-0.2 text-[9px] font-mono rounded bg-white/10"
                style={{ color: accentColor }}
              >
                {stashedFiles.length}
              </span>
            )}
          </div>

          {stashedFiles.length > 0 && (
            <button
              type="button"
              onClick={handleClearStash}
              title="Clear Stash"
              className="text-[10px] font-mono text-neutral-400 hover:text-rose-400 transition-colors flex items-center gap-1"
            >
              <Trash2 className="w-2.5 h-2.5" />
              <span>Clear</span>
            </button>
          )}
        </div>

        {/* Drop Zone / Stashed Files List */}
        <div
          style={{
            borderColor:
              isDraggingOver && (dragY === null || dragY > 140)
                ? accentColor
                : undefined,
          }}
          className={`flex-1 rounded-xl transition-all overflow-hidden flex flex-col relative border ${
            isDraggingOver && (dragY === null || dragY > 140)
              ? "bg-white/[0.06] shadow-[0_0_15px_rgba(255,255,255,0.1)] border-dashed"
              : "bg-black/20 border-white/5"
          }`}
        >
          {stashedFiles.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-3 text-center gap-1.5">
              <UploadCloud
                className={`w-6 h-6 transition-transform ${
                  isDraggingOver
                    ? "scale-125"
                    : "text-neutral-500"
                }`}
                style={{ color: isDraggingOver ? accentColor : undefined }}
              />
              <div className="flex flex-col gap-0.5">
                <span
                  className="text-xs font-mono font-medium text-neutral-300"
                  style={{ fontSize: `${11 * fontSizeScale}px` }}
                >
                  {isDraggingOver
                    ? "Drop files to stash!"
                    : "Drag & Drop files or folders here"}
                </span>
                <span className="text-[10px] font-mono text-neutral-500">
                  Quick multitasking staging area
                </span>
              </div>
            </div>
          ) : (
            <div
              className="shelf-scroll flex-1 overflow-y-auto p-1.5 space-y-1 max-h-[145px] no-scrollbar"
              style={{ scrollbarWidth: "none" }}
            >
              {stashedFiles.map((file) => (
                <div
                  key={file.id}
                  onClick={() => handleOpen(file.path)}
                  className="group flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.04] transition-all cursor-pointer"
                  title={`${file.name}\n${file.path}`}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
                    {getFileIcon(file.extension)}
                    <div className="flex flex-col min-w-0 flex-1">
                      <span
                        className="text-xs font-medium text-neutral-200 truncate"
                        style={{ fontSize: `${11 * fontSizeScale}px` }}
                      >
                        {file.name}
                      </span>
                      <span className="text-[9px] font-mono text-neutral-500 truncate">
                        {file.path}
                      </span>
                    </div>
                  </div>

                  {/* Actions on hover */}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      type="button"
                      onClick={(e) => handleReveal(file.path, e)}
                      title="Reveal in File Explorer"
                      className="p-1 rounded hover:bg-white/10 text-neutral-400 hover:text-white transition-colors"
                    >
                      <Compass className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => handleCopyPath(file.id, file.path, e)}
                      title="Copy Full Path"
                      className="p-1 rounded hover:bg-white/10 text-neutral-400 hover:text-white transition-colors"
                    >
                      {copiedId === file.id ? (
                        <Check className="w-3 h-3 text-emerald-400" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => handleRemoveStash(file.id, e)}
                      title="Remove from Shelf"
                      className="p-1 rounded hover:bg-rose-500/20 text-neutral-400 hover:text-rose-400 transition-colors"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* MODAL: ADD CUSTOM SHORTCUT */}
      {showAddModal && (
        <div
          className="absolute inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => setShowAddModal(false)}
        >
          <div
            className="w-full max-w-[340px] bg-neutral-900 border border-white/10 rounded-xl p-3.5 shadow-2xl flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-1 border-b border-white/10">
              <span className="text-xs font-mono font-medium text-white">
                Add Quick Shortcut
              </span>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="text-neutral-400 hover:text-white"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <form onSubmit={handleAddShortcut} className="flex flex-col gap-2.5">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono text-neutral-400">
                  Shortcut Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. My Repo, Discord, Figma"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  autoFocus
                  required
                  className="px-2.5 py-1.5 text-xs bg-white/5 border border-white/10 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-sky-400/50"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono text-neutral-400">
                  Target Path or URL
                </label>
                <input
                  type="text"
                  placeholder="e.g. D:\Project, https://github.com, wt"
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  required
                  className="px-2.5 py-1.5 text-xs bg-white/5 border border-white/10 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-sky-400/50 font-mono"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono text-neutral-400">
                  Type
                </label>
                <div className="grid grid-cols-4 gap-1">
                  {(["folder", "file", "app", "url"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setNewType(t)}
                      className={`py-1 text-[10px] font-mono uppercase rounded border transition-colors ${
                        newType === t
                          ? "bg-sky-500/20 text-sky-300 border-sky-400/40"
                          : "bg-white/5 text-neutral-400 border-white/5 hover:text-white"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-2.5 py-1 text-xs font-mono rounded bg-white/5 hover:bg-white/10 text-neutral-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-3 py-1 text-xs font-mono font-medium rounded bg-sky-500 hover:bg-sky-400 text-black transition-colors"
                >
                  Save Shortcut
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
