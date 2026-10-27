import { useState, useEffect } from "react";
import {
  Palette,
  Type,
  Sliders,
  RotateCcw,
  Sparkles,
  CheckCircle2,
  Volume2,
  Monitor,
  RefreshCw,
  Gamepad2,
  Minimize2,
  AppWindow,
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

const FONT_WEIGHTS: Array<{ label: string; value: NotchSettings["fontWeight"] }> = [
  { label: "Tipis (300)", value: "300" },
  { label: "Normal (400)", value: "400" },
  { label: "Medium (500)", value: "500" },
  { label: "Semibold (600)", value: "600" },
  { label: "Tebal (700)", value: "700" },
  { label: "Extra (800)", value: "800" },
];

export default function SettingsApp() {
  const [activeTab, setActiveTab] = useState<"appearance" | "typography" | "display" | "motion" | "integrations">("display");
  const [settings, setSettings] = useState<NotchSettings>(loadSettings);
  const [monitors, setMonitors] = useState<MonitorOption[]>([]);
  const [isRefreshingMonitors, setIsRefreshingMonitors] = useState(false);

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
      setTimeout(() => setIsRefreshingMonitors(false), 300);
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

  const handleReset = () => {
    setSettings(DEFAULT_NOTCH_SETTINGS);
    saveSettings(DEFAULT_NOTCH_SETTINGS);
    emit("notch-settings-update", DEFAULT_NOTCH_SETTINGS).catch(() => {});
  };

  useEffect(() => {
    fetchMonitors();
    emit("notch-settings-update", settings).catch(() => {});
  }, []);

  return (
    <div className="w-screen h-screen bg-neutral-950 text-neutral-100 flex flex-col select-none font-sans overflow-hidden">
      {/* Top Header & Live Preview */}
      <div className="h-16 border-b border-white/10 px-6 flex items-center justify-between shrink-0 bg-neutral-900/60 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
            style={{ backgroundColor: `${settings.accentColor}25`, color: settings.accentColor }}
          >
            <Sliders className="w-4 h-4" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-wide text-white">Notch Settings</h1>
            <p className="text-[11px] text-neutral-400">Pengaturan font, warna, dan tampilan notch</p>
          </div>
        </div>

        {/* Live Mini Preview */}
        <div className="flex items-center gap-3">
          <div
            className="px-3.5 py-1.5 flex items-center gap-2 border shadow-sm transition-all"
            style={{
              backgroundColor: hexToRgba(settings.bgColor, settings.bgOpacity),
              borderColor: hexToRgba(settings.borderColor, settings.borderOpacity),
              borderRadius: `${settings.borderRadius}px`,
              color: settings.textColor,
              fontWeight: Number(settings.fontWeight),
              fontSize: `${11 * settings.fontSizeScale}px`,
            }}
          >
            <span
              className="w-2 h-2 rounded-full inline-block"
              style={{ backgroundColor: settings.accentColor }}
            />
            <span>Preview Notch</span>
          </div>

          <button
            onClick={handleReset}
            title="Reset ke Bawaan"
            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-neutral-400 hover:text-white transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar Nav */}
        <div className="w-48 border-r border-white/10 p-3 space-y-1 shrink-0 bg-neutral-900/30">
          <button
            onClick={() => setActiveTab("display")}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
              activeTab === "display"
                ? "bg-white/10 text-white border border-white/15"
                : "text-neutral-400 hover:text-white hover:bg-white/5"
            }`}
          >
            <Monitor className="w-4 h-4" style={{ color: settings.accentColor }} />
            Layar & Monitor
          </button>

          <button
            onClick={() => setActiveTab("appearance")}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
              activeTab === "appearance"
                ? "bg-white/10 text-white border border-white/15"
                : "text-neutral-400 hover:text-white hover:bg-white/5"
            }`}
          >
            <Palette className="w-4 h-4" style={{ color: settings.accentColor }} />
            Warna & Notch
          </button>

          <button
            onClick={() => setActiveTab("typography")}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
              activeTab === "typography"
                ? "bg-white/10 text-white border border-white/15"
                : "text-neutral-400 hover:text-white hover:bg-white/5"
            }`}
          >
            <Type className="w-4 h-4" style={{ color: settings.accentColor }} />
            Ukuran & Tebal Font
          </button>

          <button
            onClick={() => setActiveTab("motion")}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
              activeTab === "motion"
                ? "bg-white/10 text-white border border-white/15"
                : "text-neutral-400 hover:text-white hover:bg-white/5"
            }`}
          >
            <Sparkles className="w-4 h-4" style={{ color: settings.accentColor }} />
            Animasi & Lirik
          </button>

          <button
            onClick={() => setActiveTab("integrations")}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
              activeTab === "integrations"
                ? "bg-white/10 text-white border border-white/15"
                : "text-neutral-400 hover:text-white hover:bg-white/5"
            }`}
          >
            <Volume2 className="w-4 h-4" style={{ color: settings.accentColor }} />
            Integrasi
          </button>
        </div>

        {/* Content Panel */}
        <div className="flex-1 p-6 overflow-y-auto space-y-6">
          {/* TAB 0: DISPLAY & MONITORS */}
          {activeTab === "display" && (
            <div className="space-y-5 max-w-lg">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-medium text-white">Pilih Monitor Notch</div>
                  <div className="text-[11px] text-neutral-400 mt-0.5">
                    Tentukan layar di mana notch akan ditampilkan
                  </div>
                </div>
                <button
                  onClick={fetchMonitors}
                  disabled={isRefreshingMonitors}
                  title="Deteksi ulang layar"
                  className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-lg bg-white/5 hover:bg-white/10 text-neutral-300 hover:text-white transition-all disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${isRefreshingMonitors ? "animate-spin" : ""}`} />
                  <span>Pindai Ulang</span>
                </button>
              </div>

              {/* Safe Fallback Info Banner */}
              <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3.5 flex items-start gap-3">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <div className="text-[11px] text-neutral-300 leading-relaxed">
                  <span className="font-semibold text-emerald-300">Aman saat kabel dicabut: </span>
                  Jika kamu memilih monitor eksternal lalu mencabutnya, Notch secara otomatis <strong>fallback ke layar utama laptop</strong>. Pengaturan tidak rusak dan tidak akan hilang.
                </div>
              </div>

              {/* Monitor Cards List */}
              <div className="space-y-2.5">
                {monitors.map((m) => {
                  const isSelected =
                    m.id === "primary"
                      ? !settings.targetMonitor || settings.targetMonitor === "primary"
                      : settings.targetMonitor === m.id;

                  return (
                    <div
                      key={m.id}
                      onClick={() => update({ targetMonitor: m.id })}
                      className={`cursor-pointer rounded-xl p-3.5 border transition-all flex items-center justify-between ${
                        isSelected
                          ? "bg-white/10 border-emerald-500/60 shadow-sm"
                          : "bg-neutral-900/40 border-white/5 hover:border-white/15 hover:bg-white/5"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                            isSelected
                              ? "bg-emerald-500/20 text-emerald-400"
                              : "bg-white/5 text-neutral-400"
                          }`}
                        >
                          <Monitor className="w-4 h-4" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-white">
                              {m.id === "primary" ? "Auto-Follow (Layar Utama)" : m.label}
                            </span>
                            {m.is_primary && (
                              <span className="px-1.5 py-0.5 text-[9px] rounded bg-white/10 text-neutral-300 font-mono">
                                Primary
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-neutral-400 mt-0.5 font-mono">
                            {m.width} x {m.height} px • DPI {(m.scale_factor * 100).toFixed(0)}%
                          </div>
                        </div>
                      </div>

                      <div
                        className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                          isSelected
                            ? "border-emerald-500 bg-emerald-500 text-black"
                            : "border-white/20"
                        }`}
                      >
                        {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-black" />}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Game Mode / Fullscreen Auto-Avoidance */}
              <div className="pt-3 border-t border-white/10 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
                      <Gamepad2 className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-white">Game Mode & Auto-Avoidance</div>
                      <div className="text-[11px] text-neutral-400 mt-0.5">
                        Otomatis pindah layar atau bersembunyi saat bermain game
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => update({ gameModeAutoShift: !(settings.gameModeAutoShift ?? true) })}
                    className={`w-11 h-6 rounded-full transition-colors relative p-0.5 ${
                      settings.gameModeAutoShift ?? true ? "bg-emerald-500" : "bg-neutral-800"
                    }`}
                  >
                    <div
                      className={`w-5 h-5 rounded-full bg-white transition-transform ${
                        settings.gameModeAutoShift ?? true ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>

                <div className="p-3 rounded-xl bg-neutral-900/60 border border-white/5 space-y-2 text-[11px] text-neutral-300">
                  <div className="flex items-start gap-2">
                    <span className="font-semibold text-white shrink-0">• 2 Monitor:</span>
                    <span>Saat membuka game fullscreen (Valorant, CS, dll), Notch otomatis <strong>pindah ke monitor kedua</strong> agar musik/lirik tetap terlihat tanpa menghalangi crosshair atau HUD game.</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="font-semibold text-white shrink-0">• 1 Monitor:</span>
                    <span>Jika hanya menggunakan 1 monitor, Notch otomatis <strong>bersembunyi (hide)</strong> selama game aktif dan muncul kembali saat alt-tab atau game ditutup.</span>
                  </div>
                </div>
              </div>

              {/* Compact Pill Mode */}
              <div className="pt-3 border-t border-white/10 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-sky-500/10 text-sky-400 flex items-center justify-center">
                      <Minimize2 className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-white">Mode Compact Pill (Minimalis)</div>
                      <div className="text-[11px] text-neutral-400 mt-0.5">
                        Kapsul menciut jadi 114x22px (Double-Click pada notch untuk toggle cepat)
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => update({ compactMode: !settings.compactMode })}
                    className={`w-11 h-6 rounded-full transition-colors relative p-0.5 ${
                      settings.compactMode ? "bg-sky-500" : "bg-neutral-800"
                    }`}
                  >
                    <div
                      className={`w-5 h-5 rounded-full bg-white transition-transform ${
                        settings.compactMode ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
              </div>

              {/* Smart Tab Avoidance */}
              <div className="pt-3 border-t border-white/10 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center">
                      <AppWindow className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-white">Smart Tab Avoidance</div>
                      <div className="text-[11px] text-neutral-400 mt-0.5">
                        Otomatis menciutkan notch saat tab browser meluas ke belakang notch
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => update({ smartTabAvoidance: !(settings.smartTabAvoidance ?? true) })}
                    className={`w-11 h-6 rounded-full transition-colors relative p-0.5 ${
                      settings.smartTabAvoidance ?? true ? "bg-indigo-500" : "bg-neutral-800"
                    }`}
                  >
                    <div
                      className={`w-5 h-5 rounded-full bg-white transition-transform ${
                        settings.smartTabAvoidance ?? true ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>

                <div className="p-3 rounded-xl bg-neutral-900/60 border border-white/5 space-y-1.5 text-[11px] text-neutral-300">
                  <div className="text-neutral-200">
                    Notch tetap berada di layarnya dan <strong>hanya menciut jadi 114x22px</strong> saat jumlah tab browser sudah banyak dan menabrak area notch, sehingga header tab tetap bebas diklik. Notch <strong>tidak berpindah layar</strong> di mode ini.
                  </div>
                  <div className="text-neutral-400 text-[10px]">
                    *Notch baru berpindah ke monitor cadangan (atau bersembunyi) saat mendeteksi <strong>game fullscreen</strong>.
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 1: APPEARANCE & COLORS */}
          {activeTab === "appearance" && (
            <div className="space-y-6 max-w-lg">
              {/* Background Color */}
              <div className="bg-neutral-900/50 border border-white/5 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium text-white">Warna Background Notch</div>
                    <div className="text-[11px] text-neutral-400">Pilih warna dasar latar belakang jendela notch</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={settings.bgColor}
                      onChange={(e) => update({ bgColor: e.target.value })}
                      className="w-7 h-7 rounded border border-white/20 bg-transparent cursor-pointer"
                    />
                    <span className="text-[11px] font-mono text-neutral-300">{settings.bgColor}</span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 pt-1">
                  {BG_PRESETS.map((p) => (
                    <button
                      key={p.hex}
                      onClick={() => update({ bgColor: p.hex })}
                      className={`px-2.5 py-1 text-[10px] rounded border transition-all ${
                        settings.bgColor === p.hex
                          ? "border-emerald-500 bg-emerald-500/20 text-white font-medium"
                          : "border-white/10 bg-white/5 text-neutral-400 hover:text-white"
                      }`}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Background Opacity */}
              <div className="bg-neutral-900/50 border border-white/5 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium text-white">Transparansi Background (Opacity)</div>
                    <div className="text-[11px] text-neutral-400">Efek transparansi kaca notch ({settings.bgOpacity}%)</div>
                  </div>
                  <span className="text-xs font-mono text-emerald-400">{settings.bgOpacity}%</span>
                </div>
                <input
                  type="range"
                  min="40"
                  max="100"
                  value={settings.bgOpacity}
                  onChange={(e) => update({ bgOpacity: Number(e.target.value) })}
                  className="w-full accent-emerald-500"
                />
              </div>

              {/* Accent Color */}
              <div className="bg-neutral-900/50 border border-white/5 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium text-white">Warna Aksen / Highlight</div>
                    <div className="text-[11px] text-neutral-400">Warna equalizer bar, progress bar, dan tombol aktif</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={settings.accentColor}
                      onChange={(e) => update({ accentColor: e.target.value })}
                      className="w-7 h-7 rounded border border-white/20 bg-transparent cursor-pointer"
                    />
                    <span className="text-[11px] font-mono text-neutral-300">{settings.accentColor}</span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 pt-1">
                  {ACCENT_PRESETS.map((p) => (
                    <button
                      key={p.hex}
                      onClick={() => update({ accentColor: p.hex })}
                      className={`px-2.5 py-1 text-[10px] rounded border transition-all ${
                        settings.accentColor === p.hex
                          ? "border-emerald-500 bg-emerald-500/20 text-white font-medium"
                          : "border-white/10 bg-white/5 text-neutral-400 hover:text-white"
                      }`}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Corner Radius & Border */}
              <div className="bg-neutral-900/50 border border-white/5 rounded-xl p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium text-white">Lengkungan Sudut (Corner Radius)</div>
                    <div className="text-[11px] text-neutral-400">Bentuk lengkungan sudut notch</div>
                  </div>
                  <span className="text-xs font-mono text-emerald-400">{settings.borderRadius}px</span>
                </div>
                <input
                  type="range"
                  min="12"
                  max="30"
                  value={settings.borderRadius}
                  onChange={(e) => update({ borderRadius: Number(e.target.value) })}
                  className="w-full accent-emerald-500"
                />

                <div className="border-t border-white/5 pt-3 flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium text-white">Opasitas Garis Border</div>
                    <div className="text-[11px] text-neutral-400">Kilau garis batas pinggir notch</div>
                  </div>
                  <span className="text-xs font-mono text-emerald-400">{settings.borderOpacity}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="50"
                  value={settings.borderOpacity}
                  onChange={(e) => update({ borderOpacity: Number(e.target.value) })}
                  className="w-full accent-emerald-500"
                />
              </div>
            </div>
          )}

          {/* TAB 2: TYPOGRAPHY */}
          {activeTab === "typography" && (
            <div className="space-y-6 max-w-lg">
              {/* Font Weight */}
              <div className="bg-neutral-900/50 border border-white/5 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium text-white">Ketebalan Font (Weight)</div>
                    <div className="text-[11px] text-neutral-400">Dari ultra tipis (300) sampai tebal padat (800)</div>
                  </div>
                  <span className="text-xs font-mono text-emerald-400 font-bold">
                    {settings.fontWeight}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 pt-1">
                  {FONT_WEIGHTS.map((fw) => (
                    <button
                      key={fw.value}
                      onClick={() => update({ fontWeight: fw.value })}
                      className={`px-3 py-2 rounded-lg border text-xs transition-all ${
                        settings.fontWeight === fw.value
                          ? "border-emerald-500 bg-emerald-500/20 text-white font-semibold"
                          : "border-white/10 bg-white/5 text-neutral-400 hover:text-white"
                      }`}
                      style={{ fontWeight: Number(fw.value) }}
                    >
                      {fw.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Font Scale */}
              <div className="bg-neutral-900/50 border border-white/5 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium text-white">Ukuran Teks (Font Size)</div>
                    <div className="text-[11px] text-neutral-400">Memperbesar atau memperkecil teks notch</div>
                  </div>
                  <span className="text-xs font-mono text-emerald-400">
                    {Math.round(settings.fontSizeScale * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0.80"
                  max="1.30"
                  step="0.05"
                  value={settings.fontSizeScale}
                  onChange={(e) => update({ fontSizeScale: Number(e.target.value) })}
                  className="w-full accent-emerald-500"
                />
                <div className="flex justify-between text-[10px] text-neutral-500 px-0.5">
                  <span>80% (Kompak)</span>
                  <span>100% (Standar)</span>
                  <span>130% (Besar)</span>
                </div>
              </div>

              {/* Text Color */}
              <div className="bg-neutral-900/50 border border-white/5 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium text-white">Warna Teks Utama</div>
                    <div className="text-[11px] text-neutral-400">Warna judul lagu dan lirik aktif</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={settings.textColor}
                      onChange={(e) => update({ textColor: e.target.value })}
                      className="w-7 h-7 rounded border border-white/20 bg-transparent cursor-pointer"
                    />
                    <span className="text-[11px] font-mono text-neutral-300">{settings.textColor}</span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 pt-1">
                  {TEXT_PRESETS.map((p) => (
                    <button
                      key={p.hex}
                      onClick={() => update({ textColor: p.hex })}
                      className={`px-2.5 py-1 text-[10px] rounded border transition-all ${
                        settings.textColor === p.hex
                          ? "border-emerald-500 bg-emerald-500/20 text-white font-medium"
                          : "border-white/10 bg-white/5 text-neutral-400 hover:text-white"
                      }`}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: MOTION & LYRICS */}
          {activeTab === "motion" && (
            <div className="space-y-6 max-w-lg">
              <div className="bg-neutral-900/50 border border-white/5 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium text-white">Lead Time Sinkronisasi Lirik</div>
                    <div className="text-[11px] text-neutral-400">Kompensasi vokal mendahului timeline audio</div>
                  </div>
                  <span className="text-xs font-mono text-emerald-400">+{settings.leadTime.toFixed(1)}s</span>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="1.0"
                  step="0.1"
                  value={settings.leadTime}
                  onChange={(e) => update({ leadTime: Number(e.target.value) })}
                  className="w-full accent-emerald-500"
                />
              </div>

              <div className="bg-neutral-900/50 border border-white/5 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium text-white">Spring Damping (Kelenturan)</div>
                    <div className="text-[11px] text-neutral-400">Mengatur seberapa cepat atau membal animasi notch</div>
                  </div>
                  <span className="text-xs font-mono text-emerald-400">{settings.springBounciness}</span>
                </div>
                <input
                  type="range"
                  min="18"
                  max="35"
                  value={settings.springBounciness}
                  onChange={(e) => update({ springBounciness: Number(e.target.value) })}
                  className="w-full accent-emerald-500"
                />
              </div>
            </div>
          )}

          {/* TAB 4: INTEGRATIONS */}
          {activeTab === "integrations" && (
            <div className="space-y-4 max-w-lg">
              <div className="bg-neutral-900/50 border border-white/5 rounded-xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Volume2 className="w-4 h-4 text-emerald-400" />
                  <div>
                    <div className="text-xs font-medium text-white">Windows GSMTC (WinRT)</div>
                    <div className="text-[11px] text-neutral-400">Active media, timeline & controls</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 text-[11px] text-emerald-400 font-mono">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Ready
                </div>
              </div>

              <div className="bg-neutral-900/50 border border-white/5 rounded-xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Sparkles className="w-4 h-4 text-emerald-400" />
                  <div>
                    <div className="text-xs font-medium text-white">Spicetify Local Bridge</div>
                    <div className="text-[11px] text-neutral-400">Real-time Spotify Queue (Port 4545)</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 text-[11px] text-emerald-400 font-mono">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Active
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
