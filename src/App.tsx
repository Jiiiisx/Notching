import { useEffect, useState, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { motion, AnimatePresence } from "motion/react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Music2,
  Sparkles,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  ListTodo,
  Mic2,
  ListMusic,
  Settings,
  Zap,
  Layers,
  Volume2,
  VolumeX,
  Activity,
  Monitor,
} from "lucide-react";
import { TodoList, TodoItem } from "./TodoList";
import { Shelf } from "./Shelf";
import { PerformanceHUD } from "./PerformanceHUD";
import { AudioSwitcher, AudioStatus } from "./AudioSwitcher";
import {
  NotchSettings,
  loadSettings,
  saveSettings,
  hexToRgba,
} from "./settings";
import "./App.css";

interface BatteryInfo {
  has_battery: boolean;
  percent: number;
  is_charging: boolean;
}

interface QueueTrack {
  title: string;
  artist: string;
  album: string;
  duration_ms: number;
  uri: string;
  image_url: string;
}

interface MediaTrack {
  title: string;
  artist: string;
  album: string;
  is_playing: boolean;
  has_media: boolean;
  position_sec: number;
  duration_sec: number;
}

interface NotchDimensions {
  collapsed_width: number;
  collapsed_height: number;
  expanded_width: number;
  expanded_height: number;
  lyrics_height: number;
}

interface LyricLine {
  time: number;
  text: string;
}

function parseLrc(lrcText: string): LyricLine[] {
  const lines = lrcText.split("\n");
  const result: LyricLine[] = [];
  const regex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\](.*)/;

  for (const line of lines) {
    const match = line.match(regex);
    if (match) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = match[3] ? parseFloat("0." + match[3]) : 0;
      const totalSec = min * 60 + sec + ms;
      const text = match[4].trim();
      if (text) {
        result.push({ time: totalSec, text });
      }
    }
  }
  return result.sort((a, b) => a.time - b.time);
}

