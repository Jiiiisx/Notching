import { useState, useEffect } from "react";
import {
  Palette,
  Type,
  RotateCcw,
  Sparkles,
  CheckCircle2,
  Volume2,
  Monitor,
  RefreshCw,
  Gamepad2,
  Minimize2,
  AppWindow,
  MousePointer2,
  ChevronUp,
  ChevronDown,
  Power,
  Minus,
  X,
  HelpCircle,
  ShieldCheck,
  Music2,
  Radio,
  Cpu,
  Check,
  Bell,
  Smartphone,
  Laptop,
  Compass,
  Bot,
} from "lucide-react";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  NotchSettings,
  DEFAULT_NOTCH_SETTINGS,
  MonitorOption,
  loadSettings,
  saveSettings,
  hexToRgba,
} from "./settings";
import { CITY_PRESETS } from "./prayer";
import { MODULE_IDS, MAX_NAV_ICONS, moduleDef, resolvePinned } from "./modules";

const BG_PRESETS = [
  { name: "Pure Black", hex: "#000000" },
  { name: "Obsidian", hex: "#0a0a0a" },
  { name: "Midnight", hex: "#0b0f19" },
  { name: "Dark Slate", hex: "#111827" },
  { name: "Deep Violet", hex: "#140a24" },
];

const TEXT_PRESETS = [
  { name: "Pure White", hex: "#ffffff" },
  { name: "Soft Silver", hex: "#e2e8f0" },
  { name: "Warm Cream", hex: "#fef3c7" },
  { name: "Mint Frost", hex: "#a7f3d0" },
  { name: "Sky Ice", hex: "#bae6fd" },
];

const ACCENT_PRESETS = [
  { name: "Emerald", hex: "#10b981" },
  { name: "Electric Blue", hex: "#3b82f6" },
  { name: "Violet", hex: "#8b5cf6" },
  { name: "Amber Gold", hex: "#f59e0b" },
  { name: "Crimson Rose", hex: "#f43f5e" },
];

const FONT_WEIGHTS: Array<{
  label: string;
  sub: string;
  value: NotchSettings["fontWeight"];
}> = [
  { label: "Light", sub: "300", value: "300" },
  { label: "Regular", sub: "400", value: "400" },
  { label: "Medium", sub: "500", value: "500" },
  { label: "Semibold", sub: "600", value: "600" },
  { label: "Bold", sub: "700", value: "700" },
  { label: "ExtraBold", sub: "800", value: "800" },
];

type TabId =
  | "display"
  | "appearance"
  | "typography"
  | "motion"
  | "notifications"
  | "prayer"
  | "agent"
  | "integrations"
  | "system";

function cleanMonitorTitle(m: MonitorOption): string {
  if (m.id === "primary") return "Otomatis (Ikuti Layar Utama)";
  return m.label.replace(/\s*\(\d+x\d+.*?\)\s*$/, "").trim();
}

