import { useEffect, useState, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { motion, AnimatePresence, MotionConfig } from "motion/react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Music2,
  Sparkles,
  ChevronUp,
  ChevronLeft,
  MoreHorizontal,
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
  Pin,
  X,
  Trash2,
  Bell,
  Smartphone,
  Laptop,
} from "lucide-react";
import { TodoList, TodoItem } from "./TodoList";
import { Shelf } from "./Shelf";
import { PerformanceHUD } from "./PerformanceHUD";
import { AudioSwitcher, AudioStatus } from "./AudioSwitcher";
import { NotificationCenter } from "./NotificationCenter";
import {
  Pomodoro,
  formatPomodoro,
  onPomodoroComplete,
  usePomodoro,
} from "./Pomodoro";
import { PrayerSchedule } from "./PrayerSchedule";
import { Coordinates, getNextPrayer } from "./prayer";
import AgentPanel from "./AgentPanel";
import {
  MODULES,
  MODULE_IDS,
  isModuleId,
  moduleDef,
  resolvePinned,
  type ModuleId,
} from "./modules";
import {
  NotchSettings,
  NotchNotification,
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
  source_app?: string;
}

interface SpotifyLyricsPayload {
  uri?: string;
  title?: string;
  artist?: string;
  synced?: boolean;
  lines?: LyricLine[];
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
  let offsetSec = 0;

  for (const line of lines) {
    const offsetMatch = line.match(/\[offset:\s*([+-]?\d+)\s*\]/i);
    if (offsetMatch) {
      offsetSec = parseInt(offsetMatch[1], 10) / 1000;
      break;
    }
  }

