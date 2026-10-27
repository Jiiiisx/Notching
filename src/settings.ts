export interface NotchSettings {
  // Typography
  fontSizeScale: number; // 0.85 to 1.30, default 1.0
  fontWeight: "300" | "400" | "500" | "600" | "700" | "800"; // Light to Extrabold

  // Colors & Appearance
  bgColor: string; // Hex, default #000000
  bgOpacity: number; // 40 to 100, default 95
  textColor: string; // Hex, default #ffffff
  accentColor: string; // Hex, default #10b981 (emerald)
  borderColor: string; // Hex, default #ffffff
  borderOpacity: number; // 0 to 100, default 10
  borderRadius: number; // 12 to 30px, default 22

  // Motion & Lyrics
  springBounciness: number; // 18 to 35, default 26
  leadTime: number; // 0.0 to 1.0s, default 0.3

  // Display & Multi-monitor
  targetMonitor: string; // 'primary' or display name
  gameModeAutoShift: boolean; // Auto-shift to secondary monitor or hide during fullscreen games

  // Behavior & Sizing
  compactMode: boolean; // Manual compact pill mode (22px high, 110px wide)
  smartTabAvoidance: boolean; // Auto-compact when browser or IDE is maximized
}

export interface MonitorOption {
  id: string;
  label: string;
  is_primary: boolean;
  width: number;
  height: number;
  scale_factor: number;
}

export const DEFAULT_NOTCH_SETTINGS: NotchSettings = {
  fontSizeScale: 1.0,
  fontWeight: "600",
  bgColor: "#000000",
  bgOpacity: 95,
  textColor: "#ffffff",
  accentColor: "#10b981",
  borderColor: "#ffffff",
  borderOpacity: 10,
  borderRadius: 22,
  springBounciness: 26,
  leadTime: 0.3,
  targetMonitor: "primary",
  gameModeAutoShift: true,
  compactMode: false,
  smartTabAvoidance: true,
};

const STORAGE_KEY = "notch_custom_settings";

export function loadSettings(): NotchSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return { ...DEFAULT_NOTCH_SETTINGS, ...JSON.parse(raw) };
    }
  } catch (e) {
    console.error("Failed to read settings from localStorage:", e);
  }
  return DEFAULT_NOTCH_SETTINGS;
}

export function saveSettings(settings: NotchSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error("Failed to save settings to localStorage:", e);
  }
}

// Convert hex (#RRGGBB) + opacity (0-100) to rgba() string
export function hexToRgba(hex: string, opacity: number): string {
  let cleaned = hex.replace("#", "");
  if (cleaned.length === 3) {
    cleaned = cleaned
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const num = parseInt(cleaned, 16);
  if (isNaN(num)) return `rgba(0, 0, 0, ${opacity / 100})`;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${(opacity / 100).toFixed(2)})`;
}
