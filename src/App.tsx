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
  Clock,
  Sparkles,
  ChevronUp,
  Mic2,
  ListMusic,
  Settings,
} from "lucide-react";
import {
  NotchSettings,
  loadSettings,
  saveSettings,
  hexToRgba,
} from "./settings";
import "./App.css";

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
  const [expandedView, setExpandedView] = useState<"player" | "lyrics" | "queue">("player");
  const [showLyrics] = useState(true);
  const [queue, setQueue] = useState<QueueTrack[]>([]);
  const [dims, setDims] = useState<NotchDimensions>({
    collapsed_width: 190,
    collapsed_height: 36,
    expanded_width: 440,
    expanded_height: 205,
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

  const [time, setTime] = useState("");
  const collapseTimerRef = useRef<number | null>(null);
  const collapseSafetyTimerRef = useRef<number | null>(null);
  const isTransitioningRef = useRef(false);
  const expandedRef = useRef(false);
  const notchRef = useRef<HTMLDivElement | null>(null);
  const lyricsContainerRef = useRef<HTMLDivElement | null>(null);
  const [isSmartCompact, setIsSmartCompact] = useState(false);

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

  // Zero-Resize Architecture: Notify Rust about current pill geometry for click-through hit-testing
  const updateGeometry = (
    isExp: boolean,
    customWidth?: number,
    customHeight?: number
  ) => {
    const activeWidth =
      customWidth ??
      (isExp
        ? dims.expanded_width
        : isCompact
        ? 114
        : dynamicCollapsedWidth);
    const activeHeight =
      customHeight ??
      (isExp
        ? expandedView !== "player"
          ? dims.lyrics_height
          : dims.expanded_height
        : isCompact
        ? 22
        : dims.collapsed_height);
    invoke("update_notch_geometry", {
      isExpanded: isExp,
      width: Math.ceil(activeWidth),
      height: Math.ceil(activeHeight),
    }).catch(() => {});
  };

  // Immediate reposition when target monitor changes in settings
  useEffect(() => {
    invoke("set_notch_size", {
      width: 680,
      height: 350,
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
    isTransitioningRef.current = false;
    updateGeometry(false, isCompact ? 114 : dynamicCollapsedWidth, isCompact ? 22 : dims.collapsed_height);
  };

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

  const handleMouseEnter = () => {
    cancelCollapse();
    if (!expandedRef.current) {
      isTransitioningRef.current = true;
      expandedRef.current = true;
      updateGeometry(true);
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

  // Clock ticker
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTime(
        now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      );
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
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
      const basePadding = 125; // equalizer + clock + internal margins
      const calculated = currentLyricText.length * charWidth + basePadding;
      const maxWidth = Math.min(dims.expanded_width * 1.5, 640);
      return Math.min(
        maxWidth,
        Math.max(dims.collapsed_width, calculated)
      );
    }
    return dims.collapsed_width;
  }, [isCompact, showLyrics, currentLyricText, dims.collapsed_width, dims.expanded_width, settings.fontSizeScale]);

  // Track text overflow for continuous marquee if lyric exceeds max width
  const lyricOverflowInfo = useMemo(() => {
    if (!currentLyricText) return { isOverflowing: false, distance: 0 };
    const charWidth = 7.6 * (settings.fontSizeScale ?? 1.0);
    const estimatedTextWidth = currentLyricText.length * charWidth;
    const availableWidth = dynamicCollapsedWidth - 125;
    const distance = Math.max(0, estimatedTextWidth - availableWidth);
    return {
      isOverflowing: distance > 8,
      distance: Math.ceil(distance),
    };
  }, [currentLyricText, dynamicCollapsedWidth, settings.fontSizeScale]);

  // Update geometry whenever dynamicCollapsedWidth changes (not animating)
  useEffect(() => {
    if (!expandedRef.current && !isTransitioningRef.current) {
      updateGeometry(false, dynamicCollapsedWidth);
    }
  }, [dynamicCollapsedWidth]);

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

  const targetHeight = expanded
    ? expandedView !== "player"
      ? dims.lyrics_height
      : dims.expanded_height
    : isCompact
    ? 22
    : dims.collapsed_height;

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
        initial={false}
        animate={{
          width: expanded ? dims.expanded_width : dynamicCollapsedWidth,
          height: targetHeight,
          borderRadius: targetBorderRadius,
        }}
        transition={
          expanded
            ? {
                type: "spring",
                stiffness: 300,
                damping: settings.springBounciness ?? 26,
                mass: 0.8,
              }
            : {
                type: "spring",
                stiffness: 310,
                damping: (settings.springBounciness ?? 26) + 4,
                mass: 0.8,
              }
        }
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
        className={`relative ${
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
              {isCompact ? (
                /* Compact Pill Content */
                <div className="flex items-center justify-between w-full h-full select-none">
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
                  <span className="text-[10px] font-mono tracking-tight text-neutral-300">
                    {time}
                  </span>
                </div>
              ) : (
                /* Normal Collapsed View */
                <>
                  <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0 mr-2">
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
                  </div>

                  <div className="flex items-center gap-1.5 text-neutral-400 shrink-0">
                    <Clock className="w-3 h-3 text-neutral-500" />
                    <span
                      className="font-mono text-neutral-300"
                      style={{ fontSize: `${11 * settings.fontSizeScale}px` }}
                    >
                      {time}
                    </span>
                  </div>
                </>
              )}
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
                width: dims.expanded_width,
                height:
                  expandedView !== "player"
                    ? dims.lyrics_height
                    : dims.expanded_height,
              }}
              className="absolute top-0 left-1/2 -translate-x-1/2 flex flex-col justify-between p-4 pb-5 overflow-hidden"
            >
              {/* Header Bar */}
              <div className="flex items-center justify-between pb-2 border-b border-white/5">
                <div className="flex items-center gap-2">
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{
                      backgroundColor: settings.accentColor,
                      boxShadow: `0 0 8px ${settings.accentColor}b3`,
                    }}
                  />
                  <span className="text-[11px] font-mono tracking-wider text-neutral-400 uppercase">
                    {expandedView === "queue"
                      ? "Queue / Playlist"
                      : expandedView === "lyrics"
                      ? "Synchronized Lyrics"
                      : "Media Active"}
                  </span>
                </div>

                <div className="flex items-center gap-1">
                  {/* View Switcher: Player, Lyrics, Queue */}
                  {media.has_media && (
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
              <div className="flex items-center justify-center gap-5 pt-2 pb-1 border-t border-white/5">
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
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