function InfoPopover({
  title,
  lines,
  align = "left",
}: {
  title: string;
  lines: string[];
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex items-center group/info">
      <button
        type="button"
        aria-label={`Info: ${title}`}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onBlur={() => setOpen(false)}
        className="w-4 h-4 rounded-full inline-flex items-center justify-center text-neutral-500 hover:text-neutral-200 hover:bg-white/10 focus-visible:text-neutral-200 focus-visible:bg-white/10 outline-none transition-colors cursor-help"
      >
        <HelpCircle className="w-3.5 h-3.5" />
      </button>
      <span
        role="tooltip"
        className={`${
          open ? "opacity-100 scale-100" : "pointer-events-none opacity-0 scale-95"
        } group-hover/info:opacity-100 group-hover/info:scale-100 group-focus-within/info:opacity-100 group-focus-within/info:scale-100 transition-all duration-150 ease-out origin-bottom absolute bottom-full mb-2 z-50 w-72 max-w-[calc(100vw-2rem)] p-3 rounded-xl bg-[#18191e] border border-white/15 shadow-2xl text-left ${
          align === "right" ? "right-0" : "left-0"
        }`}
      >
        <span className="block text-xs font-semibold text-white mb-1">
          {title}
        </span>
        <span className="block space-y-1">
          {lines.map((line, i) => (
            <span
              key={i}
              className="block text-xs text-neutral-300 leading-relaxed font-normal"
            >
              {line}
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}

function ToggleSwitch({
  checked,
  onChange,
  accentColor,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  accentColor: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onChange}
      style={{
        backgroundColor: checked ? accentColor : "rgba(255,255,255,0.09)",
      }}
      className="w-10 h-5.5 rounded-full relative p-0.5 transition-colors duration-150 ease-out cursor-pointer shrink-0 active:scale-95 disabled:opacity-50 border border-white/10"
    >
      <div
        className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out ${
          checked ? "translate-x-4.5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

export default function SettingsApp() {
  const [activeTab, setActiveTab] = useState<TabId>("display");
  const [settings, setSettings] = useState<NotchSettings>(loadSettings);
  const [monitors, setMonitors] = useState<MonitorOption[]>([]);
  const [isRefreshingMonitors, setIsRefreshingMonitors] = useState(false);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [isLoadingAutostart, setIsLoadingAutostart] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const fetchAutostart = async () => {
    try {
      const enabled = await invoke<boolean>("get_autostart_status");
      setAutostartEnabled(enabled);
    } catch (e) {
      console.error("Failed to fetch autostart status:", e);
    }
  };

  const toggleAutostart = async () => {
    setIsLoadingAutostart(true);
    try {
      const nextState = !autostartEnabled;
      await invoke("set_autostart_status", { enable: nextState });
      setAutostartEnabled(nextState);
    } catch (e) {
      console.error("Failed to toggle autostart:", e);
    } finally {
      setIsLoadingAutostart(false);
    }
  };

  const fetchMonitors = async () => {
    setIsRefreshingMonitors(true);
    try {
      const list = await invoke<MonitorOption[]>("get_available_monitors");
      if (list && list.length > 0) {
        setMonitors(list);
      }
    } catch (e) {
      console.error("Failed to load monitors:", e);
    } finally {
      setTimeout(() => setIsRefreshingMonitors(false), 260);
    }
  };

  const update = (patch: Partial<NotchSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      emit("notch-settings-update", next).catch(() => {});
      return next;
    });
  };

  const pinnedModules = resolvePinned(settings.pinnedModules);
  const unpinnedModules = MODULE_IDS.filter((id) => !pinnedModules.includes(id));

  const moveModule = (id: string, dir: -1 | 1) => {
    const next = [...pinnedModules];
    const from = next.indexOf(id as never);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= next.length) return;
    [next[from], next[to]] = [next[to], next[from]];
    update({ pinnedModules: next });
  };
  const unpinModule = (id: string) => {
    if (pinnedModules.length <= 1) return;
    update({ pinnedModules: pinnedModules.filter((m) => m !== id) });
  };
  const pinModule = (id: string) => {
    if (pinnedModules.length >= MAX_NAV_ICONS) return;
    update({ pinnedModules: [...pinnedModules, id] });
  };

  const handleReset = () => {
    if (!confirmReset) {
      setConfirmReset(true);
      setTimeout(() => setConfirmReset(false), 2500);
      return;
    }
    setSettings(DEFAULT_NOTCH_SETTINGS);
    saveSettings(DEFAULT_NOTCH_SETTINGS);
    emit("notch-settings-update", DEFAULT_NOTCH_SETTINGS).catch(() => {});
    setConfirmReset(false);
  };

  const handleTitlebarDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button, input, a, label")) return;
    invoke("drag_settings_window").catch(() => {});
  };

  const uiScale = settings.fontSizeScale ?? 1;

  useEffect(() => {
    fetchMonitors();
    fetchAutostart();
    emit("notch-settings-update", settings).catch(() => {});

    // Escape hatch: frameless window has no system close button chain if layout clips
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") invoke("close_settings_window").catch(() => {});
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navGroups: Array<{
    group: string;
    items: Array<{ id: TabId; label: string; icon: typeof Monitor }>;
  }> = [
    {
      group: "UTAMA",
      items: [
        { id: "display", label: "Layar & Perilaku", icon: Monitor },
        { id: "appearance", label: "Warna & Gaya", icon: Palette },
        { id: "typography", label: "Tipografi", icon: Type },
        { id: "motion", label: "Animasi & Lirik", icon: Sparkles },
      ],
    },
    {
      group: "SISTEM",
      items: [
        { id: "notifications", label: "Notifikasi HP & PC", icon: Bell },
        { id: "prayer", label: "Jadwal Sholat", icon: Compass },
        { id: "agent", label: "AI Agent", icon: Bot },
        { id: "integrations", label: "Integrasi Media", icon: Volume2 },
        { id: "system", label: "Startup & Sistem", icon: Power },
      ],
    },
  ];

  return (
    <div
      className="bg-[#0b0c0e] text-neutral-100 flex flex-col select-none font-sans overflow-hidden border border-white/[0.08]"
      /* ponytail: CSS zoom scales the box itself (760x560 window renders 836x616 at scale 1.1), which clipped the header controls and content edges. Dividing the viewport size by the scale keeps the rendered box window-sized. Upgrade path: rem-based sizing + a --ui-scale CSS var if px/rem mixing becomes a pain. */
      style={{
        zoom: uiScale,
        width: `calc(100vw / ${uiScale})`,
        height: `calc(100vh / ${uiScale})`,
      }}
    >
      {/* Unified Custom Frameless Header + Live Preview */}
      <div
        onMouseDown={handleTitlebarDrag}
        className="h-13 border-b border-white/[0.07] pl-4 pr-2.5 flex items-center justify-between shrink-0 bg-[#0e1014]"
      >
        {/* Left: App Brand */}
        <div className="flex items-center gap-2.5">
          <div
            className="w-6 h-6 rounded-md flex items-center justify-center border border-white/10"
            style={{
              backgroundColor: `${settings.accentColor}20`,
              color: settings.accentColor,
            }}
          >
            <div
              className="w-3 h-1.5 rounded-full"
              style={{ backgroundColor: settings.accentColor }}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold tracking-[-0.01em] text-white">
              Notch Settings
            </span>
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-white/[0.06] text-neutral-400 font-medium tabular-nums">
              v0.1
            </span>
          </div>
        </div>

        {/* Center: Live Interactive Notch Pill Preview */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-neutral-500 font-medium hidden sm:inline">
            Live Preview
          </span>
          <div
            className="px-3.5 py-1 flex items-center gap-2.5 border shadow-md transition-all duration-150"
            style={{
              backgroundColor: hexToRgba(settings.bgColor, settings.bgOpacity),
              borderColor: hexToRgba(
                settings.borderColor,
                settings.borderOpacity
              ),
              borderRadius: `${Math.min(settings.borderRadius, 22)}px`,
              color: settings.textColor,
              fontWeight: Number(settings.fontWeight),
              fontSize: `${Math.round(11 * settings.fontSizeScale)}px`,
            }}
          >
            {/* Mini equalizer bars */}
            <span className="flex items-end gap-0.5 h-2.5">
              <span
                className="w-0.5 h-2 rounded-full animate-pulse"
                style={{ backgroundColor: settings.accentColor }}
              />
              <span
                className="w-0.5 h-2.5 rounded-full"
                style={{ backgroundColor: settings.accentColor }}
              />
              <span
                className="w-0.5 h-1.5 rounded-full animate-pulse"
                style={{ backgroundColor: settings.accentColor }}
              />
            </span>
            <span className="truncate max-w-[140px]">Midnight City — M83</span>
            <span className="text-[11px] opacity-55 tabular-nums">12:45</span>
          </div>
        </div>

        {/* Right: Reset + Window Controls */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleReset}
            title="Kembalikan semua pengaturan ke standar awal"
            className={`h-7 px-2.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer ${
              confirmReset
                ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                : "bg-white/[0.04] hover:bg-white/[0.09] text-neutral-400 hover:text-neutral-200 border border-white/[0.06]"
            }`}
          >
            <RotateCcw className="w-3 h-3" />
            <span>{confirmReset ? "Klik lagi utk Reset" : "Reset"}</span>
          </button>

          <div className="w-px h-4 bg-white/[0.08] mx-1" />

          <button
            type="button"
            onClick={() => invoke("minimize_settings_window").catch(() => {})}
            title="Minimize"
            className="w-7 h-7 rounded-md flex items-center justify-center text-neutral-400 hover:text-white hover:bg-white/[0.08] transition-colors active:scale-95 cursor-pointer"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => invoke("close_settings_window").catch(() => {})}
            title="Tutup Pengaturan"
            className="w-7 h-7 rounded-md flex items-center justify-center text-neutral-400 hover:text-rose-300 hover:bg-rose-500/20 transition-colors active:scale-95 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Split Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar Navigation */}
        <aside className="w-48 border-r border-white/[0.07] p-3 flex flex-col justify-between shrink-0 bg-[#0d0e12]">
          <div className="space-y-4">
            {navGroups.map((grp) => (
              <div key={grp.group} className="space-y-1">
                <div className="px-2.5 text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">
                  {grp.group}
                </div>
                {grp.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setActiveTab(item.id)}
                      className={`w-full relative flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs font-medium transition-all duration-150 cursor-pointer active:scale-[0.98] ${
                        isActive
                          ? "bg-white/[0.08] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                          : "text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.04]"
                      }`}
                    >
                      {isActive && (
                        <span
                          className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r"
                          style={{ backgroundColor: settings.accentColor }}
                        />
                      )}
                      <Icon
                        className={`w-3.5 h-3.5 transition-colors ${
                          isActive ? "" : "text-neutral-500"
                        }`}
                        style={
                          isActive ? { color: settings.accentColor } : undefined
                        }
                      />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Bottom Status Pill */}
          <div className="px-2.5 py-2 rounded-lg bg-white/[0.03] border border-white/[0.05] flex items-center justify-between">
            <span className="text-[11px] text-neutral-400 flex items-center gap-1.5">
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: settings.accentColor }}
              />
              Low-RAM Mode
            </span>
            <span className="text-[11px] text-neutral-500 font-mono tabular-nums">
              Active
            </span>
          </div>
        </aside>

        {/* Right Content Canvas */}
        <main className="flex-1 p-5 overflow-y-auto">
          {/* ponytail: pure CSS compositor animation on key={activeTab} instead of Framer Motion AnimatePresence (0 extra DOM retention / 0 JS heap overhead) */}
          <div
            key={activeTab}
            className="settings-tab-enter max-w-xl mx-auto space-y-5"
          >
            {/* TAB 1: DISPLAY & BEHAVIOR */}
            {activeTab === "display" && (
              <>
                {/* Section A: Visual Monitor Grid */}
                <section className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <h2 className="text-xs font-semibold text-white tracking-[-0.01em]">
                        Target Layar Monitor
                      </h2>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                        <ShieldCheck className="w-3 h-3" />
                        Auto-Fallback Aman
                      </span>
                      <InfoPopover
                        title="Proteksi Cabut Kabel (Auto-Fallback)"
                        lines={[
                          "Jika monitor eksternal dicabut atau dimatikan, Notch otomatis berpindah kembali ke layar utama laptop tanpa error atau hilang di luar layar.",
                        ]}
                      />
                    </div>

                    <button
                      type="button"
                      onClick={fetchMonitors}
                      disabled={isRefreshingMonitors}
                      className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.07] text-neutral-300 hover:text-white transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
                    >
                      <RefreshCw
                        className={`w-3 h-3 ${
                          isRefreshingMonitors ? "animate-spin" : ""
                        }`}
                      />
                      <span>Pindai Ulang</span>
                    </button>
                  </div>

                  {/* Visual Monitor Bento Grid */}
                  <div className="grid grid-cols-2 gap-2.5">
                    {monitors.map((m, idx) => {
                      const isSelected =
                        m.id === "primary"
                          ? !settings.targetMonitor ||
                            settings.targetMonitor === "primary"
                          : settings.targetMonitor === m.id;
                      const title = cleanMonitorTitle(m);

                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => update({ targetMonitor: m.id })}
                          style={
                            isSelected
                              ? {
                                  borderColor: `${settings.accentColor}90`,
                                  backgroundColor: `${settings.accentColor}12`,
                                }
                              : undefined
                          }
                          className={`group text-left rounded-xl p-3 border transition-all duration-150 cursor-pointer active:scale-[0.99] flex flex-col justify-between gap-2.5 ${
                            isSelected
                              ? "shadow-sm"
                              : "bg-[#12141a] border-white/[0.07] hover:border-white/[0.16] hover:bg-white/[0.04]"
                          }`}
                        >
                          {/* Miniature Screen Aspect Illustration */}
                          <div className="w-full h-14 rounded-lg bg-[#090a0d] border border-white/[0.08] relative flex flex-col items-center justify-between p-1.5 overflow-hidden">
                            {/* Top Bezel Notch Pill */}
                            <div
                              className="h-1.5 rounded-full transition-all duration-200"
                              style={{
                                width: isSelected ? "36px" : "22px",
                                backgroundColor: isSelected
                                  ? settings.accentColor
                                  : "rgba(255,255,255,0.18)",
                              }}
                            />
                            <span className="text-[11px] font-semibold text-neutral-500 tabular-nums">
                              {m.id === "primary" ? "AUTO" : `DISPLAY ${idx}`}
                            </span>
                            <div className="w-8 h-0.5 rounded-full bg-white/10" />
                          </div>

                          {/* Card Footer Metadata */}
                          <div className="flex items-start justify-between gap-2 w-full">
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-semibold text-white truncate">
                                  {title}
                                </span>
                                {m.is_primary && m.id !== "primary" && (
                                  <span className="shrink-0 px-1.5 py-0.2 text-[10px] font-medium rounded bg-white/10 text-neutral-300">
                                    Utama
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-neutral-400 mt-0.5 tabular-nums">
                                {m.width} × {m.height} •{" "}
                                {(m.scale_factor * 100).toFixed(0)}% DPI
                              </div>
                            </div>

                            <div
                              style={
                                isSelected
                                  ? {
                                      backgroundColor: settings.accentColor,
                                      borderColor: settings.accentColor,
                                    }
                                  : undefined
                              }
                              className={`w-4 h-4 rounded-full border shrink-0 mt-0.5 flex items-center justify-center transition-colors ${
                                isSelected
                                  ? "text-black"
                                  : "border-white/20 group-hover:border-white/40"
                              }`}
                            >
                              {isSelected && (
                                <Check className="w-2.5 h-2.5 stroke-[3]" />
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>

                {/* Section B: Unified Behavior & Automation Card */}
                <section className="space-y-2">
                  <h2 className="text-xs font-semibold text-white tracking-[-0.01em]">
                    Otomasi & Perilaku Jendela
                  </h2>

                  <div className="bg-[#12141a] border border-white/[0.07] rounded-xl divide-y divide-white/[0.06]">
                    {/* Row 1: Game Mode */}
                    <div className="p-3.5 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                          style={{
                            backgroundColor: `${settings.accentColor}18`,
                            color: settings.accentColor,
                          }}
                        >
                          <Gamepad2 className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold text-white">
                              Game Mode & Auto-Avoidance
                            </span>
                            <InfoPopover
                              title="Cara Kerja Game Mode"
                              lines={[
                                "• Dual Monitor: Saat game fullscreen (Valorant, CS2, dll) aktif, Notch otomatis bergeser ke monitor kedua agar HUD/crosshair tidak terhalang.",
                                "• Single Monitor: Notch otomatis bersembunyi sementara dan muncul kembali saat Alt-Tab atau game ditutup.",
                              ]}
                            />
                          </div>
                          <p className="text-xs text-neutral-400 truncate mt-0.5">
                            Pindah ke layar kedua atau sembunyi otomatis saat
                            bermain game fullscreen
                          </p>
                        </div>
                      </div>

                      <ToggleSwitch
                        checked={settings.gameModeAutoShift ?? true}
                        onChange={() =>
                          update({
                            gameModeAutoShift: !(
                              settings.gameModeAutoShift ?? true
                            ),
                          })
                        }
                        accentColor={settings.accentColor}
                      />
                    </div>

                    {/* Row 2: Smart Tab Avoidance */}
                    <div className="p-3.5 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                          style={{
                            backgroundColor: `${settings.accentColor}18`,
                            color: settings.accentColor,
                          }}
                        >
                          <AppWindow className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold text-white">
                              Smart Tab Avoidance
                            </span>
                            <InfoPopover
                              title="Deteksi Tab Browser Penuh"
                              lines={[
                                "Saat jendela browser dimaksimalkan dan jumlah tab menabrak area tengah atas layar, Notch otomatis menciut menjadi kapsul tipis (114×22 px) agar tab browser tetap bebas diklik tanpa memindahkan Notch ke monitor lain.",
                              ]}
                            />
                          </div>
                          <p className="text-xs text-neutral-400 truncate mt-0.5">
                            Ciutkan kapsul otomatis saat barisan tab browser
                            menyentuh area Notch
                          </p>
                        </div>
                      </div>

                      <ToggleSwitch
                        checked={settings.smartTabAvoidance ?? true}
                        onChange={() =>
                          update({
                            smartTabAvoidance: !(
                              settings.smartTabAvoidance ?? true
                            ),
                          })
                        }
                        accentColor={settings.accentColor}
                      />
                    </div>

                    {/* Row 3: Compact Pill Mode */}
                    <div className="p-3.5 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                          style={{
                            backgroundColor: `${settings.accentColor}18`,
                            color: settings.accentColor,
                          }}
                        >
                          <Minimize2 className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold text-white">
                              Mode Compact Pill (Minimalis)
                            </span>
                            <span className="px-1.5 py-0.2 rounded bg-white/[0.06] text-[11px] text-neutral-400">
                              Klik Ganda Notch
                            </span>
                          </div>
                          <p className="text-xs text-neutral-400 truncate mt-0.5">
                            Tampilkan Notch sebagai kapsul mini 114×22 px saat
                            tidak di-hover
                          </p>
                        </div>
                      </div>

                      <ToggleSwitch
                        checked={settings.compactMode}
                        onChange={() =>
                          update({ compactMode: !settings.compactMode })
                        }
                        accentColor={settings.accentColor}
                      />
                    </div>

                    {/* Row 4: Expansion Trigger (hover / click / both) */}
                    <div className="p-3.5 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                          style={{
                            backgroundColor: `${settings.accentColor}18`,
                            color: settings.accentColor,
                          }}
                        >
                          <MousePointer2 className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold text-white">
                              Cara Buka Notch
                            </span>
                            <InfoPopover
                              title="Pemicu Ekspansi Notch"
                              lines={[
                                "• Hover: Notch membuka otomatis saat kursor mendekat, dan menutup lagi saat kursor menjauh. Klik tidak membuka.",
                                "• Click: Notch hanya terbuka saat diklik, lalu tetap terbuka sampai diklik ulang (tidak menutup sendiri, hover diabaikan).",
                              ]}
                            />
                          </div>
                          <p className="text-xs text-neutral-400 truncate mt-0.5">
                            Hover = otomatis saat kursor lewat, Click = hanya
                            saat diklik
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center bg-white/[0.04] border border-white/[0.06] rounded-lg p-0.5 shrink-0">
                        {(
                          [
                            { id: "hover", label: "Hover" },
                            { id: "click", label: "Click" },
                          ] as const
                        ).map((opt) => {
                          const isActive =
                            (settings.expandTrigger ?? "hover") === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => update({ expandTrigger: opt.id })}
                              aria-pressed={isActive}
                              className={`px-2.5 h-6 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                                isActive
                                  ? "bg-white/[0.14] text-white"
                                  : "text-neutral-400 hover:text-white hover:bg-white/[0.06]"
                              }`}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </section>

                {/* Section C: Header Navigation Bar (pinned modules) */}
                <section className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-xs font-semibold text-white tracking-[-0.01em]">
                      Navigation Bar (Modul)
                    </h2>
                    <span className="text-[11px] text-neutral-500 font-mono tabular-nums">
                      {pinnedModules.length}/{MAX_NAV_ICONS}
                    </span>
                  </div>
                  <p className="text-xs text-neutral-400">
                    Maksimal {MAX_NAV_ICONS} ikon tampil di header. Modul sisanya
                    masuk ke menu "…" agar strip navigasi tidak tabrakan.
                  </p>

                  <div className="bg-[#12141a] border border-white/[0.07] rounded-xl divide-y divide-white/[0.06]">
                    {pinnedModules.map((id, idx) => {
                      const def = moduleDef(id);
                      return (
                        <div
                          key={id}
                          className="px-2.5 py-2 flex items-center justify-between gap-3"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className="text-[11px] text-neutral-500 font-mono tabular-nums w-3 shrink-0">
                              {idx + 1}
                            </span>
                            <def.icon
                              className="w-3.5 h-3.5 shrink-0"
                              style={{ color: settings.accentColor }}
                            />
                            <span className="text-xs text-white truncate">
                              {def.label}
                            </span>
                          </div>
                          <div className="flex items-center gap-0.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => moveModule(id, -1)}
                              disabled={idx === 0}
                              title="Naikkan"
                              aria-label={`Naikkan ${def.label}`}
                              className="w-6 h-6 rounded-md flex items-center justify-center text-neutral-400 hover:text-white hover:bg-white/[0.08] disabled:opacity-25 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default"
                            >
                              <ChevronUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveModule(id, 1)}
                              disabled={idx === pinnedModules.length - 1}
                              title="Turunkan"
                              aria-label={`Turunkan ${def.label}`}
                              className="w-6 h-6 rounded-md flex items-center justify-center text-neutral-400 hover:text-white hover:bg-white/[0.08] disabled:opacity-25 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default"
                            >
                              <ChevronDown className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => unpinModule(id)}
                              disabled={pinnedModules.length <= 1}
                              title="Sembunyikan dari header (pindah ke menu …)"
                              aria-label={`Sembunyikan ${def.label}`}
                              className="w-6 h-6 rounded-md flex items-center justify-center text-neutral-400 hover:text-rose-300 hover:bg-rose-500/20 disabled:opacity-25 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}

                    {unpinnedModules.map((id) => {
                      const def = moduleDef(id);
                      return (
                        <div
                          key={id}
                          className="px-2.5 py-2 flex items-center justify-between gap-3"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className="text-[11px] text-neutral-600 font-mono w-3 shrink-0">
                              –
                            </span>
                            <def.icon className="w-3.5 h-3.5 shrink-0 text-neutral-500" />
                            <span className="text-xs text-neutral-400 truncate">
                              {def.label}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => pinModule(id)}
                            title="Tampilkan di header"
                            aria-label={`Tampilkan ${def.label}`}
                            className="px-2 h-6 rounded-md text-[11px] text-neutral-300 hover:text-white hover:bg-white/[0.08] cursor-pointer shrink-0"
                          >
                            Tampilkan
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </>
            )}

            {/* TAB 2: APPEARANCE & COLORS */}
            {activeTab === "appearance" && (
              <>
                {/* 2-Column Color Swatch Bento */}
                <section className="grid grid-cols-2 gap-3">
                  {/* Card 1: Background Color */}
                  <div className="bg-[#12141a] border border-white/[0.07] rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs font-semibold text-white">
                          Warna Latar Notch
                        </div>
                        <div className="text-xs text-neutral-400 mt-0.5">
                          Warna dasar permukaan kapsul
                        </div>
                      </div>
                      <label className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.09] border border-white/10 cursor-pointer">
                        <input
                          type="color"
                          value={settings.bgColor}
                          onChange={(e) => update({ bgColor: e.target.value })}
                          className="w-3.5 h-3.5 rounded bg-transparent cursor-pointer border-0"
                        />
                        <span className="text-[11px] font-mono text-neutral-300 uppercase">
                          {settings.bgColor}
                        </span>
                      </label>
                    </div>

                    <div className="flex items-center gap-2 pt-1">
                      {BG_PRESETS.map((p) => {
                        const active =
                          settings.bgColor.toLowerCase() ===
                          p.hex.toLowerCase();
                        return (
                          <button
                            key={p.hex}
                            type="button"
                            title={p.name}
                            onClick={() => update({ bgColor: p.hex })}
                            className={`group flex-1 h-7 rounded-lg border flex items-center justify-center transition-all cursor-pointer active:scale-95 ${
                              active
                                ? "border-white ring-2 ring-white/20"
                                : "border-white/15 hover:border-white/40"
                            }`}
                            style={{ backgroundColor: p.hex }}
                          >
                            {active && (
                              <Check className="w-3 h-3 text-white stroke-[2.5]" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Card 2: Accent Color */}
                  <div className="bg-[#12141a] border border-white/[0.07] rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs font-semibold text-white">
                          Warna Aksen & Equalizer
                        </div>
                        <div className="text-xs text-neutral-400 mt-0.5">
                          Highlight aktif, equalizer & progress
                        </div>
                      </div>
                      <label className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.09] border border-white/10 cursor-pointer">
                        <input
                          type="color"
                          value={settings.accentColor}
                          onChange={(e) =>
                            update({ accentColor: e.target.value })
                          }
                          className="w-3.5 h-3.5 rounded bg-transparent cursor-pointer border-0"
                        />
                        <span className="text-[11px] font-mono text-neutral-300 uppercase">
                          {settings.accentColor}
                        </span>
                      </label>
                    </div>

                    <div className="flex items-center gap-2 pt-1">
                      {ACCENT_PRESETS.map((p) => {
                        const active =
                          settings.accentColor.toLowerCase() ===
                          p.hex.toLowerCase();
                        return (
                          <button
                            key={p.hex}
                            type="button"
                            title={p.name}
                            onClick={() => update({ accentColor: p.hex })}
                            className={`group flex-1 h-7 rounded-lg border flex items-center justify-center transition-all cursor-pointer active:scale-95 ${
                              active
                                ? "border-white ring-2 ring-white/25"
                                : "border-white/15 hover:border-white/40"
                            }`}
                            style={{ backgroundColor: p.hex }}
                          >
                            {active && (
                              <Check className="w-3 h-3 text-black stroke-[3]" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </section>

                {/* Unified Glass & Geometry Card */}
                <section className="bg-[#12141a] border border-white/[0.07] rounded-xl divide-y divide-white/[0.06]">
                  {/* Background Opacity */}
                  <div className="p-4 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs font-semibold text-white">
                          Transparansi Kaca (Background Opacity)
                        </div>
                        <div className="text-xs text-neutral-400">
                          Tingkat kepekatan latar belakang Notch terhadap layar
                        </div>
                      </div>
                      <span
                        className="text-xs font-mono font-semibold tabular-nums"
                        style={{ color: settings.accentColor }}
                      >
                        {settings.bgOpacity}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="40"
                      max="100"
                      value={settings.bgOpacity}
                      onChange={(e) =>
                        update({ bgOpacity: Number(e.target.value) })
                      }
                      style={{ accentColor: settings.accentColor }}
                      className="w-full cursor-pointer"
                    />
                  </div>

                  {/* Corner Radius */}
                  <div className="p-4 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs font-semibold text-white">
                          Lengkungan Sudut (Corner Radius)
                        </div>
                        <div className="text-xs text-neutral-400">
                          Geometri kelengkungan kapsul (12px kotak tegas – 30px
                          kapsul penuh)
                        </div>
                      </div>
                      <span
                        className="text-xs font-mono font-semibold tabular-nums"
                        style={{ color: settings.accentColor }}
                      >
                        {settings.borderRadius}px
                      </span>
                    </div>
                    <input
                      type="range"
                      min="12"
                      max="30"
                      value={settings.borderRadius}
                      onChange={(e) =>
                        update({ borderRadius: Number(e.target.value) })
                      }
                      style={{ accentColor: settings.accentColor }}
                      className="w-full cursor-pointer"
                    />
                  </div>

                  {/* Border Opacity */}
                  <div className="p-4 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs font-semibold text-white">
                          Kilau Garis Tepi (Border Glow)
                        </div>
                        <div className="text-xs text-neutral-400">
                          Ketajaman garis batas luar kapsul Notch
                        </div>
                      </div>
                      <span
                        className="text-xs font-mono font-semibold tabular-nums"
                        style={{ color: settings.accentColor }}
                      >
                        {settings.borderOpacity}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="50"
                      value={settings.borderOpacity}
                      onChange={(e) =>
                        update({ borderOpacity: Number(e.target.value) })
                      }
                      style={{ accentColor: settings.accentColor }}
                      className="w-full cursor-pointer"
                    />
                  </div>
                </section>
              </>
            )}

            {/* TAB 3: TYPOGRAPHY */}
            {activeTab === "typography" && (
              <>
                {/* Font Weight Specimen Grid */}
                <section className="bg-[#12141a] border border-white/[0.07] rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold text-white">
                        Ketebalan Huruf (Font Weight)
                      </div>
                      <div className="text-xs text-neutral-400">
                        Pilih karakter ketebalan teks lagu, lirik, dan jam
                      </div>
                    </div>
                    <span
                      className="text-xs font-mono font-semibold tabular-nums"
                      style={{ color: settings.accentColor }}
                    >
                      Weight {settings.fontWeight}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    {FONT_WEIGHTS.map((fw) => {
                      const active = settings.fontWeight === fw.value;
                      return (
                        <button
                          key={fw.value}
                          type="button"
                          onClick={() => update({ fontWeight: fw.value })}
                          style={
                            active
                              ? {
                                  borderColor: `${settings.accentColor}90`,
                                  backgroundColor: `${settings.accentColor}15`,
                                }
                              : undefined
                          }
                          className={`p-2.5 rounded-xl border text-left transition-all cursor-pointer active:scale-[0.98] flex items-center justify-between ${
                            active
                              ? "text-white"
                              : "border-white/[0.07] bg-white/[0.02] text-neutral-400 hover:text-white hover:bg-white/[0.05]"
                          }`}
                        >
                          <div>
                            <div
                              className="text-xs text-white"
                              style={{ fontWeight: Number(fw.value) }}
                            >
                              {fw.label}
                            </div>
                            <div className="text-[11px] text-neutral-500 font-mono">
                              {fw.sub}
                            </div>
                          </div>
                          <span
                            className="text-base text-neutral-300"
                            style={{ fontWeight: Number(fw.value) }}
                          >
                            Aa
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>

                {/* Unified Scale & Text Color Card */}
                <section className="bg-[#12141a] border border-white/[0.07] rounded-xl divide-y divide-white/[0.06]">
                  {/* Font Scale */}
                  <div className="p-4 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs font-semibold text-white">
                          Skala Ukuran Teks
                        </div>
                        <div className="text-xs text-neutral-400">
                          Perbesar atau perkecil proporsi teks di dalam Notch
                        </div>
                      </div>
                      <span
                        className="text-xs font-mono font-semibold tabular-nums"
                        style={{ color: settings.accentColor }}
                      >
                        {Math.round(settings.fontSizeScale * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0.80"
                      max="1.30"
                      step="0.05"
                      value={settings.fontSizeScale}
                      onChange={(e) =>
                        update({ fontSizeScale: Number(e.target.value) })
                      }
                      style={{ accentColor: settings.accentColor }}
                      className="w-full cursor-pointer"
                    />
                    <div className="flex justify-between text-[11px] text-neutral-500 tabular-nums">
                      <span>80% (Ringkas)</span>
                      <span>100% (Ideal)</span>
                      <span>130% (Besar)</span>
                    </div>
                  </div>

                  {/* Text Color */}
                  <div className="p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs font-semibold text-white">
                          Warna Teks Utama
                        </div>
                        <div className="text-xs text-neutral-400">
                          Warna judul lagu, lirik aktif, dan indikator waktu
                        </div>
                      </div>
                      <label className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.09] border border-white/10 cursor-pointer">
                        <input
                          type="color"
                          value={settings.textColor}
                          onChange={(e) =>
                            update({ textColor: e.target.value })
                          }
                          className="w-3.5 h-3.5 rounded bg-transparent cursor-pointer border-0"
                        />
                        <span className="text-[11px] font-mono text-neutral-300 uppercase">
                          {settings.textColor}
                        </span>
                      </label>
                    </div>

                    <div className="grid grid-cols-5 gap-2">
                      {TEXT_PRESETS.map((p) => {
                        const active =
                          settings.textColor.toLowerCase() ===
                          p.hex.toLowerCase();
                        return (
                          <button
                            key={p.hex}
                            type="button"
                            onClick={() => update({ textColor: p.hex })}
                            className={`px-2 py-1.5 rounded-lg border text-[11px] font-medium flex items-center justify-center gap-1.5 transition-all cursor-pointer active:scale-95 ${
                              active
                                ? "border-white bg-white/15 text-white"
                                : "border-white/10 bg-white/[0.03] text-neutral-400 hover:text-white"
                            }`}
                          >
                            <span
                              className="w-2.5 h-2.5 rounded-full border border-black/20 shrink-0"
                              style={{ backgroundColor: p.hex }}
                            />
                            <span className="truncate">{p.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </section>
              </>
            )}

            {/* TAB 4: MOTION & LYRICS */}
            {activeTab === "motion" && (
              <section className="bg-[#12141a] border border-white/[0.07] rounded-xl divide-y divide-white/[0.06]">
                {/* Lyrics Offset */}
                <div className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold text-white">
                        Sinkronisasi Waktu Lirik (Lead / Offset)
                      </div>
                      <div className="text-xs text-neutral-400">
                        Sesuaikan ketepatan waktu kemunculan baris lirik
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() =>
                          update({
                            leadTime: Number(
                              Math.max(-1.5, settings.leadTime - 0.1).toFixed(2)
                            ),
                          })
                        }
                        className="px-2 py-0.5 text-[11px] rounded bg-white/[0.06] hover:bg-white/[0.12] text-neutral-300 font-mono cursor-pointer active:scale-95"
                      >
                        -0.1s
                      </button>
                      <button
                        type="button"
                        onClick={() => update({ leadTime: 0.15 })}
                        className="px-2 py-0.5 text-[11px] rounded bg-white/[0.06] hover:bg-white/[0.12] font-mono font-semibold cursor-pointer active:scale-95 tabular-nums"
                        style={{ color: settings.accentColor }}
                      >
                        {settings.leadTime > 0
                          ? `+${settings.leadTime.toFixed(2)}s`
                          : `${settings.leadTime.toFixed(2)}s`}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          update({
                            leadTime: Number(
                              Math.min(1.5, settings.leadTime + 0.1).toFixed(2)
                            ),
                          })
                        }
                        className="px-2 py-0.5 text-[11px] rounded bg-white/[0.06] hover:bg-white/[0.12] text-neutral-300 font-mono cursor-pointer active:scale-95"
                      >
                        +0.1s
                      </button>
                    </div>
                  </div>
                  <input
                    type="range"
                    min="-1.5"
                    max="1.5"
                    step="0.05"
                    value={settings.leadTime}
                    onChange={(e) =>
                      update({ leadTime: Number(e.target.value) })
                    }
                    style={{ accentColor: settings.accentColor }}
                    className="w-full cursor-pointer"
                  />
                  <div className="flex justify-between text-[11px] text-neutral-500 tabular-nums">
                    <span>-1.50s (Tunda Lirik)</span>
                    <span>0.00s (Sinkron Murni)</span>
                    <span>+1.50s (Lebih Awal)</span>
                  </div>
                </div>

                {/* Spring Physics */}
                <div className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold text-white">
                        Karakter Pegas Animasi (Spring Damping)
                      </div>
                      <div className="text-xs text-neutral-400">
                        Tingkat redaman saat Notch membuka dan menutup
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {[
                        { label: "Bouncy", val: 20 },
                        { label: "Natural", val: 26 },
                        { label: "Tegas", val: 33 },
                      ].map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() =>
                            update({ springBounciness: preset.val })
                          }
                          className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer active:scale-95 ${
                            settings.springBounciness === preset.val
                              ? "bg-white/15 text-white"
                              : "bg-white/[0.05] text-neutral-400 hover:text-neutral-200"
                          }`}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <input
                    type="range"
                    min="18"
                    max="35"
                    value={settings.springBounciness}
                    onChange={(e) =>
                      update({ springBounciness: Number(e.target.value) })
                    }
                    style={{ accentColor: settings.accentColor }}
                    className="w-full cursor-pointer"
                  />
                </div>
              </section>
            )}

            {/* TAB 4.5: NOTIFICATIONS (PHONE LINK & LAPTOP) */}
            {activeTab === "notifications" && (
              <>
                <section className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <h2 className="text-xs font-semibold text-white tracking-[-0.01em]">
                        Notifikasi HP (Bluetooth / Phone Link) & Laptop
                      </h2>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                        Zero-Bloat WinSQLite
                      </span>
                      <InfoPopover
                        title="Cara Menghubungkan Notifikasi HP ke Notch"
                        lines={[
                          "1. Sambungkan HP ke laptop via Bluetooth & aplikasi bawaan Windows 'Phone Link' (Koneksi ke Windows).",
                          "2. Aktifkan izin 'Notifications' di aplikasi Phone Link.",
                          "3. Notch membaca database notifikasi Windows secara langsung (0 MB background service tambahan) dan menampilkan pop-up bahkan saat Notch sedang tertutup.",
                        ]}
                      />
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          invoke("trigger_test_notification", {
                            source: "phone",
                          }).catch(() => {})
                        }
                        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.07] text-neutral-300 hover:text-white transition-all active:scale-95 cursor-pointer"
                        title="Simulasikan notifikasi masuk dari HP saat Notch tertutup"
                      >
                        <Smartphone
                          className="w-3 h-3"
                          style={{ color: settings.accentColor }}
                        />
                        <span>Tes Notif HP</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          invoke("trigger_test_notification", {
                            source: "laptop",
                          }).catch(() => {})
                        }
                        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.07] text-neutral-300 hover:text-white transition-all active:scale-95 cursor-pointer"
                        title="Simulasikan notifikasi masuk dari aplikasi PC saat Notch tertutup"
                      >
                        <Laptop className="w-3 h-3 text-sky-400" />
                        <span>Tes Notif PC</span>
                      </button>
                    </div>
                  </div>

                  <div className="bg-[#12141a] border border-white/[0.07] rounded-xl divide-y divide-white/[0.06]">
                    {/* Row 1: Master Notification Toggle */}
                    <div className="p-3.5 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                          style={{
                            backgroundColor: `${settings.accentColor}18`,
                            color: settings.accentColor,
                          }}
                        >
                          <Bell className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <span className="text-xs font-semibold text-white">
                            Aktifkan Pop-up & Notification Center di Notch
                          </span>
                          <p className="text-xs text-neutral-400 truncate mt-0.5">
                            Munculkan pop-up Dynamic Island saat Notch tertutup
                            dan simpan riwayat di tab Notifikasi
                          </p>
                        </div>
                      </div>

                      <ToggleSwitch
                        checked={settings.notificationsEnabled ?? true}
                        onChange={() =>
                          update({
                            notificationsEnabled: !(
                              settings.notificationsEnabled ?? true
                            ),
                          })
                        }
                        accentColor={settings.accentColor}
                      />
                    </div>

                    {/* Row 2: Phone Notifications (Phone Link / Bluetooth) */}
                    <div className="p-3.5 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                          style={{
                            backgroundColor: `${settings.accentColor}18`,
                            color: settings.accentColor,
                          }}
                        >
                          <Smartphone className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold text-white">
                              Notifikasi dari HP (Bluetooth / Phone Link)
                            </span>
                            <span className="px-1.5 py-0.2 rounded bg-white/[0.06] text-[11px] text-neutral-300">
                              WhatsApp, GoPay, SMS, dll
                            </span>
                          </div>
                          <p className="text-xs text-neutral-400 truncate mt-0.5">
                            Tangkap semua notifikasi HP yang diteruskan ke
                            laptop melalui Windows Phone Link
                          </p>
                        </div>
                      </div>

                      <ToggleSwitch
                        checked={settings.phoneNotificationsEnabled ?? true}
                        disabled={!(settings.notificationsEnabled ?? true)}
                        onChange={() =>
                          update({
                            phoneNotificationsEnabled: !(
                              settings.phoneNotificationsEnabled ?? true
                            ),
                          })
                        }
                        accentColor={settings.accentColor}
                      />
                    </div>

                    {/* Row 3: Laptop Notifications */}
                    <div className="p-3.5 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-sky-500/15 text-sky-400">
                          <Laptop className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <span className="text-xs font-semibold text-white">
                            Notifikasi Aplikasi Laptop (PC)
                          </span>
                          <p className="text-xs text-neutral-400 truncate mt-0.5">
                            Tampilkan notifikasi dari aplikasi desktop (Discord,
                            Telegram, Browser, Sistem)
                          </p>
                        </div>
                      </div>

                      <ToggleSwitch
                        checked={settings.laptopNotificationsEnabled ?? true}
                        disabled={!(settings.notificationsEnabled ?? true)}
                        onChange={() =>
                          update({
                            laptopNotificationsEnabled: !(
                              settings.laptopNotificationsEnabled ?? true
                            ),
                          })
                        }
                        accentColor={settings.accentColor}
                      />
                    </div>

                    {/* Row 4: Do Not Disturb in Game Mode */}
                    <div className="p-3.5 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                          style={{
                            backgroundColor: `${settings.accentColor}18`,
                            color: settings.accentColor,
                          }}
                        >
                          <Gamepad2 className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <span className="text-xs font-semibold text-white">
                            Mode Fokus saat Bermain Game Fullscreen
                          </span>
                          <p className="text-xs text-neutral-400 truncate mt-0.5">
                            Tahan pop-up saat bermain game (notifikasi tetap
                            tersimpan di Notification Center)
                          </p>
                        </div>
                      </div>

                      <ToggleSwitch
                        checked={settings.dndInGameMode ?? true}
                        disabled={!(settings.notificationsEnabled ?? true)}
                        onChange={() =>
                          update({
                            dndInGameMode: !(settings.dndInGameMode ?? true),
                          })
                        }
                        accentColor={settings.accentColor}
                      />
                    </div>

                    {/* Row 5: Pop-up Duration Slider */}
                    <div className="p-4 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-xs font-semibold text-white">
                            Durasi Pop-up saat Notch Tertutup
                          </div>
                          <div className="text-xs text-neutral-400">
                            Lama waktu banner notifikasi tampil sebelum menciut
                            kembali
                          </div>
                        </div>
                        <span
                          className="text-xs font-mono font-semibold tabular-nums"
                          style={{ color: settings.accentColor }}
                        >
                          {(settings.notificationPopDuration ?? 4.0).toFixed(1)}{" "}
                          detik
                        </span>
                      </div>
                      <input
                        type="range"
                        min="2.5"
                        max="7.0"
                        step="0.5"
                        disabled={!(settings.notificationsEnabled ?? true)}
                        value={settings.notificationPopDuration ?? 4.0}
                        onChange={(e) =>
                          update({
                            notificationPopDuration: Number(e.target.value),
                          })
                        }
                        style={{ accentColor: settings.accentColor }}
                        className="w-full cursor-pointer disabled:opacity-50"
                      />
                    </div>
                  </div>
                </section>
              </>
            )}

            {/* TAB: AGENT SETTINGS */}
            {activeTab === "agent" && (
              <>
                <section className="space-y-3">
                  <div className="bg-[#12141a] border border-white/[0.07] rounded-xl divide-y divide-white/[0.06]">
                    {/* Base URL */}
                    <div className="p-3.5 flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold">Base URL (OpenAI-compatible)</div>
                        <div className="text-[11px] text-white/45">Endpoint chat/completions, mis. https://api.9router.com/v1</div>
                      </div>
                      <input
                        value={settings.agentBaseUrl}
                        onChange={(e) => update({ agentBaseUrl: e.target.value })}
                        className="w-72 h-8 rounded-lg border border-white/10 bg-white/[0.05] px-2.5 text-[12px] text-white/90 outline-none focus:border-white/25"
                      />
                    </div>
                    {/* API key */}
                    <div className="p-3.5 flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold">API Key</div>
                        <div className="text-[11px] text-white/45">Disimpan lokal di settings.json — tidak dikirim ke server lain</div>
                      </div>
                      <input
                        type="password"
                        value={settings.agentApiKey}
                        onChange={(e) => update({ agentApiKey: e.target.value })}
                        className="w-72 h-8 rounded-lg border border-white/10 bg-white/[0.05] px-2.5 text-[12px] text-white/90 outline-none focus:border-white/25"
                      />
                    </div>
                    {/* Model */}
                    <div className="p-3.5 flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold">Model</div>
                        <div className="text-[11px] text-white/45">Nama model persis seperti di 9Router</div>
                      </div>
                      <input
                        value={settings.agentModel}
                        onChange={(e) => update({ agentModel: e.target.value })}
                        placeholder="mis. nama-model:gratis"
                        className="w-72 h-8 rounded-lg border border-white/10 bg-white/[0.05] px-2.5 text-[12px] text-white/90 outline-none placeholder:text-white/25 focus:border-white/25"
                      />
                    </div>
                    {/* System prompt */}
                    <div className="p-3.5 flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold">System Prompt</div>
                        <div className="text-[11px] text-white/45">Kepribadian / gaya jawaban agent</div>
                      </div>
                      <textarea
                        value={settings.agentSystemPrompt}
                        onChange={(e) => update({ agentSystemPrompt: e.target.value })}
                        rows={3}
                        className="w-72 rounded-lg border border-white/10 bg-white/[0.05] px-2.5 py-1.5 text-[12px] text-white/90 outline-none resize-none focus:border-white/25"
                      />
                    </div>
                  </div>
                </section>
              </>
            )}

            {/* TAB: PRAYER SETTINGS */}
            {activeTab === "prayer" && (
              <>
                <section className="space-y-3">
                  <div className="bg-[#12141a] border border-white/[0.07] rounded-xl divide-y divide-white/[0.06]">
                    {/* Toggle reminder */}
                    <div className="p-3.5 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                          style={{
                            backgroundColor: `${settings.accentColor}18`,
                            color: settings.accentColor,
                          }}
                        >
                          <Compass className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <span className="text-xs font-semibold text-white">
                            Pengingat 10 Menit Sebelum Azan
                          </span>
                          <p className="text-xs text-neutral-400 truncate mt-0.5">
                            Kapsul notch berkedip + notifikasi pop-up saat 10 menit menuju waktu sholat
                          </p>
                        </div>
                      </div>
                      <ToggleSwitch
                        checked={settings.prayerReminderEnabled ?? true}
                        onChange={() =>
                          update({
                            prayerReminderEnabled: !(settings.prayerReminderEnabled ?? true),
                          })
                        }
                        accentColor={settings.accentColor}
                      />
                    </div>

                    {/* City picker */}
                    <div className="p-3.5 space-y-2">
                      <div className="text-xs font-semibold text-white">
                        Pilih Kota / Wilayah
                      </div>
                      <div className="grid grid-cols-3 gap-1.5">
                        {CITY_PRESETS.map((c) => {
                          const active = (settings.prayerCity ?? CITY_PRESETS[0].name) === c.name;
                          return (
                            <button
                              key={c.name}
                              type="button"
                              onClick={() =>
                                update({
                                  prayerCity: c.name,
                                  prayerLatitude: c.coords.latitude,
                                  prayerLongitude: c.coords.longitude,
                                  prayerTimezone: c.coords.timezone,
                                })
                              }
                              className={`p-2 rounded-lg text-left text-xs transition-colors cursor-pointer border ${
                                active
                                  ? "bg-white/[0.12] text-white border-white/25 shadow-sm"
                                  : "bg-white/[0.03] text-neutral-400 hover:text-white hover:bg-white/[0.06] border-white/[0.05]"
                              }`}
                            >
                              <div className="font-medium truncate">{c.name}</div>
                              <div className="text-[10px] text-neutral-500 font-mono mt-0.5">
                                UTC+{c.coords.timezone}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      <p className="text-[11px] text-neutral-500 mt-2">
                        Perhitungan hisab Kemenag RI (+2 menit ihtiyati) berjalan lokal tanpa internet.
                      </p>
                    </div>
                  </div>
                </section>
              </>
            )}

            {/* TAB 5: MEDIA INTEGRATION */}
            {activeTab === "integrations" && (
              <section className="bg-[#12141a] border border-white/[0.07] rounded-xl divide-y divide-white/[0.06]">
                <div className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center"
                      style={{
                        backgroundColor: `${settings.accentColor}18`,
                        color: settings.accentColor,
                      }}
                    >
                      <Volume2 className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-white">
                        Windows GSMTC Media Session
                      </div>
                      <div className="text-xs text-neutral-400">
                        Kontrol pemutaran native untuk Spotify, Browser, dan
                        Apple Music
                      </div>
                    </div>
                  </div>
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Terhubung
                  </span>
                </div>

                <div className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center"
                      style={{
                        backgroundColor: `${settings.accentColor}18`,
                        color: settings.accentColor,
                      }}
                    >
                      <Radio className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-white">
                        Spicetify Local Bridge (Port 4545)
                      </div>
                      <div className="text-xs text-neutral-400">
                        Sinkronisasi antrean lagu & sampul resolusi tinggi
                        real-time
                      </div>
                    </div>
                  </div>
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Aktif
                  </span>
                </div>

                <div className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center"
                      style={{
                        backgroundColor: `${settings.accentColor}18`,
                        color: settings.accentColor,
                      }}
                    >
                      <Music2 className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-white">
                        LRCLIB Synced Lyrics Engine
                      </div>
                      <div className="text-xs text-neutral-400">
                        Pencarian lirik otomatis berbasis timestamp presisi
                        milidetik
                      </div>
                    </div>
                  </div>
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Siap
                  </span>
                </div>
              </section>
            )}

            {/* TAB 6: SYSTEM & STARTUP */}
            {activeTab === "system" && (
              <section className="bg-[#12141a] border border-white/[0.07] rounded-xl divide-y divide-white/[0.06]">
                {/* Startup Toggle Row */}
                <div className="p-4 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                      style={{
                        backgroundColor: `${settings.accentColor}18`,
                        color: settings.accentColor,
                      }}
                    >
                      <Power className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold text-white">
                          Jalankan Otomatis saat Login Windows
                        </span>
                        <InfoPopover
                          title="Mekanisme Startup Windows"
                          lines={[
                            "Mendaftarkan aplikasi pada HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run tanpa membutuhkan akses Administrator (UAC).",
                          ]}
                        />
                      </div>
                      <p className="text-xs text-neutral-400 truncate mt-0.5">
                        Aktifkan Notch secara otomatis di latar belakang setiap
                        komputer menyala
                      </p>
                    </div>
                  </div>

                  <ToggleSwitch
                    checked={autostartEnabled}
                    disabled={isLoadingAutostart}
                    onChange={toggleAutostart}
                    accentColor={settings.accentColor}
                  />
                </div>

                {/* Single-Instance & Memory Guard Row */}
                <div className="p-4 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                      style={{
                        backgroundColor: `${settings.accentColor}18`,
                        color: settings.accentColor,
                      }}
                    >
                      <Cpu className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-white">
                        Single-Instance Mutex & Memory Trim
                      </div>
                      <div className="text-xs text-neutral-400 mt-0.5">
                        Mencegah proses ganda dan memangkas alokasi RAM WebView2
                        secara otomatis
                      </div>
                    </div>
                  </div>
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-white/[0.06] text-neutral-300">
                    Terlindungi
                  </span>
                </div>
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