function formatTime(sec: number): string {
  if (isNaN(sec) || sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

export default function App() {
  const [settings, setSettings] = useState<NotchSettings>(loadSettings);
  const [expanded, setExpanded] = useState(false);
  const [showAudioSwitcher, setShowAudioSwitcher] = useState(false);
  const [audioStatus, setAudioStatus] = useState<AudioStatus | null>(null);
  const [showVolumeHud, setShowVolumeHud] = useState(false);
  const volumeHudTimeoutRef = useRef<number | null>(null);
  const isInitialAudioEventRef = useRef<boolean>(true);
  const lastKnownVolumeRef = useRef<number | null>(null);
  const lastKnownMuteRef = useRef<boolean | null>(null);
  const [expandedView, setExpandedView] = useState<"player" | "lyrics" | "queue">("player");
  const [showLyrics] = useState(true);
  const [queue, setQueue] = useState<QueueTrack[]>([]);
  const [dims, setDims] = useState<NotchDimensions>({
    collapsed_width: 190,
    collapsed_height: 36,
    expanded_width: 440,
    expanded_height: 232,
    lyrics_height: 300,
  });

  const [media, setMedia] = useState<MediaTrack>({
    title: "",
    artist: "",
    album: "",
    is_playing: false,
    has_media: false,
    position_sec: 0,
    duration_sec: 0,
  });

  // Local smoothed playback timer
  const [playbackPos, setPlaybackPos] = useState(0);

  // Lyrics state
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [plainLyrics, setPlainLyrics] = useState<string>("");
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const lastFetchedTrackRef = useRef<string>("");

  type AppModule = "media" | "todo" | "shelf" | "perf";
  const MODULES: AppModule[] = ["media", "todo", "shelf", "perf"];

  const [activeModule, setActiveModule] = useState<AppModule>(() => {
    const saved = localStorage.getItem("notch_active_module");
    if (saved === "media" || saved === "todo" || saved === "shelf" || saved === "perf") return saved;
    return "media";
  });

  const [todos, setTodos] = useState<TodoItem[]>(() => {
    try {
      const saved = localStorage.getItem("notch_todos");
      return saved ? JSON.parse(saved) : [
        { id: "1", text: "Welcome to Notch Tasks", completed: false, createdAt: Date.now() },
        { id: "2", text: "Click to toggle completion", completed: true, createdAt: Date.now() - 1000 },
      ];
    } catch {
      return [
        { id: "1", text: "Welcome to Notch Tasks", completed: false, createdAt: Date.now() },
        { id: "2", text: "Click to toggle completion", completed: true, createdAt: Date.now() - 1000 },
      ];
    }
  });

  useEffect(() => {
    localStorage.setItem("notch_todos", JSON.stringify(todos));
  }, [todos]);

  useEffect(() => {
    localStorage.setItem("notch_active_module", activeModule);
  }, [activeModule]);

  const firstPendingTodo = useMemo(() => {
    return todos.find((t) => !t.completed);
  }, [todos]);

  const handleToggleTodo = (id: string) => {
    setTodos((prev) =>
      prev.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t))
    );
  };

  const handleAddTodo = (text: string) => {
    const newItem: TodoItem = {
      id: Date.now().toString(),
      text,
      completed: false,
      createdAt: Date.now(),
    };
    setTodos((prev) => [...prev, newItem]);
  };

  const handleDeleteTodo = (id: string) => {
    setTodos((prev) => prev.filter((t) => t.id !== id));
  };

  const handleClearCompletedTodos = () => {
    setTodos((prev) => prev.filter((t) => !t.completed));
  };

  const switchModule = (target?: AppModule, direction?: "next" | "prev") => {
    if (target) {
      setActiveModule(target);
      return;
    }
    const currentIndex = MODULES.indexOf(activeModule);
    if (direction === "prev") {
      const prevIndex = (currentIndex - 1 + MODULES.length) % MODULES.length;
      setActiveModule(MODULES[prevIndex]);
    } else {
      const nextIndex = (currentIndex + 1) % MODULES.length;
      setActiveModule(MODULES[nextIndex]);
    }
  };

  const lastWheelTimeRef = useRef(0);
  const handleContainerWheel = (e: React.WheelEvent) => {
    const now = Date.now();
    if (now - lastWheelTimeRef.current < 240) return;

    if (!expandedRef.current) {
      if (Math.abs(e.deltaX) > 10 || Math.abs(e.deltaY) > 10) {
        lastWheelTimeRef.current = now;
        if (e.deltaX > 0 || e.deltaY > 0) switchModule(undefined, "next");
        else switchModule(undefined, "prev");
      }
    } else {
      if (Math.abs(e.deltaX) > 15) {
        lastWheelTimeRef.current = now;
        if (e.deltaX > 0) switchModule(undefined, "next");
        else switchModule(undefined, "prev");
        return;
      }

      const target = e.target as HTMLElement;
      const isTodoScroll = target.closest(".todo-list-scroll") as HTMLElement | null;
      const isShelfScroll = target.closest(".shelf-scroll") as HTMLElement | null;

      if (activeModule === "media") {
        if (Math.abs(e.deltaY) > 15) {
          lastWheelTimeRef.current = now;
          if (e.deltaY > 0) switchModule("todo");
          else switchModule("perf");
        }
      } else if (activeModule === "todo") {
        let canScrollY = false;
        if (isTodoScroll) {
          const hasOverflow = isTodoScroll.scrollHeight > isTodoScroll.clientHeight + 2;
          if (hasOverflow) {
            // Scroll inside list if within boundaries
            if (e.deltaY < -15 && isTodoScroll.scrollTop > 1) {
              canScrollY = true;
            } else if (
              e.deltaY > 15 &&
              isTodoScroll.scrollTop + isTodoScroll.clientHeight < isTodoScroll.scrollHeight - 2
            ) {
              canScrollY = true;
            }
          }
        }

        // If not actively scrolling tasks (empty list, few items, or reached top/bottom edge)
        if (!canScrollY) {
          if (e.deltaY > 15) {
            lastWheelTimeRef.current = now;
            switchModule("shelf");
          } else if (e.deltaY < -15) {
            lastWheelTimeRef.current = now;
            switchModule("media");
          }
        }
      } else if (activeModule === "shelf") {
        let canScrollY = false;
        if (isShelfScroll) {
          const hasOverflow = isShelfScroll.scrollHeight > isShelfScroll.clientHeight + 2;
          if (hasOverflow) {
            if (e.deltaY < -15 && isShelfScroll.scrollTop > 1) {
              canScrollY = true;
            } else if (
              e.deltaY > 15 &&
              isShelfScroll.scrollTop + isShelfScroll.clientHeight < isShelfScroll.scrollHeight - 2
            ) {
              canScrollY = true;
            }
          }
        }

        // If not actively scrolling shelf items, propagate boundary switch
        if (!canScrollY) {
          if (e.deltaY < -15) {
            lastWheelTimeRef.current = now;
            switchModule("todo");
          } else if (e.deltaY > 15) {
            lastWheelTimeRef.current = now;
            switchModule("perf");
          }
        }
      } else if (activeModule === "perf") {
        if (Math.abs(e.deltaY) > 15) {
          lastWheelTimeRef.current = now;
          if (e.deltaY > 0) switchModule("media");
          else switchModule("shelf");
        }
      }
    }
  };

  const [time, setTime] = useState("");
  const [battery, setBattery] = useState<BatteryInfo | null>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const collapseSafetyTimerRef = useRef<number | null>(null);
  const isTransitioningRef = useRef(false);
  const expandedRef = useRef(false);
  const notchRef = useRef<HTMLDivElement | null>(null);
  const lyricsContainerRef = useRef<HTMLDivElement | null>(null);
  const [isSmartCompact, setIsSmartCompact] = useState(false);
  const [dropY, setDropY] = useState(0);
  const isDroppingRef = useRef(false);
  const [availableMonitors, setAvailableMonitors] = useState<{
    id: string;
    label: string;
    is_primary: boolean;
    width: number;
    height: number;
    scale_factor: number;
  }[]>([]);

  const triggerBezelDrop = () => {
    if (isDroppingRef.current) return;
    isDroppingRef.current = true;

    // 1. Instantly tuck the notch up off-screen behind the display bezel
    const tuckOffset = expandedRef.current ? -100 : -56;
    setDropY(tuckOffset);

    // 2. Wait 95ms for OS SetWindowPos, DPI swap & DWM surface presentation on new screen
    setTimeout(() => {
      setDropY(0);
      setTimeout(() => {
        isDroppingRef.current = false;
      }, 500);
    }, 95);
  };

  useEffect(() => {
    invoke<{
      id: string;
      label: string;
      is_primary: boolean;
      width: number;
      height: number;
      scale_factor: number;
    }[]>("get_available_monitors")
      .then((mons) => {
        if (mons) {
          const physical = mons.filter((m) => m.id !== "primary");
          setAvailableMonitors(physical.length > 0 ? physical : mons);
        }
      })
      .catch(() => {});
  }, []);

  const cycleMonitor = () => {
    if (availableMonitors.length < 2) return;
    const currentId = settings.targetMonitor ?? "primary";
    const currentIdx = availableMonitors.findIndex((m) => m.id === currentId);
    const nextIdx = (currentIdx + 1) % availableMonitors.length;
    const nextMon = availableMonitors[nextIdx];
    if (nextMon) {
      const updated = { ...settings, targetMonitor: nextMon.id };
      setSettings(updated);
      saveSettings(updated);
      emit("notch-settings-update", updated).catch(() => {});
      invoke("set_notch_size", {
        width: 760,
        height: 400,
        targetMonitor: nextMon.id,
      }).catch(() => {});
      triggerBezelDrop();
    }
  };

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  const isCompact = !expanded && (Boolean(settings.compactMode) || (Boolean(settings.smartTabAvoidance ?? true) && isSmartCompact));

  // Load responsive dimensions from Rust based on active monitor
  useEffect(() => {
    invoke<NotchDimensions>("get_notch_config", {
      targetMonitor: settings.targetMonitor ?? "primary",
    })
      .then((cfg) => {
        if (cfg) setDims(cfg);
      })
      .catch((err) => console.error("Failed to load dimensions:", err));
  }, [settings.targetMonitor]);

  // Track monitor changes to trigger bezel-drop spring animation
  const prevMonitorRef = useRef<string | undefined>(settings.targetMonitor);

  useEffect(() => {
    if (prevMonitorRef.current !== undefined && prevMonitorRef.current !== settings.targetMonitor) {
      triggerBezelDrop();
    }
    prevMonitorRef.current = settings.targetMonitor;
  }, [settings.targetMonitor]);

  // Listen to game mode shifts & backend repositioning for bezel-drop animation
  useEffect(() => {
    const unlistenStatus = listen<{ active: boolean; shifted_to?: string | null }>("game-mode-status", (event) => {
      if (event.payload.shifted_to || !event.payload.active) {
        triggerBezelDrop();
      }
    });

    const unlistenRepo = listen<string | null>("notch-monitor-repositioned", () => {
      triggerBezelDrop();
    });

    return () => {
      unlistenStatus.then((fn) => fn());
      unlistenRepo.then((fn) => fn());
    };
  }, []);

  // Immediate reposition when target monitor changes in settings
  useEffect(() => {
    invoke("set_notch_size", {
      width: 760,
      height: 400,
      targetMonitor: settings.targetMonitor ?? "primary",
    }).catch(() => {});
  }, [settings.targetMonitor]);

  // Listen to smart avoidance updates from Rust detector
  useEffect(() => {
    const unlistenPromise = listen<{ compact: boolean }>("smart-avoidance-status", (event) => {
      setIsSmartCompact(event.payload.compact);
    });
    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  // Update geometry when compact state toggles while collapsed
  useEffect(() => {
    if (!expandedRef.current && !isTransitioningRef.current) {
      updateGeometry(false, isCompact ? 114 : dynamicCollapsedWidth, isCompact ? 22 : dims.collapsed_height);
    }
  }, [isCompact]);

  const isInsideNotch = (clientX: number, clientY: number): boolean => {
    if (!notchRef.current) return false;
    const rect = notchRef.current.getBoundingClientRect();
    return (
      clientX >= rect.left - 2 &&
      clientX <= rect.right + 2 &&
      clientY >= rect.top - 2 &&
      clientY <= rect.bottom + 2
    );
  };

  const cancelCollapse = () => {
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
    if (collapseSafetyTimerRef.current) {
      clearTimeout(collapseSafetyTimerRef.current);
      collapseSafetyTimerRef.current = null;
    }
  };

  const finishCollapse = () => {
    if (collapseSafetyTimerRef.current) {
      clearTimeout(collapseSafetyTimerRef.current);
      collapseSafetyTimerRef.current = null;
    }
    setShowAudioSwitcher(false);
    isTransitioningRef.current = false;
    updateGeometry(false, isCompact ? 114 : dynamicCollapsedWidth, isCompact ? 22 : dims.collapsed_height);
  };

  // Fetch audio status on app mount and on expand
  useEffect(() => {
    invoke<AudioStatus>("get_audio_status")
      .then(setAudioStatus)
      .catch((err) => console.error("Failed to get audio status:", err));
  }, []);

  useEffect(() => {
    if (expanded) {
      setShowVolumeHud(false);
      if (volumeHudTimeoutRef.current) {
        window.clearTimeout(volumeHudTimeoutRef.current);
      }
      invoke<AudioStatus>("get_audio_status")
        .then(setAudioStatus)
        .catch((err) => console.error("Failed to get audio status:", err));
    } else {
      setShowAudioSwitcher(false);
    }
  }, [expanded]);

  // Real-time synchronization for system volume & audio device changes
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{
      volume: number;
      is_muted: boolean;
      output_id: string;
      output_name: string;
    }>("audio_status_changed", (event) => {
      setAudioStatus((prev) => {
        if (!prev) {
          return {
            master_volume: event.payload.volume,
            is_muted: event.payload.is_muted,
            current_output_id: event.payload.output_id,
            current_output_name: event.payload.output_name,
            current_input_id: null,
            current_input_name: null,
            output_devices: [],
            input_devices: [],
          };
        }
        return {
          ...prev,
          master_volume: event.payload.volume,
          is_muted: event.payload.is_muted,
          current_output_id: event.payload.output_id,
          current_output_name: event.payload.output_name,
        };
      });

      const isVolChange =
        lastKnownVolumeRef.current !== null &&
        (Math.abs(lastKnownVolumeRef.current - event.payload.volume) > 0.004 ||
          lastKnownMuteRef.current !== event.payload.is_muted);

      lastKnownVolumeRef.current = event.payload.volume;
      lastKnownMuteRef.current = event.payload.is_muted;

      // Show sleek volume HUD slider in collapsed notch when volume shortcut is pressed
      if (isVolChange && !isInitialAudioEventRef.current && !expandedRef.current) {
        setShowVolumeHud(true);
        if (volumeHudTimeoutRef.current) {
          window.clearTimeout(volumeHudTimeoutRef.current);
        }
        volumeHudTimeoutRef.current = window.setTimeout(() => {
          setShowVolumeHud(false);
        }, 1500);
      }

      isInitialAudioEventRef.current = false;
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) unlisten();
      if (volumeHudTimeoutRef.current) {
        window.clearTimeout(volumeHudTimeoutRef.current);
      }
    };
  }, []);

  const scheduleCollapse = (delay = 200) => {
    cancelCollapse();
    collapseTimerRef.current = window.setTimeout(() => {
      isTransitioningRef.current = true;
      expandedRef.current = false;
      setExpanded(false);
      // Safety fallback only if animation complete event is dropped
      collapseSafetyTimerRef.current = window.setTimeout(() => {
        finishCollapse();
      }, 1000);
    }, delay);
  };

  // Auto-expand and switch to shelf on drag hover over collapsed notch or native drag-enter
  useEffect(() => {
    let unlistenHover: (() => void) | undefined;
    let unlistenEnter: (() => void) | undefined;
    let unlistenLeave: (() => void) | undefined;
    let unlistenDrop: (() => void) | undefined;

    const setupDragListeners = async () => {
      unlistenHover = await listen<boolean>("notch-drag-hover-pill", () => {
        cancelCollapse();
        if (!expandedRef.current) {
          isTransitioningRef.current = true;
          expandedRef.current = true;
          setExpanded(true);
          setActiveModule("shelf");
        }
      });

      unlistenEnter = await listen<{ paths?: string[]; x: number; y: number }>("notch-drag-enter", () => {
        cancelCollapse();
        if (!expandedRef.current) {
          isTransitioningRef.current = true;
          expandedRef.current = true;
          setExpanded(true);
          setActiveModule("shelf");
        }
      });

      unlistenLeave = await listen("notch-drag-leave", () => {
        if (expandedRef.current) {
          scheduleCollapse(1200);
        }
      });

      unlistenDrop = await listen("notch-drag-drop", () => {
        cancelCollapse();
      });
    };

    setupDragListeners();

    return () => {
      if (unlistenHover) unlistenHover();
      if (unlistenEnter) unlistenEnter();
      if (unlistenLeave) unlistenLeave();
      if (unlistenDrop) unlistenDrop();
    };
  }, []);

  const handleMouseEnter = () => {
    cancelCollapse();
    if (!expandedRef.current) {
      isTransitioningRef.current = true;
      expandedRef.current = true;
      setExpanded(true);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isInsideNotch(e.clientX, e.clientY)) {
      cancelCollapse();
    } else if (expandedRef.current) {
      scheduleCollapse(180);
    }
  };

  const handleMouseLeave = (e: React.MouseEvent) => {
    if (isInsideNotch(e.clientX, e.clientY)) {
      return;
    }
    if (expandedRef.current) {
      scheduleCollapse(180);
    }
  };

  const handleManualCollapse = () => {
    cancelCollapse();
    isTransitioningRef.current = true;
    expandedRef.current = false;
    setExpanded(false);
    collapseSafetyTimerRef.current = window.setTimeout(() => {
      finishCollapse();
    }, 1000);
  };

  // Ensure notch collapses when cursor leaves the native window entirely
  useEffect(() => {
    const handleWindowLeave = () => {
      if (expandedRef.current) {
        scheduleCollapse(150);
      }
    };
    document.addEventListener("mouseleave", handleWindowLeave);
    window.addEventListener("blur", handleWindowLeave);
    return () => {
      document.removeEventListener("mouseleave", handleWindowLeave);
      window.removeEventListener("blur", handleWindowLeave);
    };
  }, [expanded]);

  // Switch between expanded views
  const switchView = (e: React.MouseEvent, view: "player" | "lyrics" | "queue") => {
    e.stopPropagation();
    setActiveModule("media");
    setExpandedView(view);
    if (expandedRef.current) {
      updateGeometry(true, dims.expanded_width, view !== "player" ? dims.lyrics_height : dims.expanded_height);
    }
  };

  const handleOpenSettings = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await invoke("open_settings");
    } catch {}
  };

  const formatMs = (ms: number) => {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  // Clock ticker - clean standard HH:mm with tabular numerals
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const hours = String(now.getHours()).padStart(2, "0");
      const minutes = String(now.getMinutes()).padStart(2, "0");
      setTime(`${hours}:${minutes}`);
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // Real-time battery status synchronization
  useEffect(() => {
    invoke<BatteryInfo>("get_battery_info")
      .then((info) => setBattery(info))
      .catch(() => {});

    const unlistenPromise = listen<BatteryInfo>("battery-status", (event) => {
      setBattery(event.payload);
    });
    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  // Synchronize notch customization settings
  useEffect(() => {
    const unlistenPromise = listen<NotchSettings>("notch-settings-update", (event) => {
      if (event.payload) {
        setSettings(event.payload);
      }
    });

    const handleStorage = (e: StorageEvent) => {
      if (e.key === "notch_custom_settings" && e.newValue) {
        try {
          setSettings(JSON.parse(e.newValue));
        } catch {}
      }
    };
    window.addEventListener("storage", handleStorage);

    return () => {
      unlistenPromise.then((fn) => fn());
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  // Sync game mode detector state
  useEffect(() => {
    invoke("set_game_mode", { enabled: settings.gameModeAutoShift ?? true }).catch(() => {});
  }, [settings.gameModeAutoShift]);

  // Media listener & initial fetch
  useEffect(() => {
    invoke<MediaTrack>("get_media_track")
      .then((data) => {
        if (data) {
          setMedia(data);
          setPlaybackPos(data.position_sec);
        }
      })
      .catch(() => {});

    const unlistenPromise = listen<MediaTrack>("media-status", (event) => {
      setMedia(event.payload);
      // Continuous timeline resync: keep smooth interpolation aligned with backend
      setPlaybackPos((prev) => {
        if (Math.abs(prev - event.payload.position_sec) > 0.35) {
          return event.payload.position_sec;
        }
        return prev;
      });
    });

    const unlistenQueuePromise = listen<any>(
      "spotify-queue-update",
      (event) => {
        const payload = event.payload;
        const tracks: QueueTrack[] = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.tracks)
          ? payload.tracks
          : [];
        if (tracks.length > 0) {
          setQueue(tracks);
        }
      }
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
      unlistenQueuePromise.then((unlisten) => unlisten());
    };
  }, []);

  // Smooth position interpolation between 500ms sync ticks
  useEffect(() => {
    if (!media.is_playing) return;
    const interval = setInterval(() => {
      setPlaybackPos((prev) => {
        if (media.duration_sec > 0 && prev >= media.duration_sec) return prev;
        return prev + 0.05;
      });
    }, 50);
    return () => clearInterval(interval);
  }, [media.is_playing, media.duration_sec]);

  // Fetch lyrics from LRCLIB when track changes
  useEffect(() => {
    if (!media.has_media || !media.title) {
      setLyrics([]);
      setPlainLyrics("");
      return;
    }

    const trackKey = `${media.title}-${media.artist}`;
    if (lastFetchedTrackRef.current === trackKey) return;
    lastFetchedTrackRef.current = trackKey;

    setLyricsLoading(true);

    // Clean track title & artist
    let cleanTitle = media.title
      .replace(
        /\s*[\(\[](?:official|lyrics|video|audio|remastered|feat\.|ft\.).*?[\)\]]/gi,
        ""
      )
      .replace(/-\s*$/, "")
      .trim();

    let cleanArtist = media.artist.replace(/-\s*$/, "").trim();

    if (cleanTitle.includes(" - ")) {
      const parts = cleanTitle.split(" - ");
      cleanTitle = parts[0].trim();
      if (!cleanArtist) cleanArtist = parts[1].trim();
    }

    const fetchUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(
      cleanTitle
    )}&artist_name=${encodeURIComponent(cleanArtist)}`;

    fetch(fetchUrl, {
      headers: {
        "User-Agent": "NotchApp v1.0 (https://github.com/notch)",
      },
    })
      .then(async (res) => {
        if (res.ok) {
          return res.json();
        }
        const searchRes = await fetch(
          `https://lrclib.net/api/search?q=${encodeURIComponent(
            cleanTitle + " " + cleanArtist
          )}`,
          {
            headers: {
              "User-Agent": "NotchApp v1.0 (https://github.com/notch)",
            },
          }
        );
        if (searchRes.ok) {
          const list = await searchRes.json();
          if (Array.isArray(list) && list.length > 0) {
            return list[0];
          }
        }
        return null;
      })
      .then((data) => {
        setLyricsLoading(false);
        if (data) {
          if (data.syncedLyrics) {
            setLyrics(parseLrc(data.syncedLyrics));
          } else {
            setLyrics([]);
          }
          setPlainLyrics(data.plainLyrics || "");
        } else {
          setLyrics([]);
          setPlainLyrics("");
        }
      })
      .catch(() => {
        setLyricsLoading(false);
        setLyrics([]);
        setPlainLyrics("");
      });
  }, [media.title, media.artist, media.has_media]);

  // Current active lyric line index with anticipatory lead
  const activeLyricIndex = useMemo(() => {
    if (lyrics.length === 0) return -1;
    // Add customizable lead time to anticipate vocal onset
    const syncPos = playbackPos + (settings.leadTime ?? 0.3);
    for (let i = lyrics.length - 1; i >= 0; i--) {
      if (syncPos >= lyrics[i].time) {
        return i;
      }
    }
    return 0;
  }, [lyrics, playbackPos, settings.leadTime]);

  const currentLyricText = useMemo(() => {
    if (lyrics.length > 0 && activeLyricIndex >= 0) {
      return lyrics[activeLyricIndex]?.text || "";
    }
    return "";
  }, [lyrics, activeLyricIndex]);

  // Dynamic width when collapsed based on lyric length with adaptive font scaling
  const dynamicCollapsedWidth = useMemo(() => {
    if (isCompact) {
      return 114;
    }
    if (showLyrics && currentLyricText) {
      const charWidth = 7.6 * (settings.fontSizeScale ?? 1.0);
      const basePadding = battery?.has_battery ? 155 : 125;
      const calculated = currentLyricText.length * charWidth + basePadding;
      const maxWidth = Math.min(dims.expanded_width * 1.5, 640);
      return Math.min(
        maxWidth,
        Math.max(dims.collapsed_width, calculated)
      );
    }
    return dims.collapsed_width;
  }, [isCompact, showLyrics, currentLyricText, dims.collapsed_width, dims.expanded_width, settings.fontSizeScale, battery?.has_battery]);

  // Track text overflow for continuous marquee if lyric exceeds max width
  const lyricOverflowInfo = useMemo(() => {
    if (!currentLyricText) return { isOverflowing: false, distance: 0 };
    const charWidth = 7.6 * (settings.fontSizeScale ?? 1.0);
    const estimatedTextWidth = currentLyricText.length * charWidth;
    const basePadding = battery?.has_battery ? 155 : 125;
    const availableWidth = dynamicCollapsedWidth - basePadding;
    const distance = Math.max(0, estimatedTextWidth - availableWidth);
    return {
      isOverflowing: distance > 8,
      distance: Math.ceil(distance),
    };
  }, [currentLyricText, dynamicCollapsedWidth, settings.fontSizeScale, battery?.has_battery]);

  // Distinct width & height per view module: expanded widths and heights can differ freely
  const targetWidth = useMemo(() => {
    if (!expanded) {
      if (showVolumeHud) return 260;
      return isCompact ? 114 : dynamicCollapsedWidth;
    }
    if (showAudioSwitcher) return 480;
    if (activeModule === "todo" || activeModule === "shelf") return 520;
    if (expandedView === "lyrics" || expandedView === "queue") return 480;
    if (activeModule === "perf") return 470;
    return 460;
  }, [expanded, isCompact, dynamicCollapsedWidth, showVolumeHud, showAudioSwitcher, activeModule, expandedView]);

  const targetHeight = useMemo(() => {
    if (!expanded) {
      if (showVolumeHud && isCompact) return 26;
      return isCompact ? 22 : dims.collapsed_height;
    }
    if (showAudioSwitcher) return 335;
    if (activeModule === "todo" || activeModule === "shelf") return 290;
    if (expandedView === "lyrics" || expandedView === "queue") return 320;
    if (activeModule === "perf") return 258;
    return dims.expanded_height || 232;
  }, [expanded, isCompact, dims.collapsed_height, dims.expanded_height, showVolumeHud, showAudioSwitcher, activeModule, expandedView]);

  // Zero-Resize Architecture: Notify Rust about current pill geometry for click-through hit-testing
  const updateGeometry = (
    isExp: boolean,
    customWidth?: number,
    customHeight?: number
  ) => {
    const activeWidth = customWidth ?? targetWidth;
    const activeHeight = customHeight ?? targetHeight;
    invoke("update_notch_geometry", {
      isExpanded: isExp,
      width: Math.ceil(activeWidth),
      height: Math.ceil(activeHeight),
    }).catch(() => {});
  };

  // Keep hit-test bounding box strictly in sync whenever target dimensions change
  useEffect(() => {
    updateGeometry(expanded, targetWidth, targetHeight);
  }, [expanded, targetWidth, targetHeight]);

  // Update geometry whenever dynamicCollapsedWidth changes (not animating)
  useEffect(() => {
    if (!expandedRef.current && !isTransitioningRef.current && !showVolumeHud) {
      updateGeometry(false, dynamicCollapsedWidth);
    }
  }, [dynamicCollapsedWidth, showVolumeHud]);

  // Auto-scroll lyrics to keep active line centered
  useEffect(() => {
    if (!showLyrics || activeLyricIndex < 0 || !lyricsContainerRef.current) return;
    const activeEl = lyricsContainerRef.current.children[
      activeLyricIndex
    ] as HTMLElement;
    if (activeEl) {
      activeEl.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [activeLyricIndex, showLyrics]);

  const togglePlay = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await invoke("media_toggle_play");
      setMedia((prev) => ({ ...prev, is_playing: !prev.is_playing }));
    } catch (err) {
      console.error(err);
    }
  };

  const nextTrack = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await invoke("media_next_track");
    } catch (err) {
      console.error(err);
    }
  };

  const prevTrack = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await invoke("media_prev_track");
    } catch (err) {
      console.error(err);
    }
  };

  const targetBorderRadius = isCompact
    ? "0px 0px 11px 11px"
    : `0px 0px ${settings.borderRadius}px ${settings.borderRadius}px`;

  return (
    <div
      className="w-full h-full flex flex-col items-center justify-start select-none overflow-hidden"
      onMouseMove={(e) => {
        if (expandedRef.current && !isInsideNotch(e.clientX, e.clientY)) {
          scheduleCollapse(200);
        }
      }}
    >
      <motion.div
        ref={notchRef}
        onWheel={handleContainerWheel}
        initial={false}
        animate={{
          width: targetWidth,
          height: targetHeight,
          borderRadius: targetBorderRadius,
          y: dropY,
        }}
        transition={{
          width: expanded
            ? { type: "spring", stiffness: 300, damping: settings.springBounciness ?? 26, mass: 0.8 }
            : { type: "spring", stiffness: 310, damping: (settings.springBounciness ?? 26) + 4, mass: 0.8 },
          height: expanded
            ? { type: "spring", stiffness: 300, damping: settings.springBounciness ?? 26, mass: 0.8 }
            : { type: "spring", stiffness: 310, damping: (settings.springBounciness ?? 26) + 4, mass: 0.8 },
          borderRadius: expanded
            ? { type: "spring", stiffness: 300, damping: settings.springBounciness ?? 26, mass: 0.8 }
            : { type: "spring", stiffness: 310, damping: (settings.springBounciness ?? 26) + 4, mass: 0.8 },
          y: dropY < 0
            ? { duration: 0 }
            : { type: "spring", stiffness: 340, damping: 20, mass: 0.7 },
        }}
        onAnimationComplete={() => {
          if (!expandedRef.current && isTransitioningRef.current) {
            finishCollapse();
          } else {
            isTransitioningRef.current = false;
          }
        }}
        onMouseEnter={handleMouseEnter}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onDragEnter={(e) => {
          e.preventDefault();
          cancelCollapse();
          if (!expandedRef.current) {
            isTransitioningRef.current = true;
            expandedRef.current = true;
            setExpanded(true);
            setActiveModule("shelf");
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          cancelCollapse();
          if (!expandedRef.current) {
            isTransitioningRef.current = true;
            expandedRef.current = true;
            setExpanded(true);
            setActiveModule("shelf");
          }
        }}
        onClick={() => {
          if (!expanded) handleMouseEnter();
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          const nextCompact = !settings.compactMode;
          const updated = { ...settings, compactMode: nextCompact };
          setSettings(updated);
          saveSettings(updated);
          emit("notch-settings-update", updated).catch(() => {});
        }}
        className={`group relative ${
          expanded
            ? "shadow-[0_16px_36px_rgba(0,0,0,0.85)]"
            : "shadow-[0_2px_8px_rgba(0,0,0,0.4)]"
        } backdrop-blur-2xl cursor-pointer flex flex-col overflow-hidden mx-auto transition-shadow duration-300`}
        style={{
          backgroundColor: hexToRgba(settings.bgColor, settings.bgOpacity),
          borderColor: hexToRgba(settings.borderColor, settings.borderOpacity),
          borderWidth: settings.borderOpacity > 0 ? "1px" : "0px",
          borderTopWidth: "0px",
          color: settings.textColor,
          fontWeight: Number(settings.fontWeight),
        }}
      >
        <AnimatePresence initial={false}>
          {!expanded ? (
            /* Collapsed View - Anchored strictly to top to prevent vertical slide jitter */
            <motion.div
              key="collapsed"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, pointerEvents: "none" }}
              transition={{ duration: 0.18 }}
              className={`absolute top-0 left-0 right-0 flex items-center justify-between ${
                isCompact ? "h-[22px] px-2.5 py-0.5" : "h-[36px] px-3.5 py-1.5"
              }`}
            >
              <AnimatePresence mode="wait" initial={false}>
                {showVolumeHud ? (
                  <motion.div
                    key="volume-hud-view"
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.96 }}
                    transition={{ duration: 0.14 }}
                    className="flex items-center justify-between w-full h-full gap-2.5 select-none px-0.5"
                  >
                    <div className="shrink-0 flex items-center">
                      {audioStatus?.is_muted || (audioStatus?.master_volume ?? 0) === 0 ? (
                        <VolumeX className="w-3.5 h-3.5 text-rose-400" />
                      ) : (
                        <Volume2
                          className="w-3.5 h-3.5"
                          style={{ color: settings.accentColor }}
                        />
                      )}
                    </div>

                    <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden relative">
                      <motion.div
                        className="h-full rounded-full"
                        style={{
                          backgroundColor: (audioStatus?.is_muted ?? false) ? "#f43f5e" : settings.accentColor,
                        }}
                        animate={{
                          width: `${Math.round(((audioStatus?.is_muted ? 0 : audioStatus?.master_volume) ?? 0) * 100)}%`,
                        }}
                        transition={{ type: "spring", stiffness: 350, damping: 28 }}
                      />
                    </div>

                    <span className="font-mono text-[11px] tabular-nums font-semibold text-neutral-300 w-8 text-right shrink-0">
                      {audioStatus?.is_muted ? "0%" : `${Math.round((audioStatus?.master_volume ?? 0) * 100)}%`}
                    </span>
                  </motion.div>
                ) : isCompact ? (
                  /* Compact Pill Content */
                  <motion.div
                    key="compact-view"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.14 }}
                    className="flex items-center justify-between w-full h-full select-none"
                  >
                  <div className="flex items-center gap-1.5 shrink-0">
                    {media.has_media && media.is_playing ? (
                      <div className="flex items-end gap-[1.5px] h-2.5 shrink-0">
                        <motion.span
                          animate={{ height: ["3px", "8px", "4px", "9px", "3px"] }}
                          transition={{ repeat: Infinity, duration: 1.2, ease: "easeInOut" }}
                          className="w-[2px] rounded-full"
                          style={{ backgroundColor: settings.accentColor }}
                        />
                        <motion.span
                          animate={{ height: ["6px", "3px", "9px", "4px", "6px"] }}
                          transition={{ repeat: Infinity, duration: 1.0, ease: "easeInOut", delay: 0.15 }}
                          className="w-[2px] rounded-full"
                          style={{ backgroundColor: settings.accentColor }}
                        />
                        <motion.span
                          animate={{ height: ["8px", "4px", "3px", "9px", "8px"] }}
                          transition={{ repeat: Infinity, duration: 1.1, ease: "easeInOut", delay: 0.3 }}
                          className="w-[2px] rounded-full"
                          style={{ backgroundColor: settings.accentColor }}
                        />
                      </div>
                    ) : (
                      <span className="w-1.5 h-1.5 rounded-full bg-neutral-500/80" />
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {battery && battery.has_battery && (
                      <div className="flex items-center gap-0.5">
                        {battery.is_charging && (
                          <Zap className="w-2 h-2 text-emerald-400 fill-emerald-400" />
                        )}
                        <span
                          className={`font-mono text-[9px] tabular-nums font-medium ${
                            battery.is_charging
                              ? "text-emerald-400"
                              : battery.percent <= 20
                              ? "text-rose-400"
                              : "text-neutral-400"
                          }`}
                          style={{ fontSize: `${9 * settings.fontSizeScale}px` }}
                        >
                          {battery.percent}%
                        </span>
                      </div>
                    )}
                    <span className="text-[10px] font-mono font-semibold tracking-tight text-neutral-200 tabular-nums">
                      {time}
                    </span>
                  </div>
                </motion.div>
              ) : (
                /* Normal Collapsed View */
                <motion.div
                  key="normal-view"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.14 }}
                  className="flex items-center justify-between w-full h-full"
                >
                  <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0 mr-2">
                    {activeModule === "media" ? (
                      <>
                        {media.has_media && media.is_playing ? (
                          <div className="flex items-end gap-[2px] h-3.5 shrink-0 px-0.5">
                            <motion.span
                              animate={{ height: ["4px", "12px", "6px", "14px", "4px"] }}
                              transition={{ repeat: Infinity, duration: 1.2, ease: "easeInOut" }}
                              className="w-[2.5px] rounded-full"
                              style={{ backgroundColor: settings.accentColor }}
                            />
                            <motion.span
                              animate={{ height: ["8px", "4px", "14px", "6px", "8px"] }}
                              transition={{ repeat: Infinity, duration: 1.0, ease: "easeInOut", delay: 0.15 }}
                              className="w-[2.5px] rounded-full"
                              style={{ backgroundColor: settings.accentColor }}
                            />
                            <motion.span
                              animate={{ height: ["12px", "6px", "4px", "14px", "12px"] }}
                              transition={{ repeat: Infinity, duration: 1.1, ease: "easeInOut", delay: 0.3 }}
                              className="w-[2.5px] rounded-full"
                              style={{ backgroundColor: settings.accentColor }}
                            />
                          </div>
                        ) : (
                          <Music2 className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                        )}

                        {showLyrics && currentLyricText ? (
                          <AnimatePresence mode="popLayout" initial={false}>
                            <motion.span
                              key={currentLyricText}
                              initial={{ opacity: 0, y: 10, filter: "blur(4px)" }}
                              animate={{
                                opacity: 1,
                                y: 0,
                                filter: "blur(0px)",
                                x: lyricOverflowInfo.isOverflowing
                                  ? [0, 0, -lyricOverflowInfo.distance, -lyricOverflowInfo.distance, 0]
                                  : 0,
                              }}
                              exit={{ opacity: 0, y: -10, filter: "blur(4px)" }}
                              transition={{
                                type: "spring",
                                stiffness: 380,
                                damping: 28,
                                opacity: { duration: 0.2 },
                                x: lyricOverflowInfo.isOverflowing
                                  ? {
                                      duration: Math.max(3.8, lyricOverflowInfo.distance / 18),
                                      times: [0, 0.22, 0.65, 0.85, 1],
                                      repeat: Infinity,
                                      repeatDelay: 1.2,
                                      ease: "easeInOut",
                                    }
                                  : undefined,
                              }}
                              className="select-none inline-block whitespace-nowrap"
                              style={{
                                color: settings.accentColor,
                                fontWeight: Number(settings.fontWeight),
                                fontSize: `${12 * settings.fontSizeScale}px`,
                              }}
                            >
                              {currentLyricText}
                            </motion.span>
                          </AnimatePresence>
                        ) : (
                          <span
                            className="truncate select-none"
                            style={{
                              color: settings.textColor,
                              fontWeight: Number(settings.fontWeight),
                              fontSize: `${12 * settings.fontSizeScale}px`,
                            }}
                          >
                            {media.has_media ? media.title : "Notch"}
                          </span>
                        )}
                      </>
                    ) : activeModule === "todo" ? (
                      /* Todo Collapsed Item */
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <ListTodo
                          className="w-3.5 h-3.5 shrink-0"
                          style={{ color: settings.accentColor }}
                        />
                        <span
                          className="truncate select-none font-medium"
                          style={{
                            color: firstPendingTodo ? settings.textColor : "#9ca3af",
                            fontSize: `${12 * settings.fontSizeScale}px`,
                          }}
                        >
                          {firstPendingTodo
                            ? firstPendingTodo.text
                            : todos.length > 0
                            ? "All tasks completed!"
                            : "No tasks yet"}
                        </span>
                      </div>
                    ) : activeModule === "shelf" ? (
                      /* Shelf Collapsed Item */
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <Layers
                          className="w-3.5 h-3.5 shrink-0"
                          style={{ color: settings.accentColor }}
                        />
                        <span
                          className="truncate select-none font-medium text-neutral-300"
                          style={{
                            fontSize: `${12 * settings.fontSizeScale}px`,
                          }}
                        >
                          Quick Launch & File Shelf
                        </span>
                      </div>
                    ) : (
                      /* Performance Monitor Collapsed Item */
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <Activity
                          className="w-3.5 h-3.5 shrink-0"
                          style={{ color: settings.accentColor }}
                        />
                        <span
                          className="truncate select-none font-medium text-neutral-300"
                          style={{
                            fontSize: `${12 * settings.fontSizeScale}px`,
                          }}
                        >
                          System Performance
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Right Status: Sleek Battery + Modern Digital Clock */}
                  <div className="flex items-center gap-2 shrink-0 select-none">
                    {battery && battery.has_battery && (
                      <div
                        className="flex items-center gap-1.5"
                        title={`Battery: ${battery.percent}%${battery.is_charging ? " (Plugged In / Charging)" : ""}`}
                      >
                        {battery.is_charging && (
                          <Zap className="w-2.5 h-2.5 text-emerald-400 fill-emerald-400 animate-pulse" />
                        )}
                        <span
                          className={`font-mono text-[10px] tabular-nums font-medium ${
                            battery.is_charging
                              ? "text-emerald-400"
                              : battery.percent <= 20
                              ? "text-rose-400 font-semibold"
                              : "text-neutral-300"
                          }`}
                          style={{ fontSize: `${10 * settings.fontSizeScale}px` }}
                        >
                          {battery.percent}%
                        </span>
                        {/* Apple-style Battery Capsule */}
                        <div className="flex items-center">
                          <div
                            className={`w-[19px] h-[9.5px] rounded-[3px] border p-[1px] flex items-center ${
                              battery.is_charging
                                ? "border-emerald-500/80 bg-emerald-950/20"
                                : battery.percent <= 20
                                ? "border-rose-500/80 bg-rose-950/20"
                                : "border-neutral-500/80 bg-white/5"
                            }`}
                          >
                            <div
                              className={`h-full rounded-[1.5px] transition-all duration-300 ${
                                battery.is_charging
                                  ? "bg-emerald-400"
                                  : battery.percent <= 20
                                  ? "bg-rose-400"
                                  : "bg-neutral-200"
                              }`}
                              style={{
                                width: `${Math.max(10, Math.min(100, battery.percent))}%`,
                              }}
                            />
                          </div>
                          {/* Battery Nipple */}
                          <div
                            className={`w-[1.5px] h-[4px] rounded-r-[0.5px] -ml-[0.5px] ${
                              battery.is_charging
                                ? "bg-emerald-500/80"
                                : battery.percent <= 20
                                ? "bg-rose-500/80"
                                : "bg-neutral-500/80"
                            }`}
                          />
                        </div>
                      </div>
                    )}

                    {battery && battery.has_battery && (
                      <span className="w-0.5 h-0.5 rounded-full bg-neutral-600/80" />
                    )}

                    <span
                      className="font-mono text-[11px] font-semibold tracking-tight text-neutral-200 tabular-nums"
                      style={{ fontSize: `${11 * settings.fontSizeScale}px` }}
                    >
                      {time}
                    </span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
          ) : (
            /* Expanded View */
            <motion.div
              key="expanded"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, pointerEvents: "none" }}
              transition={{ duration: 0.2 }}
              style={{
                width: targetWidth,
                height: targetHeight,
              }}
              className="w-full h-full relative group/expanded flex flex-col justify-between p-4 pb-3 overflow-hidden"
            >
              {/* Header Bar */}
              <div
                onWheel={(e) => {
                  const now = Date.now();
                  if (now - lastWheelTimeRef.current < 260) return;
                  if (Math.abs(e.deltaX) > 10 || Math.abs(e.deltaY) > 10) {
                    lastWheelTimeRef.current = now;
                    switchModule(undefined, e.deltaY > 0 || e.deltaX > 0 ? "next" : "prev");
                  }
                }}
                className="flex items-center justify-between pb-2 border-b border-white/5"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{
                      backgroundColor: settings.accentColor,
                      boxShadow: `0 0 8px ${settings.accentColor}b3`,
                    }}
                  />
                  <span className="text-[11px] font-mono tracking-wider text-neutral-400 uppercase">
                    {activeModule === "todo"
                      ? "To-Do List"
                      : activeModule === "shelf"
                      ? "Quick Shelf & Stash"
                      : activeModule === "perf"
                      ? "Performance HUD"
                      : expandedView === "queue"
                      ? "Queue / Playlist"
                      : expandedView === "lyrics"
                      ? "Synchronized Lyrics"
                      : "Media Active"}
                  </span>
                  {activeModule === "todo" && (
                    <span className="px-1.5 py-0.5 rounded bg-white/10 text-[10px] font-mono text-neutral-300">
                      {todos.filter((t) => t.completed).length}/{todos.length} done
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  {/* Module Page Indicator: Dots only without top arrows */}
                  <div className="flex items-center gap-1 px-1.5 py-0.5 bg-white/5 rounded-full border border-white/5">
                    <button
                      type="button"
                      onClick={() => switchModule("media")}
                      title="Media Player"
                      className="p-1 rounded-full flex items-center justify-center transition-all cursor-pointer hover:bg-white/10"
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full transition-all ${
                          activeModule === "media"
                            ? "bg-white scale-125 shadow-[0_0_6px_rgba(255,255,255,0.8)]"
                            : "bg-neutral-600 hover:bg-neutral-400"
                        }`}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => switchModule("todo")}
                      title="To-Do List"
                      className="p-1 rounded-full flex items-center justify-center transition-all cursor-pointer hover:bg-white/10"
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full transition-all ${
                          activeModule === "todo"
                            ? "bg-white scale-125 shadow-[0_0_6px_rgba(255,255,255,0.8)]"
                            : "bg-neutral-600 hover:bg-neutral-400"
                        }`}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => switchModule("shelf")}
                      title="Quick Shelf & Stash"
                      className="p-1 rounded-full flex items-center justify-center transition-all cursor-pointer hover:bg-white/10"
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full transition-all ${
                          activeModule === "shelf"
                            ? "bg-white scale-125 shadow-[0_0_6px_rgba(255,255,255,0.8)]"
                            : "bg-neutral-600 hover:bg-neutral-400"
                        }`}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => switchModule("perf")}
                      title="Performance HUD"
                      className="p-1 rounded-full flex items-center justify-center transition-all cursor-pointer hover:bg-white/10"
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full transition-all ${
                          activeModule === "perf"
                            ? "bg-white scale-125 shadow-[0_0_6px_rgba(255,255,255,0.8)]"
                            : "bg-neutral-600 hover:bg-neutral-400"
                        }`}
                      />
                    </button>
                  </div>

                  {/* View Switcher: Player, Lyrics, Queue (Only in media module) */}
                  {activeModule === "media" && media.has_media && (
                    <div className="flex items-center bg-white/5 rounded-lg p-0.5 border border-white/5">
                      <button
                        onClick={(e) => switchView(e, "player")}
                        title="Player"
                        className={`p-1 rounded-md transition-colors ${
                          expandedView === "player"
                            ? "bg-white/15 text-white"
                            : "text-neutral-400 hover:text-white"
                        }`}
                      >
                        <Music2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => switchView(e, "lyrics")}
                        title="Lyrics"
                        className="p-1 rounded-md transition-colors"
                        style={
                          expandedView === "lyrics"
                            ? { backgroundColor: `${settings.accentColor}25`, color: settings.accentColor }
                            : { color: "#9ca3af" }
                        }
                      >
                        <Mic2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => switchView(e, "queue")}
                        title="Queue"
                        className="p-1 rounded-md transition-colors"
                        style={
                          expandedView === "queue"
                            ? { backgroundColor: `${settings.accentColor}25`, color: settings.accentColor }
                            : { color: "#9ca3af" }
                        }
                      >
                        <ListMusic className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}

                  {/* Audio Switcher Button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowAudioSwitcher((prev) => !prev);
                    }}
                    title="Audio Devices & Master Volume"
                    className={`p-1.5 rounded-lg transition-colors ${
                      showAudioSwitcher
                        ? "bg-white/20 text-white"
                        : "text-neutral-400 hover:text-white hover:bg-white/10"
                    }`}
                  >
                    {audioStatus?.is_muted || audioStatus?.master_volume === 0 ? (
                      <VolumeX className="w-3.5 h-3.5 text-rose-400" />
                    ) : (
                      <Volume2 className="w-3.5 h-3.5" />
                    )}
                  </button>

                  {/* Quick Monitor Switcher Button (when multiple displays are detected) */}
                  {availableMonitors.length > 1 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        cycleMonitor();
                      }}
                      title="Switch Notch to next monitor"
                      className="text-neutral-400 hover:text-white p-1.5 rounded-lg hover:bg-white/10 transition-colors cursor-pointer"
                    >
                      <Monitor className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {/* Settings Button */}
                  <button
                    onClick={handleOpenSettings}
                    title="Settings"
                    className="text-neutral-400 hover:text-white p-1.5 rounded-lg hover:bg-white/10 transition-colors"
                  >
                    <Settings className="w-3.5 h-3.5" />
                  </button>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleManualCollapse();
                    }}
                    className="text-neutral-400 hover:text-white p-1 rounded-full hover:bg-white/10 transition-colors"
                  >
                    <ChevronUp className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Floating Side Arrows for Next/Prev Module */}
              {activeModule !== "media" && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    switchModule(undefined, "prev");
                  }}
                  title="Previous Module"
                  className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-neutral-900/85 hover:bg-white/20 text-neutral-300 hover:text-white border border-white/10 transition-all shadow-xl z-30 active:scale-90"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
              )}

              {activeModule !== "perf" && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    switchModule(undefined, "next");
                  }}
                  title="Next Module"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-neutral-900/85 hover:bg-white/20 text-neutral-300 hover:text-white border border-white/10 transition-all shadow-xl z-30 active:scale-90"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}

              {/* Carousel Content Container */}
              <div className="flex-1 overflow-hidden relative pt-1">
                <AnimatePresence mode="wait" initial={false}>
                  {activeModule === "media" ? (
                    <motion.div
                      key="media-module"
                      initial={{ opacity: 0, x: -24 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -24 }}
                      transition={{ duration: 0.18 }}
                      className="h-full flex flex-col justify-between pr-5 pl-1"
                    >
                      {/* Middle Section: Player OR Lyrics OR Queue */}
              {expandedView === "player" ? (
                <>
                  <div className="flex items-center gap-3.5 py-1.5">
                    <div className="w-12 h-12 rounded-xl bg-neutral-900 border border-white/10 flex items-center justify-center shrink-0 overflow-hidden shadow-inner">
                      {media.has_media ? (
                        <Music2
                          className="w-6 h-6"
                          style={{ color: settings.accentColor }}
                        />
                      ) : (
                        <Sparkles className="w-5 h-5 text-neutral-500" />
                      )}
                    </div>

                    <div className="flex flex-col min-w-0 flex-1">
                      <span
                        className="truncate"
                        style={{
                          color: settings.textColor,
                          fontWeight: Number(settings.fontWeight),
                          fontSize: `${14 * settings.fontSizeScale}px`,
                        }}
                      >
                        {media.has_media ? media.title : "No Active Media"}
                      </span>
                      <span
                        className="text-neutral-400 truncate"
                        style={{ fontSize: `${12 * settings.fontSizeScale}px` }}
                      >
                        {media.has_media
                          ? media.artist || media.album || "Unknown Artist"
                          : `System Clock: ${time}`}
                      </span>

                      {audioStatus?.current_output_name && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowAudioSwitcher(true);
                          }}
                          className="flex items-center gap-1 mt-1 px-2 py-0.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/5 transition-all text-[10px] text-neutral-400 hover:text-neutral-200 w-fit max-w-[200px]"
                          title="Switch audio output device"
                        >
                          <Volume2
                            className="w-2.5 h-2.5 shrink-0"
                            style={{ color: settings.accentColor }}
                          />
                          <span className="truncate">
                            {audioStatus.current_output_name}
                          </span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Track Progress Bar */}
                  {media.has_media && media.duration_sec > 0 && (
                    <div className="flex flex-col gap-1.5 py-1.5">
                      <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-300"
                          style={{
                            backgroundColor: settings.accentColor,
                            width: `${Math.min(
                              100,
                              (playbackPos / media.duration_sec) * 100
                            )}%`,
                          }}
                        />
                      </div>
                      <div className="flex justify-between text-[10px] font-mono text-neutral-400">
                        <span>{formatTime(playbackPos)}</span>
                        <span>{formatTime(media.duration_sec)}</span>
                      </div>
                    </div>
                  )}
                </>
              ) : expandedView === "lyrics" ? (
                /* Lyrics Scroll Stream */
                <div className="my-1 flex-1 min-h-[140px] max-h-[150px] overflow-hidden flex flex-col justify-center">
                  {lyricsLoading ? (
                    <div className="text-xs text-neutral-500 text-center py-6 animate-pulse">
                      Mencari lirik...
                    </div>
                  ) : lyrics.length > 0 ? (
                    <div
                      ref={lyricsContainerRef}
                      className="overflow-y-auto max-h-[140px] pr-1 scroll-smooth flex flex-col gap-2.5 no-scrollbar py-2"
                      style={{ scrollbarWidth: "none" }}
                    >
                      {lyrics.map((line, idx) => {
                        const isActive = idx === activeLyricIndex;
                        return (
                          <p
                            key={idx}
                            className={`text-center transition-all duration-300 ${
                              isActive
                                ? "scale-105"
                                : "text-neutral-500 hover:text-neutral-300"
                            }`}
                            style={
                              isActive
                                ? {
                                    color: settings.accentColor,
                                    fontWeight: Math.min(800, Number(settings.fontWeight) + 100),
                                    fontSize: `${14 * settings.fontSizeScale}px`,
                                    filter: `drop-shadow(0 0 8px ${settings.accentColor}66)`,
                                  }
                                : {
                                    fontSize: `${12 * settings.fontSizeScale}px`,
                                  }
                            }
                          >
                            {line.text}
                          </p>
                        );
                      })}
                    </div>
                  ) : plainLyrics ? (
                    <div
                      className="overflow-y-auto max-h-[140px] pr-1 whitespace-pre-line text-xs text-neutral-300 text-center"
                      style={{ scrollbarWidth: "none" }}
                    >
                      {plainLyrics}
                    </div>
                  ) : (
                    <div className="text-xs text-neutral-500 text-center py-6">
                      Lirik tidak ditemukan untuk lagu ini
                    </div>
                  )}
                </div>
              ) : (
                /* Queue / Upcoming Tracks */
                <div className="my-1 flex-1 min-h-[140px] max-h-[150px] overflow-hidden flex flex-col">
                  <div className="flex items-center justify-between text-[10px] text-neutral-400 font-mono px-1 pb-1 border-b border-white/5">
                    <span>UPCOMING PLAYLIST</span>
                    <span>{queue.length > 0 ? `${queue.length} lagu` : "Menunggu Spotify..."}</span>
                  </div>
                  <div
                    className="flex-1 overflow-y-auto space-y-1 py-1.5 pr-0.5"
                    style={{ scrollbarWidth: "none" }}
                  >
                    {queue.length > 0 ? (
                      queue.map((track, idx) => (
                        <div
                          key={track.uri || idx}
                          className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.08] transition-colors group"
                        >
                          <span className="text-[10px] font-mono text-neutral-500 w-3.5 text-center shrink-0">
                            {idx + 1}
                          </span>
                          {track.image_url ? (
                            <img
                              src={track.image_url}
                              alt=""
                              className="w-7 h-7 rounded bg-neutral-900 object-cover shrink-0"
                              onError={(e) => {
                                (e.target as HTMLElement).style.display = "none";
                              }}
                            />
                          ) : (
                            <div className="w-7 h-7 rounded bg-neutral-900 flex items-center justify-center shrink-0 text-neutral-600">
                              <Music2 className="w-3.5 h-3.5" />
                            </div>
                          )}
                          <div className="flex-1 min-w-0 flex flex-col">
                            <span className="text-xs text-neutral-200 font-medium truncate group-hover:text-emerald-400 transition-colors">
                              {track.title}
                            </span>
                            <span className="text-[10px] text-neutral-400 truncate">
                              {track.artist}
                            </span>
                          </div>
                          {track.duration_ms > 0 && (
                            <span className="text-[10px] font-mono text-neutral-500 shrink-0">
                              {formatMs(track.duration_ms)}
                            </span>
                          )}
                        </div>
                      ))
                    ) : (
                      <div className="text-xs text-neutral-500 text-center py-8">
                        Putar lagu atau playlist di Spotify untuk memuat antrean
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Bottom Playback Controls */}
              <div className="flex items-center justify-center gap-5 pt-1.5 pb-0.5 border-t border-white/5">
                <button
                  onClick={prevTrack}
                  disabled={!media.has_media}
                  className="p-2 rounded-full text-neutral-400 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30"
                >
                  <SkipBack className="w-4 h-4 fill-current" />
                </button>

                <button
                  onClick={togglePlay}
                  disabled={!media.has_media}
                  className="p-2 rounded-full bg-white text-black hover:bg-neutral-200 transition-transform active:scale-95 disabled:opacity-30"
                >
                  {media.is_playing ? (
                    <Pause className="w-4 h-4 fill-current" />
                  ) : (
                    <Play className="w-4 h-4 fill-current ml-0.5" />
                  )}
                </button>

                <button
                  onClick={nextTrack}
                  disabled={!media.has_media}
                  className="p-2 rounded-full text-neutral-400 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30"
                >
                  <SkipForward className="w-4 h-4 fill-current" />
                </button>
              </div>
            </motion.div>
          ) : activeModule === "todo" ? (
            /* To-Do List Module */
            <motion.div
              key="todo-module"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.18 }}
              className="h-full pt-1 pl-5 pr-2"
            >
              <TodoList
                todos={todos}
                onToggle={handleToggleTodo}
                onAdd={handleAddTodo}
                onDelete={handleDeleteTodo}
                onClearCompleted={handleClearCompletedTodos}
                accentColor={settings.accentColor}
                fontSizeScale={settings.fontSizeScale}
              />
            </motion.div>
          ) : activeModule === "shelf" ? (
            /* Quick Shelf & Stash Module */
            <motion.div
              key="shelf-module"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.18 }}
              className="h-full pt-1 pl-5 pr-2"
            >
              <Shelf
                accentColor={settings.accentColor}
                fontSizeScale={settings.fontSizeScale}
              />
            </motion.div>
          ) : (
            /* Performance Monitor Module */
            <motion.div
              key="perf-module"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.18 }}
              className="h-full pt-1 pl-5 pr-3 pb-3.5"
            >
              <PerformanceHUD
                isActive={expanded && activeModule === "perf"}
                accentColor={settings.accentColor}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Audio Quick Switcher Popover Overlay */}
      <AnimatePresence>
        {showAudioSwitcher && (
          <AudioSwitcher
            accentColor={settings.accentColor}
            fontSizeScale={settings.fontSizeScale}
            onClose={() => setShowAudioSwitcher(false)}
            onStatusChange={setAudioStatus}
          />
        )}
      </AnimatePresence>
    </motion.div>
  )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
