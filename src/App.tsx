import { useEffect, useState, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
} from "lucide-react";
import "./App.css";

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
  const [expanded, setExpanded] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);
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
  const isTransitioningRef = useRef(false);
  const notchRef = useRef<HTMLDivElement | null>(null);
  const lyricsContainerRef = useRef<HTMLDivElement | null>(null);

  // Load responsive dimensions from Rust based on active monitor
  useEffect(() => {
    invoke<NotchDimensions>("get_notch_config")
      .then((cfg) => {
        if (cfg) setDims(cfg);
      })
      .catch((err) => console.error("Failed to load dimensions:", err));
  }, []);

  // Synchronize native window dimensions dynamically with margin buffer
  const updateNativeWindow = async (
    isExp: boolean,
    lyricsMode: boolean,
    customWidth?: number
  ) => {
    const width = isExp
      ? dims.expanded_width + 16
      : (customWidth ?? dynamicCollapsedWidth) + 16;
    const height = isExp
      ? lyricsMode
        ? dims.lyrics_height + 12
        : dims.expanded_height + 12
      : dims.collapsed_height;
    try {
      await invoke("set_notch_size", {
        width: Math.ceil(width),
        height: Math.ceil(height),
      });
    } catch {}
  };

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
  };

  const scheduleCollapse = (delay = 250) => {
    cancelCollapse();
    collapseTimerRef.current = window.setTimeout(() => {
      isTransitioningRef.current = true;
      setExpanded(false);
    }, delay);
  };

  const handleMouseEnter = () => {
    cancelCollapse();
    if (!expanded) {
      isTransitioningRef.current = true;
      updateNativeWindow(true, showLyrics);
      setExpanded(true);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isInsideNotch(e.clientX, e.clientY)) {
      cancelCollapse();
    } else if (expanded) {
      scheduleCollapse(200);
    }
  };

  const handleMouseLeave = (e: React.MouseEvent) => {
    if (isInsideNotch(e.clientX, e.clientY)) {
      return;
    }
    if (expanded) {
      scheduleCollapse(250);
    }
  };

  const handleManualCollapse = () => {
    cancelCollapse();
    isTransitioningRef.current = true;
    setExpanded(false);
  };

  // Ensure notch collapses when cursor leaves the native window entirely
  useEffect(() => {
    const handleWindowLeave = () => {
      if (expanded) {
        scheduleCollapse(200);
      }
    };
    document.addEventListener("mouseleave", handleWindowLeave);
    window.addEventListener("blur", handleWindowLeave);
    return () => {
      document.removeEventListener("mouseleave", handleWindowLeave);
      window.removeEventListener("blur", handleWindowLeave);
    };
  }, [expanded]);

  // Toggle lyrics view
  const toggleLyricsMode = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const nextState = !showLyrics;
    setShowLyrics(nextState);
    if (expanded) {
      await updateNativeWindow(true, nextState);
    }
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

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
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
    // Add 0.3s lead time to anticipate vocal onset
    const syncPos = playbackPos + 0.3;
    for (let i = lyrics.length - 1; i >= 0; i--) {
      if (syncPos >= lyrics[i].time) {
        return i;
      }
    }
    return 0;
  }, [lyrics, playbackPos]);

  const currentLyricText = useMemo(() => {
    if (lyrics.length > 0 && activeLyricIndex >= 0) {
      return lyrics[activeLyricIndex]?.text || "";
    }
    return "";
  }, [lyrics, activeLyricIndex]);

  // Dynamic width when collapsed based on lyric length
  const dynamicCollapsedWidth = useMemo(() => {
    if (showLyrics && currentLyricText) {
      const charWidth = 8.5;
      const basePadding = 115; // equalizer + clock + internal padding
      const calculated = currentLyricText.length * charWidth + basePadding;
      return Math.min(
        dims.expanded_width * 1.35,
        Math.max(dims.collapsed_width, calculated)
      );
    }
    return dims.collapsed_width;
  }, [showLyrics, currentLyricText, dims.collapsed_width, dims.expanded_width]);

  // Keep native window size synced with dynamic collapsed lyric width only when stably collapsed
  useEffect(() => {
    if (!expanded && !isTransitioningRef.current) {
      updateNativeWindow(false, showLyrics, dynamicCollapsedWidth);
    }
  }, [dynamicCollapsedWidth, showLyrics]);

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
    ? showLyrics
      ? dims.lyrics_height
      : dims.expanded_height
    : dims.collapsed_height;

  return (
    <div
      className="w-full h-full flex flex-col items-center justify-start select-none overflow-hidden"
      onMouseMove={(e) => {
        if (expanded && !isInsideNotch(e.clientX, e.clientY)) {
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
          borderRadius: expanded ? "0px 0px 24px 24px" : "0px 0px 18px 18px",
        }}
        transition={
          expanded
            ? {
                type: "spring",
                stiffness: 300,
                damping: 26,
                mass: 0.8,
              }
            : {
                type: "spring",
                stiffness: 340,
                damping: 36,
                mass: 0.8,
              }
        }
        onAnimationComplete={() => {
          isTransitioningRef.current = false;
          if (!expanded) {
            updateNativeWindow(false, showLyrics, dynamicCollapsedWidth);
          }
        }}
        onMouseEnter={handleMouseEnter}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={() => {
          if (!expanded) handleMouseEnter();
        }}
        className="relative bg-black/95 text-white border border-white/10 border-t-0 shadow-[0_16px_40px_rgba(0,0,0,0.9)] backdrop-blur-2xl cursor-pointer flex flex-col overflow-hidden mx-auto"
      >
        <AnimatePresence initial={false}>
          {!expanded ? (
            /* Collapsed View */
            <motion.div
              key="collapsed"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, pointerEvents: "none" }}
              transition={{ duration: 0.16 }}
              className="absolute inset-0 flex items-center justify-between px-3.5 py-1.5"
            >
              <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0 mr-2">
                {media.has_media && media.is_playing ? (
                  <div className="flex items-end gap-[2px] h-3.5 shrink-0 px-0.5">
                    <motion.span
                      animate={{ height: ["4px", "12px", "6px", "14px", "4px"] }}
                      transition={{ repeat: Infinity, duration: 1.2, ease: "easeInOut" }}
                      className="w-[2.5px] bg-emerald-400 rounded-full"
                    />
                    <motion.span
                      animate={{ height: ["8px", "4px", "14px", "6px", "8px"] }}
                      transition={{ repeat: Infinity, duration: 1.0, ease: "easeInOut", delay: 0.15 }}
                      className="w-[2.5px] bg-emerald-400 rounded-full"
                    />
                    <motion.span
                      animate={{ height: ["12px", "6px", "4px", "14px", "12px"] }}
                      transition={{ repeat: Infinity, duration: 1.1, ease: "easeInOut", delay: 0.3 }}
                      className="w-[2.5px] bg-emerald-400 rounded-full"
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
                      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                      exit={{ opacity: 0, y: -10, filter: "blur(4px)" }}
                      transition={{
                        type: "spring",
                        stiffness: 380,
                        damping: 28,
                        opacity: { duration: 0.2 },
                      }}
                      className="text-xs font-medium text-emerald-300 truncate select-none block"
                    >
                      {currentLyricText}
                    </motion.span>
                  </AnimatePresence>
                ) : (
                  <span className="text-xs font-medium text-neutral-200 truncate select-none">
                    {media.has_media ? media.title : "Notch"}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5 text-neutral-400 shrink-0">
                <Clock className="w-3 h-3 text-neutral-500" />
                <span className="text-[11px] font-mono text-neutral-300">
                  {time}
                </span>
              </div>
            </motion.div>
          ) : (
            /* Expanded View */
            <motion.div
              key="expanded"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, pointerEvents: "none" }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 flex flex-col justify-between p-4 pb-5 overflow-hidden"
            >
              {/* Header Bar */}
              <div className="flex items-center justify-between pb-2 border-b border-white/5">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)]" />
                  <span className="text-[11px] font-mono tracking-wider text-neutral-400 uppercase">
                    {showLyrics ? "Synchronized Lyrics" : "Media Active"}
                  </span>
                </div>

                <div className="flex items-center gap-1">
                  {/* Lyrics Toggle Button */}
                  {media.has_media && (
                    <button
                      onClick={toggleLyricsMode}
                      title="Toggle Lyrics"
                      className={`p-1.5 rounded-lg transition-colors ${
                        showLyrics
                          ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                          : "text-neutral-400 hover:text-white hover:bg-white/10"
                      }`}
                    >
                      <Mic2 className="w-3.5 h-3.5" />
                    </button>
                  )}

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

              {/* Middle Section: Player OR Lyrics */}
              {!showLyrics ? (
                <>
                  <div className="flex items-center gap-3.5 py-1.5">
                    <div className="w-12 h-12 rounded-xl bg-neutral-900 border border-white/10 flex items-center justify-center shrink-0 overflow-hidden shadow-inner">
                      {media.has_media ? (
                        <Music2 className="w-6 h-6 text-emerald-400" />
                      ) : (
                        <Sparkles className="w-5 h-5 text-neutral-500" />
                      )}
                    </div>

                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-sm font-semibold text-white truncate">
                        {media.has_media ? media.title : "No Active Media"}
                      </span>
                      <span className="text-xs text-neutral-400 truncate">
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
                          className="h-full bg-emerald-400 rounded-full transition-all duration-300"
                          style={{
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
              ) : (
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
                                ? "text-emerald-300 font-semibold text-sm scale-105 drop-shadow-[0_0_8px_rgba(52,211,153,0.4)]"
                                : "text-neutral-500 text-xs hover:text-neutral-300"
                            }`}
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