  const regex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\](.*)/;

  for (const line of lines) {
    const match = line.match(regex);
    if (match) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = match[3] ? parseFloat("0." + match[3]) : 0;
      const totalSec = Math.max(0, min * 60 + sec + ms + offsetSec);
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

let textMeasureCtx: CanvasRenderingContext2D | null = null;

function estimateTextWidth(
  text: string,
  scale: number = 1.0,
  fontWeight: number | string = 600
): number {
  if (!text) return 0;
  try {
    if (!textMeasureCtx && typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      textMeasureCtx = canvas.getContext("2d");
    }
    if (textMeasureCtx) {
      const fontSizePx = 12 * scale;
      textMeasureCtx.font = `${fontWeight} ${fontSizePx}px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      return Math.ceil(textMeasureCtx.measureText(text).width) + 6;
    }
  } catch {}

  let width = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/[ijlrtI!.,':; |()\-]/.test(ch)) {
      width += 4.8;
    } else if (/[wmWM@#%&]/.test(ch)) {
      width += 10.2;
    } else if (/[A-Z]/.test(ch)) {
      width += 8.4;
    } else {
      width += 7.4;
    }
  }
  return Math.ceil(width * scale) + 6;
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
  const lastAudioStatusRef = useRef<{ master_volume: number; is_muted: boolean } | null>(null);
  const lastKnownMuteRef = useRef<boolean | null>(null);
  const [expandedView, setExpandedView] = useState<"player" | "lyrics" | "queue">(() => {
    const saved = localStorage.getItem("notch_expanded_view");
    return saved === "lyrics" || saved === "queue" ? saved : "player";
  });
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
  const [lyricsSource, setLyricsSource] = useState<"spotify" | "lrclib" | "">("");
  const spotifyLyricsRef = useRef<{ key: string; lines: LyricLine[] } | null>(null);
  const lastFetchedTrackRef = useRef<string>("");

  type AppModule = ModuleId;

  const pinnedNav = useMemo(
    () => resolvePinned(settings.pinnedModules).map(moduleDef),
    [settings.pinnedModules]
  );
  const overflowNav = useMemo(
    () => MODULES.filter((m) => !pinnedNav.some((p) => p.id === m.id)),
    [pinnedNav]
  );

  const [activeModule, setActiveModule] = useState<AppModule>(() => {
    const saved = localStorage.getItem("notch_active_module");
    if (isModuleId(saved)) return saved;
    return "media";
  });
  const activeModuleRef = useRef<AppModule>(activeModule);
  useEffect(() => {
    activeModuleRef.current = activeModule;
  }, [activeModule]);

  // Clock ticker - clean standard HH:mm with tabular numerals
  const [time, setTime] = useState("");

  // Pomodoro live activity (state lives in Pomodoro.tsx so it survives module switches)
  const pomodoro = usePomodoro();
  const pomodoroLive = pomodoro.running;

  // Prayer times: coordinates from settings, refreshed minute-by-minute with time
  const prayerCoords: Coordinates = useMemo(
    () => ({
      latitude: settings.prayerLatitude ?? -6.2088,
      longitude: settings.prayerLongitude ?? 106.8456,
      timezone: settings.prayerTimezone ?? 7,
    }),
    [settings.prayerLatitude, settings.prayerLongitude, settings.prayerTimezone]
  );
  // Re-evaluated whenever the clock minute changes (from `time` state)
  const nextPrayer = useMemo(
    () => getNextPrayer(new Date(), prayerCoords),
    [time, prayerCoords]
  );

  // 10-minute warning before azan: fires once per prayer entry into the [1..10] minute window
  const lastWarnedPrayerRef = useRef<string>("");
  useEffect(() => {
    if (!(settings.prayerReminderEnabled ?? true)) return;
    const key = `${nextPrayer.name}-${nextPrayer.targetDate.getTime()}`;
    if (nextPrayer.isTenMinuteWarning && lastWarnedPrayerRef.current !== key) {
      lastWarnedPrayerRef.current = key;
      const notif: NotchNotification = {
        id: Date.now(),
        source: "laptop",
        app_name: "Jadwal Sholat",
        title: `10 Menit Menuju ${nextPrayer.label}`,
        body: `Waktu ${nextPrayer.label} pukul ${nextPrayer.time} (${nextPrayer.diffMinutes} menit lagi). Siap-siap ambil wudhu.`,
        timestamp_ms: Date.now(),
      };
      setNotifications((prev) => [notif, ...prev]);
      setUnreadNotifCount((n) => n + 1);
      setActiveToastNotif(notif);
      if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = window.setTimeout(() => {
        setActiveToastNotif(null);
        toastTimeoutRef.current = null;
      }, (settingsRef.current.notificationPopDuration ?? 4) * 1000);
    }
  }, [nextPrayer, settings.prayerReminderEnabled]);

  // Notifications State (Phone Link & Laptop)
  const [notifications, setNotifications] = useState<NotchNotification[]>([]);
  const [activeToastNotif, setActiveToastNotif] = useState<NotchNotification | null>(null);
  const [unreadNotifCount, setUnreadNotifCount] = useState<number>(0);
  const toastTimeoutRef = useRef<number | null>(null);

  // Notify when a pomodoro phase finishes, reusing the collapsed toast + notification center
  useEffect(
    () =>
      onPomodoroComplete((s) => {
        const wasFocus = s.phase === "focus";
        const notif: NotchNotification = {
          id: Date.now(),
          source: "laptop",
          app_name: "Pomodoro",
          title: wasFocus ? "Sesi fokus selesai" : "Istirahat selesai",
          body: wasFocus
            ? "Waktunya istirahat. Notch siap kalau kamu mulai lagi."
            : "Istirahat habis, ayo lanjut fokus.",
          timestamp_ms: Date.now(),
        };
        setNotifications((prev) => [notif, ...prev]);
        setUnreadNotifCount((n) => n + 1);
        setActiveToastNotif(notif);
        if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
        toastTimeoutRef.current = window.setTimeout(
          () => {
            setActiveToastNotif(null);
            toastTimeoutRef.current = null;
          },
          (settingsRef.current.notificationPopDuration ?? 4) * 1000
        );
      }),
    []
  );
  const isGameModeActiveRef = useRef<boolean>(false);
  const settingsRef = useRef<NotchSettings>(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const handleDismissNotification = (id: number) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    if (activeToastNotif?.id === id) {
      setActiveToastNotif(null);
    }
    invoke("dismiss_notification", { id }).catch(() => {});
  };

  const handleClearAllNotifications = () => {
    setNotifications([]);
    setUnreadNotifCount(0);
    setActiveToastNotif(null);
    invoke("clear_all_notifications").catch(() => {});
  };

  useEffect(() => {
    if (expanded && activeModule === "notifications") {
      setUnreadNotifCount(0);
      setActiveToastNotif(null);
      if (toastTimeoutRef.current) {
        window.clearTimeout(toastTimeoutRef.current);
        toastTimeoutRef.current = null;
      }
    }
  }, [expanded, activeModule]);

  useEffect(() => {
    invoke<NotchNotification[]>("get_recent_notifications")
      .then((list) => {
        if (Array.isArray(list)) {
          const s = settingsRef.current;
          const filtered = list.filter((n) => {
            if (!(s.notificationsEnabled ?? true)) return false;
            if (n.source === "phone" && !(s.phoneNotificationsEnabled ?? true)) return false;
            if (n.source === "laptop" && !(s.laptopNotificationsEnabled ?? true)) return false;
            return true;
          });
          setNotifications(filtered);
        }
      })
      .catch(() => {});

    const unlistenUpdated = listen<NotchNotification[]>(
      "notch-notifications-updated",
      (event) => {
        if (!Array.isArray(event.payload)) return;
        const s = settingsRef.current;
        const filtered = event.payload.filter((n) => {
          if (!(s.notificationsEnabled ?? true)) return false;
          if (n.source === "phone" && !(s.phoneNotificationsEnabled ?? true)) return false;
          if (n.source === "laptop" && !(s.laptopNotificationsEnabled ?? true)) return false;
          return true;
        });
        setNotifications(filtered);
      }
    );

    const unlistenReceived = listen<NotchNotification>(
      "notch-notification-received",
      (event) => {
        const notif = event.payload;
        if (!notif) return;
        const s = settingsRef.current;
        if (!(s.notificationsEnabled ?? true)) return;
        if (notif.source === "phone" && !(s.phoneNotificationsEnabled ?? true)) return;
        if (notif.source === "laptop" && !(s.laptopNotificationsEnabled ?? true)) return;

        setNotifications((prev) => {
          const next = [notif, ...prev.filter((item) => item.id !== notif.id)];
          return next.slice(0, 30);
        });

        if (!(expandedRef.current && activeModuleRef.current === "notifications")) {
          setUnreadNotifCount((c) => c + 1);
        }

        // Suppress dynamic island pop-up banner if in fullscreen game and DND is enabled
        if ((s.dndInGameMode ?? true) && isGameModeActiveRef.current) {
          return;
        }

        if (!expandedRef.current) {
          setActiveToastNotif(notif);
          if (toastTimeoutRef.current) {
            window.clearTimeout(toastTimeoutRef.current);
          }
          const durationMs = Math.round(
            Math.max(2.5, Math.min(7.0, s.notificationPopDuration ?? 4.0)) * 1000
          );
          toastTimeoutRef.current = window.setTimeout(() => {
            setActiveToastNotif(null);
            toastTimeoutRef.current = null;
          }, durationMs);
        }
      }
    );

    return () => {
      unlistenUpdated.then((f) => f());
      unlistenReceived.then((f) => f());
      if (toastTimeoutRef.current) {
        window.clearTimeout(toastTimeoutRef.current);
      }
    };
  }, []);

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

  useEffect(() => {
    localStorage.setItem("notch_expanded_view", expandedView);
  }, [expandedView]);

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
    let next: AppModule;
    if (target) {
      next = target;
    } else {
      const currentIndex = MODULE_IDS.indexOf(activeModule);
      next =
        direction === "prev"
          ? MODULE_IDS[(currentIndex - 1 + MODULE_IDS.length) % MODULE_IDS.length]
          : MODULE_IDS[(currentIndex + 1) % MODULE_IDS.length];
    }
    setActiveModule(next);
    // Write-through so the last visited page survives an immediate restart
    localStorage.setItem("notch_active_module", next);
  };

  const lastWheelTimeRef = useRef(0);
  const handleContainerWheel = (e: React.WheelEvent) => {
    // If notch is collapsed, scrolling vertically or horizontally cycles modules
    if (!expandedRef.current) {
      const now = Date.now();
      if (now - lastWheelTimeRef.current < 200) return;
      if (Math.abs(e.deltaX) > 10 || Math.abs(e.deltaY) > 10) {
        lastWheelTimeRef.current = now;
        if (e.deltaX > 0 || e.deltaY > 0) switchModule(undefined, "next");
        else switchModule(undefined, "prev");
      }
      return;
    }

    // When expanded:
    const target = e.target as HTMLElement;
    const isScrollable = target.closest(
      ".queue-scroll, .lyrics-scroll, .todo-list-scroll, .shelf-scroll, .notif-scroll, [data-scrollable='true']"
    ) as HTMLElement | null;

    // 1. If mouse is over any scrollable list (Queue, Lyrics, Todo list, Shelf):
    // Vertical scrolling is 100% reserved for smooth native scrolling; never switch module!
    if (isScrollable) {
      if (Math.abs(e.deltaX) > 28 && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 2) {
        const now = Date.now();
        if (now - lastWheelTimeRef.current < 260) return;
        lastWheelTimeRef.current = now;
        if (e.deltaX > 0) switchModule(undefined, "next");
        else switchModule(undefined, "prev");
      }
      return;
    }

    // 2. If mouse is over non-scrollable area (PerformanceHUD, navbar/header, background):
    const now = Date.now();
    if (now - lastWheelTimeRef.current < 240) return;

    if (Math.abs(e.deltaX) > 18) {
      lastWheelTimeRef.current = now;
      if (e.deltaX > 0) switchModule(undefined, "next");
      else switchModule(undefined, "prev");
    } else if (Math.abs(e.deltaY) > 18) {
      lastWheelTimeRef.current = now;
      if (e.deltaY > 0) switchModule(undefined, "next");
      else switchModule(undefined, "prev");
    }
  };

  const [battery, setBattery] = useState<BatteryInfo | null>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const collapseSafetyTimerRef = useRef<number | null>(null);
  const isTransitioningRef = useRef(false);
  const expandedRef = useRef(false);
  const notchRef = useRef<HTMLDivElement | null>(null);
  const lyricsContainerRef = useRef<HTMLDivElement | null>(null);
  const [isSmartCompact, setIsSmartCompact] = useState(false);
  const [gameModeActive, setGameModeActive] = useState(false);
  const [lyricsError, setLyricsError] = useState<string | null>(null);
  const [uiError, setUiError] = useState<string | null>(null);
  const [showQuickMenu, setShowQuickMenu] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(
    () => !localStorage.getItem("notch_onboarded_v1")
  );
  const hoverIntentRef = useRef<number | null>(null);
  const [isPinned, setIsPinned] = useState(false);
  const [isRetracted, setIsRetracted] = useState(false);
  const isRetractingRef = useRef(false);
  const [availableMonitors, setAvailableMonitors] = useState<{
    id: string;
    label: string;
    is_primary: boolean;
    width: number;
    height: number;
    scale_factor: number;
  }[]>([]);

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

  const transitionToMonitor = async (targetMonId: string) => {
    isRetractingRef.current = true;
    cancelCollapse();

    // 1. Collapse and retract completely into the top bezel of the current monitor
    setIsPinned(false);
    expandedRef.current = false;
    setExpanded(false);
    setShowAudioSwitcher(false);
    setIsRetracted(true);

    // Wait 170ms so the 140ms retract + fold animation finishes 100% on the current monitor
    await new Promise((r) => setTimeout(r, 170));

    // 2. Move the native OS window and update responsive dimensions while 100% invisible
    try {
      await invoke("set_notch_size", {
        width: 760,
        height: 400,
        targetMonitor: targetMonId,
      });
      const cfg = await invoke<NotchDimensions>("get_notch_config", {
        targetMonitor: targetMonId,
      });
      if (cfg) setDims(cfg);
    } catch {}

    // 3. Wait 90ms for Windows DWM, DPI ScaleFactorChanged, and WebView2 surface swap to settle
    await new Promise((r) => setTimeout(r, 90));

    // 4. Smoothly drop the notch down from the top bezel of the new monitor
    setIsRetracted(false);
    setTimeout(() => {
      isRetractingRef.current = false;
    }, 380);
  };

  const cycleMonitor = () => {
    if (availableMonitors.length < 2 || isRetractingRef.current) return;
    const currentId = settings.targetMonitor ?? "primary";
    const currentIdx = availableMonitors.findIndex((m) => m.id === currentId);
    const nextIdx = (currentIdx + 1) % availableMonitors.length;
    const nextMon = availableMonitors[nextIdx];
    if (nextMon) {
      const updated = { ...settings, targetMonitor: nextMon.id };
      setSettings(updated);
      saveSettings(updated);
      emit("notch-settings-update", updated).catch(() => {});
    }
  };

  const cycleAudioOutput = async () => {
    let currentStatus = audioStatus;
    if (!currentStatus || currentStatus.output_devices.length < 2) {
      try {
        currentStatus = await invoke<AudioStatus>("get_audio_status");
        setAudioStatus(currentStatus);
      } catch {
        return;
      }
    }
    if (!currentStatus || currentStatus.output_devices.length < 2) return;
    const currentId = currentStatus.current_output_id;
    const currentIdx = currentStatus.output_devices.findIndex((d) => d.id === currentId);
    const nextIdx = (currentIdx + 1) % currentStatus.output_devices.length;
    const nextDev = currentStatus.output_devices[nextIdx];
    if (nextDev) {
      try {
        const updated = await invoke<AudioStatus>("set_default_audio_device", {
          deviceId: nextDev.id,
        });
        setAudioStatus(updated);
      } catch (err) {
        console.error("Failed to cycle audio output:", err);
        setUiError("Gagal mengganti output audio");
      }
    }
  };

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  const isCompact = !expanded && (Boolean(settings.compactMode) || (Boolean(settings.smartTabAvoidance ?? true) && isSmartCompact));

  // Track monitor changes to trigger smooth 3-phase bezel retract -> move -> drop animation
  const prevMonitorRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const mon = settings.targetMonitor ?? "primary";
    if (prevMonitorRef.current === undefined) {
      prevMonitorRef.current = mon;
      invoke("set_notch_size", {
        width: 760,
        height: 400,
        targetMonitor: mon,
      }).catch(() => {});
      invoke<NotchDimensions>("get_notch_config", {
        targetMonitor: mon,
      })
        .then((cfg) => {
          if (cfg) setDims(cfg);
        })
        .catch((err) => console.error("Failed to load dimensions:", err));
      return;
    }

    if (prevMonitorRef.current !== mon) {
      prevMonitorRef.current = mon;
      transitionToMonitor(mon);
    }
  }, [settings.targetMonitor]);

  // Listen to game mode shifts & backend repositioning for smooth bezel-drop animation
  useEffect(() => {
    const handleBeforeShift = () => {
      isRetractingRef.current = true;
      cancelCollapse();
      setIsPinned(false);
      expandedRef.current = false;
      setExpanded(false);
      setShowAudioSwitcher(false);
      setIsRetracted(true);
    };

    const unlistenWillShift = listen("game-mode-will-shift", handleBeforeShift);
    const unlistenWillRestore = listen("game-mode-will-restore", handleBeforeShift);

    const unlistenStatus = listen<{ active: boolean; shifted_to?: string | null }>("game-mode-status", (event) => {
      isGameModeActiveRef.current = Boolean(event.payload.active);
      setGameModeActive(Boolean(event.payload.active));
      if (event.payload.shifted_to || !event.payload.active) {
        setTimeout(() => {
          setIsRetracted(false);
          setTimeout(() => {
            isRetractingRef.current = false;
          }, 380);
        }, 90);
      }
    });

    return () => {
      unlistenWillShift.then((fn) => fn());
      unlistenWillRestore.then((fn) => fn());
      unlistenStatus.then((fn) => fn());
    };
  }, []);

  // Listen to smart avoidance updates from Rust detector
  useEffect(() => {
    const unlistenPromise = listen<{ compact: boolean }>("smart-avoidance-status", (event) => {
      setIsSmartCompact(event.payload.compact);
    });
    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  // Wheel redirect dari hook Rust: scroll element di bawah kursor manual
  // (hook menelan wheel OS agar window di belakang notch tidak ikut scroll)
  useEffect(() => {
    const p = listen<{ x: number; y: number; dy: number }>("notch-wheel", (event) => {
      const { x, y, dy } = event.payload;
      let target: HTMLElement | null = document.elementFromPoint(x, y) as HTMLElement | null;
      while (target && target !== document.body) {
        const ov = getComputedStyle(target).overflowY;
        if ((ov === "auto" || ov === "scroll") && target.scrollHeight > target.clientHeight) break;
        target = target.parentElement;
      }
      if (target && target !== document.body) {
        target.scrollTop += dy;
      }
    });
    return () => {
      p.then((fn) => fn());
    };
  }, []);

  // Global shortcut (Ctrl+Alt+N) registered in Rust
  useEffect(() => {
    const p = listen("toggle-notch-shortcut", () => {
      if (expandedRef.current) {
        handleManualCollapse();
      } else {
        cancelCollapse();
        isTransitioningRef.current = true;
        expandedRef.current = true;
        setExpanded(true);
      }
    });
    return () => {
      p.then((fn) => fn());
    };
  }, []);

  // Auto-dismiss transient UI error banner
  useEffect(() => {
    if (!uiError) return;
    const t = window.setTimeout(() => setUiError(null), 4500);
    return () => window.clearTimeout(t);
  }, [uiError]);

  // Update geometry when compact state toggles while collapsed
  useEffect(() => {
    if (!expandedRef.current && !isTransitioningRef.current) {
      updateGeometry(false, isCompact ? 114 : dynamicCollapsedWidth, isCompact ? 22 : dims.collapsed_height);
    }
  }, [isCompact]);

  // Pause auto-collapse while a popup menu is open or a text field inside the notch has focus —
  // menus overflow the notch rect (triggering mouseleave) and typing must never shrink the panel.
  const interactiveRef = useRef(false);
  const quickMenuOpenRef = useRef(false);
  const audioSwitcherOpenRef = useRef(false);
  const recomputeInteractive = () => {
    const el = document.activeElement;
    const typing =
      !!el &&
      (el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        (el as HTMLElement).isContentEditable === true);
    interactiveRef.current = typing || quickMenuOpenRef.current || audioSwitcherOpenRef.current;
  };
  useEffect(() => {
    const onFocusOut = () => window.setTimeout(recomputeInteractive, 0);
    document.addEventListener("focusin", recomputeInteractive);
    document.addEventListener("focusout", onFocusOut, true);
    return () => {
      document.removeEventListener("focusin", recomputeInteractive);
      document.removeEventListener("focusout", onFocusOut, true);
    };
  }, []);
  useEffect(() => {
    quickMenuOpenRef.current = showQuickMenu;
    audioSwitcherOpenRef.current = showAudioSwitcher;
    recomputeInteractive();
    // Menu baru saja dibuka: batalkan timer collapse yang mungkin sudah terjadwal
    // (cursor keluar rect notch saat menu melewati batas → mouseleave menjadwalkan collapse)
    if (showQuickMenu || showAudioSwitcher) {
      if (collapseTimerRef.current) {
        window.clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
      // sinkronkan zona hit-test bila zona menu mengoverflow panel
      updateGeometry(expanded, targetWidth, targetHeight);
    }
  }, [showQuickMenu, showAudioSwitcher]);

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
    // NOTE: never clears hoverIntentRef — pointer movement inside the pill calls this on every
    // mousemove, and clearing the intent timer there made hover-to-expand effectively dead.
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
    invoke("trim_memory").catch(() => {});
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
      lastAudioStatusRef.current = {
        master_volume: event.payload.volume,
        is_muted: event.payload.is_muted,
      };
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
          output_devices: prev.output_devices.map((d) => ({
            ...d,
            is_default: d.id === event.payload.output_id,
          })),
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

  // Hardware volume keys: the Rust hook swallows them to hide the Windows OSD
  // and re-emits them here; we apply the step ourselves via set_master_volume.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let raf = 0;
    let pendingVol: number | null = null;

    const flush = () => {
      raf = 0;
      if (pendingVol === null) return;
      const vol = Math.max(0, Math.min(1, pendingVol));
      pendingVol = null;
      invoke("set_master_volume", { level: vol }).catch(() => {});
    };

    listen<"up" | "down" | "mute">("volume-key", (event) => {
      const info = lastAudioStatusRef.current;
      if (event.payload === "mute") {
        invoke("set_master_mute", { mute: !(info?.is_muted ?? false) }).catch(() => {});
      } else {
        const step = 0.02;
        const base = info?.master_volume ?? 0.5;
        pendingVol = base + (event.payload === "up" ? step : -step);
        if (!raf) raf = window.setTimeout(flush, 16); // coalesce key-repeat bursts
      }

      // Show the notch volume HUD (same UX as the inline slider)
      if (!expandedRef.current) {
        setShowVolumeHud(true);
        if (volumeHudTimeoutRef.current) {
          window.clearTimeout(volumeHudTimeoutRef.current);
        }
        volumeHudTimeoutRef.current = window.setTimeout(() => {
          setShowVolumeHud(false);
        }, 1500);
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) unlisten();
      if (raf) window.clearTimeout(raf);
      if (volumeHudTimeoutRef.current) {
        window.clearTimeout(volumeHudTimeoutRef.current);
      }
    };
  }, []);

  const scheduleCollapse = (delay = 140) => {
    if (isPinned) return;
    // Jangan auto-collapse saat ada menu popup terbuka atau user sedang fokus mengetik
    // di input dalam notch (dropdown "..." melewati batas rect notch, TodoList input)
    if (interactiveRef.current) return;
    if (collapseTimerRef.current) return;
    collapseTimerRef.current = window.setTimeout(() => {
      collapseTimerRef.current = null;
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
        // Hover-only mode: LMB down over the pill must not expand (real file drags still go
        // through the DOM dragenter/dragover handlers on the pill)
        if (settingsRef.current.expandTrigger === "hover") return;
        cancelCollapse();
        if (!expandedRef.current) {
          isTransitioningRef.current = true;
          expandedRef.current = true;
          setExpanded(true);
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

  // Expansion trigger: hover-only, click-only, or both (default). Click-only mode keeps the notch
  // open until it is clicked again, so no pointer-leave auto-collapse.
  const expandTrigger = settings.expandTrigger ?? "hover";
  const hoverExpands = expandTrigger !== "click";
  const clickExpands = expandTrigger === "click";
  const autoCollapses = expandTrigger !== "click";

  // Timestamp of the last expand. Rust emits notch-drag-hover-pill on mouse-DOWN over the pill, so in
  // click mode the pulse can expand on mousedown and the following DOM click would close it again.
  const expandedAtRef = useRef(0);
  useEffect(() => {
    if (expanded) expandedAtRef.current = Date.now();
  }, [expanded]);

  const handleMouseEnter = () => {
    if (!hoverExpands) return;
    if (isRetractingRef.current || isGameModeActiveRef.current) return;
    cancelCollapse();
    if (expandedRef.current) return;
    // If a collapsed Dynamic Island notification toast is active, pause its auto-hide timer on hover
    // so the user can read it or click [X] without forcing full expansion; clicking the toast expands it.
    if (activeToastNotif) {
      if (toastTimeoutRef.current) {
        window.clearTimeout(toastTimeoutRef.current);
        toastTimeoutRef.current = null;
      }
      return;
    }
    // Hover intent: only expand if the pointer actually rests on the pill for a moment
    if (hoverIntentRef.current) window.clearTimeout(hoverIntentRef.current);
    hoverIntentRef.current = window.setTimeout(() => {
      hoverIntentRef.current = null;
      if (expandedRef.current || isRetractingRef.current || isGameModeActiveRef.current) return;
      isTransitioningRef.current = true;
      expandedRef.current = true;
      setExpanded(true);
    }, 160);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isRetractingRef.current) return;
    if (isInsideNotch(e.clientX, e.clientY)) {
      cancelCollapse();
    } else if (autoCollapses && expandedRef.current && !isPinned && !collapseTimerRef.current) {
      scheduleCollapse(140);
    }
  };

  const handleMouseLeave = (e: React.MouseEvent) => {
    if (isInsideNotch(e.clientX, e.clientY)) {
      return;
    }
    if (hoverIntentRef.current) {
      window.clearTimeout(hoverIntentRef.current);
      hoverIntentRef.current = null;
    }
    if (!expandedRef.current && activeToastNotif) {
      if (toastTimeoutRef.current) {
        window.clearTimeout(toastTimeoutRef.current);
      }
      toastTimeoutRef.current = window.setTimeout(() => {
        setActiveToastNotif(null);
        toastTimeoutRef.current = null;
      }, 1800);
      return;
    }
    if (autoCollapses && expandedRef.current && !isPinned) {
      cancelCollapse();
      scheduleCollapse(140);
    }
  };

  const handleManualCollapse = () => {
    cancelCollapse();
    if (hoverIntentRef.current) {
      window.clearTimeout(hoverIntentRef.current);
      hoverIntentRef.current = null;
    }
    setIsPinned(false);
    isTransitioningRef.current = true;
    expandedRef.current = false;
    setExpanded(false);
    collapseSafetyTimerRef.current = window.setTimeout(() => {
      finishCollapse();
    }, 1000);
  };

  // Rust collapses the notch when the settings window opens, so the always-on-top overlay never
  // covers the settings window (it used to swallow clicks over its transparent area)
  useEffect(() => {
    const p = listen("settings-opened", () => {
      if (expandedRef.current) handleManualCollapse();
    });
    return () => {
      p.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ensure notch collapses when cursor leaves the native window entirely
  useEffect(() => {
    const handleWindowLeave = () => {
      if (autoCollapses && expandedRef.current && !isPinned) {
        cancelCollapse();
        scheduleCollapse(80);
      }
    };
    document.addEventListener("mouseleave", handleWindowLeave);
    return () => {
      document.removeEventListener("mouseleave", handleWindowLeave);
    };
  }, [expanded, isPinned, autoCollapses]);

  // Switch between expanded views
  const switchView = (e: React.MouseEvent, view: "player" | "lyrics" | "queue") => {
    e.stopPropagation();
    setActiveModule("media");
    setExpandedView(view);
    localStorage.setItem("notch_active_module", "media");
    localStorage.setItem("notch_expanded_view", view);
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

  // Sync game mode & smart tab avoidance detector state
  useEffect(() => {
    invoke("set_game_mode", { enabled: settings.gameModeAutoShift ?? true }).catch(() => {});
  }, [settings.gameModeAutoShift]);

  useEffect(() => {
    invoke("set_smart_tab_avoidance", { enabled: settings.smartTabAvoidance ?? true }).catch(() => {});
  }, [settings.smartTabAvoidance]);

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

    const unlistenLyricsPromise = listen<SpotifyLyricsPayload>(
      "spotify-lyrics-update",
      (event) => {
        const payload = event.payload;
        if (!payload || !Array.isArray(payload.lines) || payload.lines.length === 0) return;
        const key = `${payload.title || ""}-${payload.artist || ""}`.toLowerCase();
        spotifyLyricsRef.current = { key, lines: payload.lines };

        setLyrics(payload.lines);
        setPlainLyrics("");
        setLyricsLoading(false);
        setLyricsSource("spotify");
      }
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
      unlistenQueuePromise.then((unlisten) => unlisten());
      unlistenLyricsPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Smooth position interpolation between 500ms sync ticks
  useEffect(() => {
    if (!media.is_playing) return;
    if (!expanded && !showLyrics) return;
    const intervalMs = expanded ? (expandedView === "player" || expandedView === "lyrics" ? 50 : 250) : 500;
    const stepSec = intervalMs / 1000;
    const interval = setInterval(() => {
      setPlaybackPos((prev) => {
        if (media.duration_sec > 0 && prev >= media.duration_sec) return prev;
        return prev + stepSec;
      });
    }, intervalMs);
    return () => clearInterval(interval);
  }, [media.is_playing, media.duration_sec, expanded, expandedView, showLyrics]);

  // Fetch lyrics from Spicetify bridge or LRCLIB when track changes
  useEffect(() => {
    if (!media.has_media || !media.title) {
      setLyrics([]);
      setPlainLyrics("");
      setLyricsSource("");
      return;
    }

    const trackKey = `${media.title}-${media.artist}`;
    if (lastFetchedTrackRef.current === trackKey) return;
    lastFetchedTrackRef.current = trackKey;

    const isSpotify = (media.source_app || "").toLowerCase().includes("spotify");
    const currentKey = `${media.title}-${media.artist}`.toLowerCase().trim();
    const isSpotifyCacheMatch = () => {
      const cached = spotifyLyricsRef.current;
      if (!cached || !cached.key || cached.key === "-") return false;
      return (
        currentKey === cached.key ||
        currentKey.includes(cached.key) ||
        cached.key.includes(currentKey)
      );
    };

    // Check if Spicetify already supplied lyrics for this exact track
    if (isSpotifyCacheMatch() && spotifyLyricsRef.current) {
      setLyrics(spotifyLyricsRef.current.lines);
      setPlainLyrics("");
      setLyricsLoading(false);
      setLyricsSource("spotify");
      return;
    }

    setLyricsLoading(true);

    // If Spotify is the player, give Spicetify bridge 500ms before falling back to LRCLIB
    const timeoutMs = isSpotify ? 500 : 0;
    const timer = setTimeout(() => {
      if (isSpotifyCacheMatch() && spotifyLyricsRef.current) {
        setLyrics(spotifyLyricsRef.current.lines);
        setPlainLyrics("");
        setLyricsLoading(false);
        setLyricsSource("spotify");
        return;
      }

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

      const durParam =
        media.duration_sec > 0 ? `&duration=${Math.round(media.duration_sec)}` : "";
      const albumParam = media.album
        ? `&album_name=${encodeURIComponent(media.album)}`
        : "";
      const fetchUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(
        cleanTitle
      )}&artist_name=${encodeURIComponent(cleanArtist)}${albumParam}${durParam}`;

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
              // Prefer entry with syncedLyrics matching track duration
              const synced = list.filter((item: any) => item.syncedLyrics);
              if (synced.length > 0 && media.duration_sec > 0) {
                synced.sort(
                  (a: any, b: any) =>
                    Math.abs(a.duration - media.duration_sec) -
                    Math.abs(b.duration - media.duration_sec)
                );
                return synced[0];
              }
              return synced[0] || list[0];
            }
          }
          return null;
        })
        .then((data) => {
          setLyricsLoading(false);
          setLyricsError(null);
          if (data) {
            if (data.syncedLyrics) {
              setLyrics(parseLrc(data.syncedLyrics));
              setLyricsSource("lrclib");
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
          setLyricsError("Gagal memuat lirik (jaringan / LRCLIB tidak merespons)");
        });
    }, timeoutMs);

    return () => clearTimeout(timer);
  }, [media.title, media.artist, media.has_media, media.source_app]);

  // Current active lyric line index with anticipatory lead
  const activeLyricIndex = useMemo(() => {
    if (lyrics.length === 0) return -1;
    // Add customizable lead time to anticipate vocal onset
    const lead = lyricsSource === "spotify" ? (settings.leadTime ?? 0.05) : (settings.leadTime ?? 0.3);
    const syncPos = playbackPos + lead;
    for (let i = lyrics.length - 1; i >= 0; i--) {
      if (syncPos >= lyrics[i].time) {
        return i;
      }
    }
    return 0;
  }, [lyrics, playbackPos, settings.leadTime, lyricsSource]);

  const currentLyricText = useMemo(() => {
    if (lyrics.length > 0 && activeLyricIndex >= 0) {
      return lyrics[activeLyricIndex]?.text || "";
    }
    return "";
  }, [lyrics, activeLyricIndex]);

  // Exact horizontal space reserved by non-lyric items in collapsed pill (waveform, padding, notif badge, battery, clock)
  const collapsedSideChromeWidth = useMemo(() => {
    let chrome = 126; // outer px-3.5 (28) + equalizer (18) + lyric px-2.5 (20) + clock (46) + safety (14)
    if (battery?.has_battery) {
      chrome += 58;
    }
    if (unreadNotifCount > 0) {
      chrome += 46;
    }
    if (pomodoroLive) {
      chrome += 58; // live pomodoro countdown chip + separator
    }
    if (nextPrayer.isTenMinuteWarning) {
      chrome += 80; // "Dzuhur 8m" live warning chip
    }
    return chrome;
  }, [battery?.has_battery, unreadNotifCount, pomodoroLive, nextPrayer.isTenMinuteWarning]);

  // Natural uncompacted width of the collapsed pill (used by Rust Smart Tab Avoidance to prevent oscillation)
  const naturalCollapsedWidth = useMemo(() => {
    if (showLyrics && currentLyricText && activeModule === "media") {
      const estimatedTextWidth = estimateTextWidth(
        currentLyricText,
        settings.fontSizeScale ?? 1.0,
        settings.fontWeight ?? 600
      );
      const calculated = estimatedTextWidth + collapsedSideChromeWidth;
      const maxWidth = Math.min(dims.expanded_width * 1.6, 680);
      return Math.min(
        maxWidth,
        Math.max(dims.collapsed_width, Math.ceil(calculated))
      );
    }
    return Math.max(dims.collapsed_width, collapsedSideChromeWidth + 40);
  }, [
    showLyrics,
    currentLyricText,
    activeModule,
    dims.collapsed_width,
    dims.expanded_width,
    settings.fontSizeScale,
    settings.fontWeight,
    collapsedSideChromeWidth,
  ]);

  // Dynamic width when collapsed based on lyric length with adaptive font scaling
  const dynamicCollapsedWidth = useMemo(() => {
    if (isCompact) {
      return 114;
    }
    return naturalCollapsedWidth;
  }, [isCompact, naturalCollapsedWidth]);

  // Track text overflow for continuous marquee if lyric exceeds max width
  const lyricOverflowInfo = useMemo(() => {
    if (!currentLyricText) return { isOverflowing: false, distance: 0 };
    const estimatedTextWidth = estimateTextWidth(
      currentLyricText,
      settings.fontSizeScale ?? 1.0,
      settings.fontWeight ?? 600
    );
    const availableWidth = Math.max(40, dynamicCollapsedWidth - collapsedSideChromeWidth);
    const rawOverflow = estimatedTextWidth - availableWidth;
    const isOverflowing = rawOverflow > 2;
    return {
      isOverflowing,
      distance: isOverflowing ? Math.ceil(rawOverflow + 12) : 0,
    };
  }, [
    currentLyricText,
    dynamicCollapsedWidth,
    settings.fontSizeScale,
    settings.fontWeight,
    collapsedSideChromeWidth,
  ]);

  const isNotifToastVisible = !expanded && activeToastNotif !== null;

  // Distinct width & height per view module: expanded widths and heights can differ freely
  const targetWidth = useMemo(() => {
    if (!expanded) {
      if (isNotifToastVisible) return Math.max(dynamicCollapsedWidth, 360);
      if (showVolumeHud) return 260;
      return isCompact ? 114 : dynamicCollapsedWidth;
    }
    if (showAudioSwitcher) return 480;
    if (activeModule === "todo" || activeModule === "shelf" || activeModule === "notifications") return 520;
    if (expandedView === "lyrics" || expandedView === "queue") return 480;
    if (activeModule === "perf") return 480;
    return 460;
  }, [expanded, isCompact, dynamicCollapsedWidth, isNotifToastVisible, showVolumeHud, showAudioSwitcher, activeModule, expandedView]);

  const targetHeight = useMemo(() => {
    if (!expanded) {
      if (isNotifToastVisible) return 58;
      if (showVolumeHud && isCompact) return 26;
      return isCompact ? 22 : dims.collapsed_height;
    }
    if (showAudioSwitcher) return 335;
    if (activeModule === "todo" || activeModule === "shelf" || activeModule === "notifications") return 290;
    if (activeModule === "pomodoro") return 245;
    if (activeModule === "prayer") return 255;
    if (activeModule === "agent") return 400;
    if (expandedView === "lyrics" || expandedView === "queue") return 320;
    if (activeModule === "perf") return 258;
    return dims.expanded_height || 232;
  }, [expanded, isCompact, dims.collapsed_height, dims.expanded_height, isNotifToastVisible, showVolumeHud, showAudioSwitcher, activeModule, expandedView]);

  // Zero-Resize Architecture: Notify Rust about current pill geometry for click-through hit-testing
  const updateGeometry = (
    isExp: boolean,
    customWidth?: number,
    customHeight?: number
  ) => {
    const activeWidth = customWidth ?? targetWidth;
    const activeHeight = customHeight ?? targetHeight;
    // Popup menu "..." mengoverflow (max-h 220px + offset): perluas zona klik hit-test ke bawah
    const menuOverflow = showQuickMenu ? 240 : 0;
    invoke("update_notch_geometry", {
      isExpanded: isExp,
      width: Math.ceil(activeWidth),
      height: Math.ceil(activeHeight),
      naturalWidth: Math.ceil(naturalCollapsedWidth),
      extraBottom: menuOverflow,
    }).catch(() => {});
  };

  // Keep hit-test bounding box strictly in sync whenever target dimensions change
  useEffect(() => {
    updateGeometry(expanded, targetWidth, targetHeight);
  }, [expanded, targetWidth, targetHeight, naturalCollapsedWidth]);

  // Update geometry whenever dynamicCollapsedWidth changes (not animating)
  useEffect(() => {
    if (!expandedRef.current && !isTransitioningRef.current && !showVolumeHud && !isNotifToastVisible) {
      updateGeometry(false, dynamicCollapsedWidth);
    }
  }, [dynamicCollapsedWidth, showVolumeHud, isNotifToastVisible]);

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
      setUiError("Gagal mengirim perintah putar/jeda ke pemutar media");
    }
  };

  const nextTrack = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await invoke("media_next_track");
    } catch (err) {
      console.error(err);
      setUiError("Gagal melewati trek (tidak ada pemutar yang merespons)");
    }
  };

  const prevTrack = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await invoke("media_prev_track");
    } catch (err) {
      console.error(err);
      setUiError("Gagal kembali ke trek sebelumnya (tidak ada pemutar yang merespons)");
    }
  };

  const handlePlayQueueTrack = async (uri: string) => {
    if (!uri) return;
    try {
      await invoke("spotify_queue_action", { action: "play", uri });
    } catch (err) {
      console.error("Failed to play queue track:", err);
    }
  };

  const handleRemoveQueueTrack = async (uri: string) => {
    if (!uri) return;
    try {
      setQueue((prev) => prev.filter((t) => t.uri !== uri));
      await invoke("spotify_queue_action", { action: "remove", uri });
    } catch (err) {
      console.error("Failed to remove queue track:", err);
    }
  };

  const handleClearQueue = async () => {
    try {
      setQueue([]);
      await invoke("spotify_queue_action", { action: "clear", uri: null });
    } catch (err) {
      console.error("Failed to clear queue:", err);
    }
  };

  const targetBorderRadius = isCompact
    ? "0px 0px 11px 11px"
    : `0px 0px ${settings.borderRadius}px ${settings.borderRadius}px`;

  return (
    <MotionConfig reducedMotion="user">
    <div
      className="w-full h-full flex flex-col items-center justify-start select-none overflow-hidden"
      onMouseMove={handleMouseMove}
    >
      <motion.div
        ref={notchRef}
        onWheel={handleContainerWheel}
        initial={false}
        animate={{
          width: targetWidth,
          height: targetHeight,
          borderRadius: targetBorderRadius,
          y: isRetracted ? -64 : 0,
          opacity: isRetracted ? 0 : 1,
          scale: isRetracted ? 0.92 : 1,
        }}
        transition={{
          width: isRetracted
            ? { duration: 0.14, ease: [0.4, 0, 1, 1] }
            : expanded
              ? { type: "spring", stiffness: 300, damping: settings.springBounciness ?? 26, mass: 0.8 }
              : { type: "spring", stiffness: 310, damping: (settings.springBounciness ?? 26) + 4, mass: 0.8 },
          height: isRetracted
            ? { duration: 0.14, ease: [0.4, 0, 1, 1] }
            : expanded
              ? { type: "spring", stiffness: 300, damping: settings.springBounciness ?? 26, mass: 0.8 }
              : { type: "spring", stiffness: 310, damping: (settings.springBounciness ?? 26) + 4, mass: 0.8 },
          borderRadius: isRetracted
            ? { duration: 0.14, ease: [0.4, 0, 1, 1] }
            : expanded
              ? { type: "spring", stiffness: 300, damping: settings.springBounciness ?? 26, mass: 0.8 }
              : { type: "spring", stiffness: 310, damping: (settings.springBounciness ?? 26) + 4, mass: 0.8 },
          y: isRetracted
            ? { duration: 0.14, ease: [0.4, 0, 1, 1] }
            : { type: "spring", stiffness: 300, damping: 24, mass: 0.75 },
          opacity: isRetracted
            ? { duration: 0.12, ease: "easeIn" }
            : { duration: 0.18, ease: "easeOut" },
          scale: isRetracted
            ? { duration: 0.14, ease: [0.4, 0, 1, 1] }
            : { type: "spring", stiffness: 300, damping: 24, mass: 0.75 },
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
        onClick={(e) => {
          // Ignore clicks on interactive controls so click-to-collapse never fires from a button
          if ((e.target as HTMLElement).closest("button, input, a, textarea, select")) return;

          if (!expanded) {
            if (activeToastNotif) {
              setActiveModule("notifications");
              setActiveToastNotif(null);
              if (toastTimeoutRef.current) {
                window.clearTimeout(toastTimeoutRef.current);
                toastTimeoutRef.current = null;
              }
            }
            if (!clickExpands) return;
            cancelCollapse();
            isTransitioningRef.current = true;
            expandedRef.current = true;
            setExpanded(true);
          } else if (!hoverExpands && Date.now() - expandedAtRef.current > 300) {
            // Click-only mode: pointer leave never collapses, so a body click closes it.
            // Guard: the mousedown-triggered expand must not be undone by the same press's click.
            handleManualCollapse();
          }
        }}
        className={`group relative ${
          expanded
            ? "shadow-[0_16px_36px_rgba(0,0,0,0.85)]"
            : "shadow-[0_2px_8px_rgba(0,0,0,0.4)]"
        } backdrop-blur-2xl cursor-pointer flex flex-col ${
          showQuickMenu ? "overflow-visible" : "overflow-hidden"
        } mx-auto transition-shadow duration-300`}
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
                isNotifToastVisible
                  ? "h-[58px] px-3.5 py-2"
                  : isCompact
                    ? "h-[22px] px-2.5 py-0.5"
                    : "h-[36px] px-3.5 py-1.5"
              }`}
            >
              <AnimatePresence mode="wait" initial={false}>
                {isNotifToastVisible && activeToastNotif ? (
                  /* Dynamic Island Notification Pop-up Toast (Collapsed Mode) */
                  <motion.div
                    key={`notif-toast-${activeToastNotif.id}`}
                    initial={{ opacity: 0, y: -8, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.96 }}
                    transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                    className="flex items-center justify-between w-full h-full gap-2.5 select-none"
                    title="Klik untuk membuka Notification Center"
                  >
                    {/* Source Icon */}
                    <div
                      className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 border border-white/10 relative"
                      style={{
                        backgroundColor:
                          activeToastNotif.source === "phone"
                            ? `${settings.accentColor}22`
                            : "rgba(56, 189, 248, 0.15)",
                      }}
                    >
                      {activeToastNotif.source === "phone" ? (
                        <Smartphone
                          className="w-4 h-4"
                          style={{ color: settings.accentColor }}
                        />
                      ) : (
                        <Laptop className="w-4 h-4 text-sky-400" />
                      )}
                      <span
                        className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full animate-ping"
                        style={{
                          backgroundColor:
                            activeToastNotif.source === "phone"
                              ? settings.accentColor
                              : "#38bdf8",
                        }}
                      />
                    </div>

                    {/* Sender & Message Preview */}
                    <div className="flex-1 min-w-0 flex flex-col justify-center">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className="text-[10.5px] font-mono uppercase tracking-wider px-1.5 py-0.2 rounded bg-white/10 font-semibold shrink-0"
                          style={{
                            color:
                              activeToastNotif.source === "phone"
                                ? settings.accentColor
                                : "#38bdf8",
                          }}
                        >
                          {activeToastNotif.source === "phone" ? "HP" : "PC"} •{" "}
                          {activeToastNotif.app_name}
                        </span>
                        <span
                          className="text-xs font-semibold text-white truncate"
                          style={{ fontSize: `${12 * settings.fontSizeScale}px` }}
                        >
                          {activeToastNotif.title}
                        </span>
                      </div>
                      <span
                        className="text-xs text-neutral-300 truncate mt-0.5"
                        style={{ fontSize: `${12 * settings.fontSizeScale}px` }}
                      >
                        {activeToastNotif.body || activeToastNotif.title}
                      </span>
                    </div>

                    {/* Quick Dismiss Button */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveToastNotif(null);
                        if (toastTimeoutRef.current) {
                          window.clearTimeout(toastTimeoutRef.current);
                          toastTimeoutRef.current = null;
                        }
                      }}
                      title="Tutup pop-up notifikasi"
                      className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-white/10 transition-colors shrink-0 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </motion.div>
                ) : showVolumeHud ? (
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

                    <span className="font-mono text-xs tabular-nums font-semibold text-neutral-300 w-8 text-right shrink-0">
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
                    {unreadNotifCount > 0 && (
                      <span
                        className="w-1.5 h-1.5 rounded-full animate-pulse"
                        style={{
                          backgroundColor: settings.accentColor,
                          boxShadow: `0 0 6px ${settings.accentColor}`,
                        }}
                        title={`${unreadNotifCount} notifikasi belum dibaca`}
                      />
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {battery && battery.has_battery && (
                      <div className="flex items-center gap-0.5">
                        {battery.is_charging && (
                          <Zap className="w-2 h-2 text-emerald-400 fill-emerald-400" />
                        )}
                        <span
                          className={`font-mono text-[10px] tabular-nums font-medium ${
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
                    <span className="text-[11px] font-mono font-semibold tracking-tight text-neutral-200 tabular-nums">
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
                  className="flex items-center justify-between w-full h-full gap-3"
                >
                  {activeModule === "media" ? (
                    <>
                      {/* Left: Equalizer / Audio Indicator */}
                      <div className="shrink-0 flex items-center">
                        {media.has_media && media.is_playing ? (
                          <div className="flex items-end gap-[2px] h-3.5 px-0.5">
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
                          <Music2 className="w-3.5 h-3.5 text-neutral-400" />
                        )}
                      </div>

                      {/* Center: Lyrics / Track Title (Centered) */}
                      <div
                        className={`flex-1 min-w-0 flex items-center ${
                          showLyrics && currentLyricText && lyricOverflowInfo.isOverflowing
                            ? "justify-start"
                            : "justify-center"
                        } overflow-hidden px-2 text-center`}
                      >
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
                              className="select-none inline-block whitespace-nowrap text-center"
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
                            className="truncate mask-fade-x select-none text-center"
                            style={{
                              color: settings.textColor,
                              fontWeight: Number(settings.fontWeight),
                              fontSize: `${12 * settings.fontSizeScale}px`,
                            }}
                          >
                            {media.has_media ? media.title : "Notch"}
                          </span>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0 mr-2">
                      {activeModule === "notifications" ? (
                        /* Notifications Collapsed Item */
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <Bell
                            className="w-3.5 h-3.5 shrink-0"
                            style={{ color: settings.accentColor }}
                          />
                          <span
                            className="truncate select-none font-medium"
                            style={{
                              color: notifications.length > 0 ? settings.textColor : "#9ca3af",
                              fontSize: `${12 * settings.fontSizeScale}px`,
                            }}
                          >
                            {notifications.length > 0
                              ? `${notifications[0].app_name}: ${notifications[0].title}`
                              : "Tidak ada notifikasi baru"}
                          </span>
                        </div>
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
                  )}

                  {/* Right Status: Sleek Battery + Modern Digital Clock */}
                  <div className="flex items-center gap-2 shrink-0 select-none">
                    {unreadNotifCount > 0 && (
                      <div
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-white/10"
                        style={{ backgroundColor: `${settings.accentColor}20` }}
                        title={`${unreadNotifCount} notifikasi baru`}
                      >
                        <Bell
                          className="w-2.5 h-2.5 animate-pulse"
                          style={{ color: settings.accentColor }}
                        />
                        <span
                          className="font-mono text-[10.5px] font-bold tabular-nums"
                          style={{ color: settings.accentColor }}
                        >
                          {unreadNotifCount}
                        </span>
                      </div>
                    )}
                    {battery && battery.has_battery && (
                      <div
                        className="flex items-center gap-1.5"
                        title={`Battery: ${battery.percent}%${battery.is_charging ? " (Plugged In / Charging)" : ""}`}
                      >
                        {battery.is_charging && (
                          <Zap className="w-2.5 h-2.5 text-emerald-400 fill-emerald-400 animate-pulse" />
                        )}
                        <span
                          className={`font-mono text-[11px] tabular-nums font-medium ${
                            battery.is_charging
                              ? "text-emerald-400"
                              : battery.percent <= 20
                              ? "text-rose-400 font-semibold"
                              : "text-neutral-300"
                          }`}
                          style={{ fontSize: `${11 * settings.fontSizeScale}px` }}
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

                    {pomodoroLive && (
                      <>
                        <span
                          className="font-mono font-semibold tabular-nums px-1.5 py-0.5 rounded shrink-0"
                          style={{
                            backgroundColor: `${settings.accentColor}22`,
                            color: settings.accentColor,
                            fontSize: `${10.5 * settings.fontSizeScale}px`,
                          }}
                          title={`Pomodoro berjalan — ${formatPomodoro(pomodoro.remaining)} tersisa`}
                        >
                          {formatPomodoro(pomodoro.remaining)}
                        </span>
                        <span className="w-0.5 h-0.5 rounded-full bg-neutral-600/80" />
                      </>
                    )}

                    {nextPrayer.isTenMinuteWarning && (
                      <>
                        <span
                          className="font-mono font-semibold tabular-nums px-1.5 py-0.5 rounded shrink-0 animate-pulse"
                          style={{
                            backgroundColor: "rgba(245, 158, 11, 0.2)",
                            color: "#fbbf24",
                            fontSize: `${10.5 * settings.fontSizeScale}px`,
                          }}
                          title={`Menjelang waktu sholat: ${nextPrayer.label} pukul ${nextPrayer.time}`}
                        >
                          {nextPrayer.label} {nextPrayer.diffMinutes}m
                        </span>
                        <span className="w-0.5 h-0.5 rounded-full bg-neutral-600/80" />
                      </>
                    )}

                    <span
                      className="font-mono text-xs font-semibold tracking-tight text-neutral-200 tabular-nums"
                      style={{ fontSize: `${12 * settings.fontSizeScale}px` }}
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
              className={`w-full h-full relative group/expanded flex flex-col justify-between p-4 pb-3 ${
                showQuickMenu ? "overflow-visible" : "overflow-hidden"
              }`}
            >
              {showOnboarding && (
                <div className="absolute inset-x-3 bottom-2 z-40 flex items-center gap-2 rounded-lg border border-white/15 bg-[#16171d]/95 px-2.5 py-2 shadow-xl">
                  <span className="flex-1 text-xs leading-snug text-neutral-300">
                    Scroll atau klik ikon untuk ganti modul &middot; Ctrl+Alt+N buka/tutup Notch
                  </span>
                  <button
                    type="button"
                    aria-label="Tutup tips"
                    onClick={() => {
                      localStorage.setItem("notch_onboarded_v1", "1");
                      setShowOnboarding(false);
                    }}
                    className="p-1 rounded text-neutral-400 hover:text-white hover:bg-white/10 cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
              {uiError && (
                <div
                  role="status"
                  className="absolute inset-x-3 bottom-2 z-50 flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-950/90 px-2.5 py-2 shadow-xl"
                >
                  <span className="flex-1 text-xs leading-snug text-rose-200">{uiError}</span>
                  <button
                    type="button"
                    aria-label="Tutup pesan error"
                    onClick={() => setUiError(null)}
                    className="p-1 rounded text-rose-300 hover:text-white hover:bg-white/10 cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
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
                className="relative flex items-center justify-between pb-2 border-b border-white/5"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{
                      backgroundColor: settings.accentColor,
                      boxShadow: `0 0 8px ${settings.accentColor}b3`,
                    }}
                  />
                  {gameModeActive && (
                    <span
                      title="Game Mode aktif: Notch dipindah / disembunyikan otomatis"
                      className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-[11px] font-mono text-emerald-300 border border-emerald-500/25"
                    >
                      GAME
                    </span>
                  )}
                  {isSmartCompact && (
                    <span
                      title="Tab browser terdeteksi di belakang Notch"
                      className="px-1.5 py-0.5 rounded bg-sky-500/15 text-[11px] font-mono text-sky-300 border border-sky-500/25"
                    >
                      TAB
                    </span>
                  )}
                  {activeModule === "notifications" && notifications.length > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-white/10 text-[11px] font-mono text-neutral-300">
                      {notifications.length} item
                    </span>
                  )}
                  {activeModule === "todo" && (
                    <span className="px-1.5 py-0.5 rounded bg-white/10 text-[11px] font-mono text-neutral-300">
                      {todos.filter((t) => t.completed).length}/{todos.length} done
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  {/* Module Navigation: centred, out of the action cluster */}
                  <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-0.5 px-1 py-0.5 bg-white/5 rounded-full border border-white/5">
                    {pinnedNav.map(({ id, label, icon: Icon }) => {
                      const isActive = activeModule === id;
                      const hasUnread = id === "notifications" && unreadNotifCount > 0;
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => switchModule(id)}
                          title={label}
                          aria-label={label}
                          aria-current={isActive ? "page" : undefined}
                          className={`relative p-1.5 rounded-full flex items-center justify-center transition-all cursor-pointer ${
                            isActive
                              ? "bg-white/15 text-white"
                              : hasUnread
                                ? "text-emerald-400 hover:bg-white/10"
                                : "text-neutral-400 hover:text-white hover:bg-white/10"
                          }`}
                        >
                          <Icon className="w-3 h-3" strokeWidth={2.3} />
                          {hasUnread && !isActive && (
                            <span
                              className="absolute top-0.5 right-0.5 w-1 h-1 rounded-full animate-pulse"
                              style={{ backgroundColor: settings.accentColor }}
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* View Switcher: Player, Lyrics, Queue (only in media module) */}
                  {activeModule === "media" && media.has_media && (
                    <div className="flex items-center bg-white/5 rounded-lg p-0.5 border border-white/5">
                      <button
                        onClick={(e) => switchView(e, "player")}
                        title="Player"
                        aria-label="Tampilan player"
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
                        aria-label="Tampilan lirik"
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
                        aria-label="Tampilan antrean"
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

                  {/* Overflow menu: audio, monitor, pin, settings */}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowQuickMenu((v) => !v);
                      }}
                      title="Menu lainnya"
                      aria-label="Menu lainnya"
                      aria-expanded={showQuickMenu}
                      className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                        showQuickMenu
                          ? "bg-white/20 text-white"
                          : "text-neutral-400 hover:text-white hover:bg-white/10"
                      }`}
                    >
                      <MoreHorizontal className="w-3.5 h-3.5" />
                    </button>

                    {showQuickMenu && (
                      <>
                        <div
                          className="fixed inset-0 z-40"
                          onClick={() => setShowQuickMenu(false)}
                        />
                        <div
                          role="menu"
                          onClick={(e) => e.stopPropagation()}
                          className="absolute right-0 top-full mt-1.5 z-50 w-52 max-h-[220px] overflow-y-auto rounded-xl border border-white/15 bg-[#18191e]/98 p-1 shadow-2xl backdrop-blur-xl"
                        >
                          {/* Modules that don't fit the header icon strip (max 5 pinned) */}
                          {overflowNav.length > 0 && (
                            <>
                              <div className="px-2 pt-1 pb-0.5 text-[10px] font-mono uppercase tracking-wider text-neutral-500">
                                Modul
                              </div>
                              {overflowNav.map((m) => (
                                <button
                                  key={m.id}
                                  type="button"
                                  role="menuitem"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setShowQuickMenu(false);
                                    switchModule(m.id);
                                  }}
                                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-[11px] text-neutral-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                                >
                                  <m.icon className="w-3.5 h-3.5 shrink-0" />
                                  <span className="truncate">{m.label}</span>
                                </button>
                              ))}
                              <div className="px-2 pt-1 pb-0.5 text-[10px] font-mono uppercase tracking-wider text-neutral-500">
                                Utilitas
                              </div>
                            </>
                          )}

                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setShowQuickMenu(false);
                              setShowAudioSwitcher(true);
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setShowQuickMenu(false);
                              cycleAudioOutput();
                            }}
                            title="Klik: perangkat audio · Klik-kanan: ganti output langsung"
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-[11px] text-neutral-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                          >
                            {audioStatus?.is_muted || audioStatus?.master_volume === 0 ? (
                              <VolumeX className="w-3.5 h-3.5 shrink-0 text-rose-400" />
                            ) : (
                              <Volume2 className="w-3.5 h-3.5 shrink-0" />
                            )}
                            <span className="truncate">
                              {audioStatus?.current_output_name || "Perangkat Audio"}
                            </span>
                          </button>

                          {availableMonitors.length > 1 && (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowQuickMenu(false);
                                cycleMonitor();
                              }}
                              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-[11px] text-neutral-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                            >
                              <Monitor className="w-3.5 h-3.5 shrink-0" />
                              <span className="truncate">Pindah Monitor</span>
                            </button>
                          )}

                          <button
                            type="button"
                            role="menuitem"
                            onClick={(e) => {
                              e.stopPropagation();
                              setShowQuickMenu(false);
                              setIsPinned((prev) => !prev);
                            }}
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-[11px] transition-colors cursor-pointer hover:bg-white/10"
                            style={{ color: isPinned ? settings.accentColor : "#d4d4d8" }}
                          >
                            <Pin className={`w-3.5 h-3.5 shrink-0 ${isPinned ? "rotate-45" : ""}`} />
                            <span className="truncate">
                              {isPinned ? "Lepas Pin" : "Pin Tetap Terbuka"}
                            </span>
                          </button>

                          <button
                            type="button"
                            role="menuitem"
                            onClick={(e) => {
                              setShowQuickMenu(false);
                              handleOpenSettings(e);
                            }}
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-[11px] text-neutral-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                          >
                            <Settings className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">Pengaturan</span>
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleManualCollapse();
                    }}
                    title="Tutup"
                    aria-label="Tutup Notch"
                    className="ml-1 text-neutral-400 hover:text-white p-1 rounded-full hover:bg-white/10 transition-colors"
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
                  className="absolute left-1.5 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded-full bg-neutral-900/90 hover:bg-white/20 text-neutral-400 hover:text-white border border-white/10 transition-all shadow-lg z-30 active:scale-90 cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
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
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded-full bg-neutral-900/90 hover:bg-white/20 text-neutral-400 hover:text-white border border-white/10 transition-all shadow-lg z-30 active:scale-90 cursor-pointer"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
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
                      className="h-full flex flex-col justify-between pl-3 pr-10"
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
                          className="flex items-center gap-1 mt-1 px-2 py-0.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/5 transition-all text-[11px] text-neutral-400 hover:text-neutral-200 w-fit max-w-[200px]"
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
                      <div className="flex justify-between text-[11px] font-mono text-neutral-400">
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
                      className="lyrics-scroll overflow-y-auto max-h-[140px] pr-1 scroll-smooth flex flex-col gap-2.5 no-scrollbar py-2"
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
                      className="lyrics-scroll overflow-y-auto max-h-[140px] pr-1 whitespace-pre-line text-xs text-neutral-300 text-center"
                      style={{ scrollbarWidth: "none" }}
                    >
                      {plainLyrics}
                    </div>
                  ) : (
                    <div className="text-xs text-neutral-500 text-center py-6 leading-relaxed">
                      {lyricsError ?? "Lirik tidak ditemukan untuk lagu ini"}
                    </div>
                  )}
                </div>
              ) : (
                /* Queue / Upcoming Tracks */
                <div className="my-1 flex-1 min-h-[140px] max-h-[150px] overflow-hidden flex flex-col">
                  <div className="flex items-center justify-between text-[11px] text-neutral-400 font-mono px-1 pb-1 border-b border-white/5">
                    <div className="flex items-center gap-2">
                      <span>UPCOMING PLAYLIST</span>
                      <span className="text-neutral-500 font-normal">
                        {queue.length > 0 ? `${queue.length} lagu` : "Menunggu Spotify..."}
                      </span>
                    </div>
                    {queue.length > 0 && (
                      <button
                        onClick={handleClearQueue}
                        title="Kosongkan antrean di Spotify"
                        className="flex items-center gap-1 text-[10px] text-neutral-500 hover:text-red-400 transition-colors p-0.5 rounded cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>Hapus Antrean</span>
                      </button>
                    )}
                  </div>
                  <div
                    className="queue-scroll flex-1 overflow-y-auto space-y-1 py-1.5 pr-0.5"
                    style={{ scrollbarWidth: "none" }}
                  >
                    {queue.length > 0 ? (
                      queue.map((track, idx) => (
                        <div
                          key={track.uri || idx}
                          onClick={() => handlePlayQueueTrack(track.uri)}
                          title={`Putar "${track.title}" sekarang`}
                          className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.08] transition-colors group cursor-pointer"
                        >
                          <div className="w-4 h-4 flex items-center justify-center shrink-0">
                            <span className="text-[11px] font-mono text-neutral-500 group-hover:hidden">
                              {idx + 1}
                            </span>
                            <Play className="w-3.5 h-3.5 fill-emerald-400 text-emerald-400 hidden group-hover:block shrink-0" />
                          </div>
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
                            <span className="text-[11px] text-neutral-400 truncate">
                              {track.artist}
                            </span>
                          </div>
                          {track.duration_ms > 0 && (
                            <span className="text-[11px] font-mono text-neutral-500 shrink-0 group-hover:hidden">
                              {formatMs(track.duration_ms)}
                            </span>
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemoveQueueTrack(track.uri);
                            }}
                            title="Hapus dari antrean Spotify"
                            className="hidden group-hover:flex items-center justify-center w-5 h-5 rounded hover:bg-red-500/20 text-neutral-400 hover:text-red-400 transition-colors cursor-pointer shrink-0"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
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
          ) : activeModule === "notifications" ? (
            /* Notification Center Module (Phone Link & Laptop) */
            <motion.div
              key="notifications-module"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.18 }}
              className="h-full pt-1 px-10"
            >
              <NotificationCenter
                notifications={notifications}
                onDismiss={handleDismissNotification}
                onClearAll={handleClearAllNotifications}
                accentColor={settings.accentColor}
                fontSizeScale={settings.fontSizeScale}
              />
            </motion.div>
          ) : activeModule === "todo" ? (
            /* To-Do List Module */
            <motion.div
              key="todo-module"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.18 }}
              className="h-full pt-1 px-10"
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
              className="h-full pt-1 px-10"
            >
              <Shelf
                accentColor={settings.accentColor}
                fontSizeScale={settings.fontSizeScale}
              />
            </motion.div>
          ) : activeModule === "pomodoro" ? (
            /* Pomodoro Module */
            <motion.div
              key="pomodoro-module"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.18 }}
              className="h-full pt-1 px-10"
            >
              <Pomodoro accentColor={settings.accentColor} />
            </motion.div>
          ) : activeModule === "prayer" ? (
            /* Prayer Schedule Module */
            <motion.div
              key="prayer-module"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.18 }}
              className="h-full pt-1 px-10"
            >
              <PrayerSchedule
                coords={prayerCoords}
                accentColor={settings.accentColor}
              />
            </motion.div>
          ) : activeModule === "agent" ? (
            /* AI Agent Module (standalone, 9Router) */
            <motion.div
              key="agent-module"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.18 }}
              className="h-full px-6 pt-1 pb-2"
            >
              <AgentPanel
                config={{
                  apiKey: settings.agentApiKey,
                  baseUrl: settings.agentBaseUrl,
                  model: settings.agentModel,
                  systemPrompt: settings.agentSystemPrompt,
                }}
                accentColor={settings.accentColor}
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
              className="h-full pt-1 px-10 pb-3.5"
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
    </MotionConfig>
  );
}
