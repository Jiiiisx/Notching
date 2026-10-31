import { useState } from "react";
import { Bell, Laptop, Smartphone, Trash2, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { NotchNotification } from "./settings";

interface NotificationCenterProps {
  notifications: NotchNotification[];
  onDismiss: (id: number) => void;
  onClearAll: () => void;
  accentColor: string;
  fontSizeScale?: number;
}

function formatRelativeTime(timestampMs: number): string {
  if (!timestampMs) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (diffSec < 45) return "Baru saja";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m lalu`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) {
    const d = new Date(timestampMs);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  const d = new Date(timestampMs);
  return `${d.getDate()}/${d.getMonth() + 1} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function NotificationCenter({
  notifications,
  onDismiss,
  onClearAll,
  accentColor,
  fontSizeScale = 1.0,
}: NotificationCenterProps) {
  const [filter, setFilter] = useState<"all" | "phone" | "laptop">("all");

  const phoneCount = notifications.filter((n) => n.source === "phone").length;
  const laptopCount = notifications.filter((n) => n.source === "laptop").length;

  const filtered = notifications.filter((n) => {
    if (filter === "phone") return n.source === "phone";
    if (filter === "laptop") return n.source === "laptop";
    return true;
  });

  return (
    <div className="flex flex-col h-full justify-between gap-1.5 overflow-hidden select-none px-3">
      {/* Top Filter & Action Bar */}
      <div className="flex items-center justify-between gap-2 pb-1 border-b border-white/5 shrink-0">
        <div className="flex items-center gap-1 bg-white/[0.04] p-0.5 rounded-lg border border-white/[0.05]">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setFilter("all");
            }}
            className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
              filter === "all"
                ? "bg-white/15 text-white shadow-xs"
                : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            Semua ({notifications.length})
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setFilter("phone");
            }}
            className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
              filter === "phone"
                ? "bg-white/15 text-white shadow-xs"
                : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            <Smartphone className="w-2.5 h-2.5" style={{ color: accentColor }} />
            <span>HP ({phoneCount})</span>
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setFilter("laptop");
            }}
            className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
              filter === "laptop"
                ? "bg-white/15 text-white shadow-xs"
                : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            <Laptop className="w-2.5 h-2.5 text-sky-400" />
            <span>Laptop ({laptopCount})</span>
          </button>
        </div>

        {notifications.length > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClearAll();
            }}
            title="Bersihkan semua riwayat notifikasi"
            className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono text-neutral-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3 h-3" />
            <span>Bersihkan</span>
          </button>
        )}
      </div>

      {/* Scrollable Notification Cards */}
      <div
        data-scrollable="true"
        className="notif-scroll flex-1 overflow-y-auto pr-0.5 space-y-1.5 max-h-[148px] no-scrollbar"
        style={{ scrollbarWidth: "none" }}
      >
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full py-4 text-neutral-500 gap-2">
            <Bell className="w-5 h-5 text-neutral-600" />
            <span
              className="text-xs font-mono text-center"
              style={{ fontSize: `${11.5 * fontSizeScale}px` }}
            >
              {filter === "phone"
                ? "Belum ada notifikasi dari HP (Phone Link)"
                : filter === "laptop"
                  ? "Belum ada notifikasi dari aplikasi Laptop"
                  : "Belum ada notifikasi masuk"}
            </span>
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  invoke("trigger_test_notification", { source: "phone" }).catch(() => {});
                }}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-neutral-300 hover:text-white transition-colors cursor-pointer"
              >
                <Smartphone className="w-3 h-3" style={{ color: accentColor }} />
                <span>Tes Notif HP</span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  invoke("trigger_test_notification", { source: "laptop" }).catch(() => {});
                }}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-neutral-300 hover:text-white transition-colors cursor-pointer"
              >
                <Laptop className="w-3 h-3 text-sky-400" />
                <span>Tes Notif PC</span>
              </button>
            </div>
          </div>
        ) : (
          filtered.map((item) => {
            const isPhone = item.source === "phone";
            return (
              <div
                key={item.id}
                onClick={(e) => e.stopPropagation()}
                className="group flex items-start justify-between gap-2.5 px-2.5 py-1.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.05] transition-all"
              >
                {/* Source Icon Badge */}
                <div
                  className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5 border border-white/10"
                  style={{
                    backgroundColor: isPhone ? `${accentColor}1a` : "rgba(56, 189, 248, 0.12)",
                  }}
                >
                  {isPhone ? (
                    <Smartphone
                      className="w-3.5 h-3.5"
                      style={{ color: accentColor }}
                    />
                  ) : (
                    <Laptop className="w-3.5 h-3.5 text-sky-400" />
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0 flex flex-col">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="text-[11px] font-mono uppercase tracking-wider px-1.5 py-0.2 rounded bg-white/[0.06] font-semibold truncate"
                        style={{ color: isPhone ? accentColor : "#38bdf8" }}
                      >
                        {isPhone ? "HP" : "PC"} • {item.app_name}
                      </span>
                      <span
                        className="font-semibold text-neutral-100 truncate"
                        style={{ fontSize: `${11.5 * fontSizeScale}px` }}
                      >
                        {item.title}
                      </span>
                    </div>

                    <span className="text-[10.5px] font-mono text-neutral-500 shrink-0 tabular-nums">
                      {formatRelativeTime(item.timestamp_ms)}
                    </span>
                  </div>

                  {item.body && (
                    <p
                      className="text-neutral-400 truncate mt-0.5 leading-snug"
                      style={{ fontSize: `${11 * fontSizeScale}px` }}
                      title={item.body}
                    >
                      {item.body}
                    </p>
                  )}
                </div>

                {/* Dismiss Button */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDismiss(item.id);
                  }}
                  title="Hapus notifikasi ini"
                  className="opacity-0 group-hover:opacity-100 p-1 rounded text-neutral-500 hover:text-rose-400 hover:bg-rose-500/10 transition-all shrink-0 cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
