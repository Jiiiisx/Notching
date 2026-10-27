import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Cpu,
  HardDrive,
  Wifi,
  ArrowDown,
  ArrowUp,
  Activity,
  Clock,
} from "lucide-react";

export interface SystemStats {
  cpu_usage: number;
  ram_total_mb: number;
  ram_used_mb: number;
  ram_avail_mb: number;
  ram_percent: number;
  gpu_name: string;
  vram_total_mb: number;
  vram_used_mb: number;
  vram_percent: number;
  net_down_bps: number;
  net_up_bps: number;
  uptime_secs: number;
}

interface PerformanceHUDProps {
  isActive: boolean;
  accentColor?: string;
}

function formatSpeed(bytesPerSec: number): { value: string; unit: string } {
  if (bytesPerSec < 1024) {
    return { value: bytesPerSec.toFixed(0), unit: "B/s" };
  } else if (bytesPerSec < 1024 * 1024) {
    return { value: (bytesPerSec / 1024).toFixed(1), unit: "KB/s" };
  } else if (bytesPerSec < 1024 * 1024 * 1024) {
    return { value: (bytesPerSec / (1024 * 1024)).toFixed(1), unit: "MB/s" };
  } else {
    return { value: (bytesPerSec / (1024 * 1024 * 1024)).toFixed(2), unit: "GB/s" };
  }
}

function formatUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export const PerformanceHUD: React.FC<PerformanceHUDProps> = ({
  isActive,
  accentColor = "#10b981",
}) => {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [cpuHistory, setCpuHistory] = useState<number[]>([
    15, 20, 25, 22, 30, 28, 25, 32, 20, 24, 28, 25,
  ]);

  useEffect(() => {
    if (!isActive) return;

    let mounted = true;

    const fetchStats = async () => {
      try {
        const data = await invoke<SystemStats>("get_system_stats");
        if (!mounted) return;
        setStats(data);
        setCpuHistory((prev) => {
          const next = [...prev.slice(1), data.cpu_usage];
          return next;
        });
      } catch (err) {
        console.error("Failed to fetch system stats:", err);
      }
    };

    // Initial fetch immediately
    fetchStats();

    // 1-second interval for real-time responsiveness
    const timer = setInterval(fetchStats, 1000);

    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [isActive]);

  const down = formatSpeed(stats?.net_down_bps ?? 0);
  const up = formatSpeed(stats?.net_up_bps ?? 0);

  // Sparkline coordinates calculation
  const sparklinePoints = React.useMemo(() => {
    const width = 80;
    const height = 24;
    const len = cpuHistory.length;
    if (len < 2) return "";
    return cpuHistory
      .map((val, idx) => {
        const x = (idx / (len - 1)) * width;
        const normalized = Math.min(100, Math.max(0, val));
        const y = height - (normalized / 100) * height;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [cpuHistory]);

  const sparklineArea = React.useMemo(() => {
    if (!sparklinePoints) return "";
    return `0,24 ${sparklinePoints} 80,24`;
  }, [sparklinePoints]);

  const ramUsedGb = stats ? (stats.ram_used_mb / 1024).toFixed(1) : "0.0";
  const ramTotalGb = stats ? (stats.ram_total_mb / 1024).toFixed(1) : "0.0";
  const vramTotalGb = stats && stats.vram_total_mb > 0 ? (stats.vram_total_mb / 1024).toFixed(1) : "2.0";

  return (
    <div className="w-full h-full flex flex-col justify-between select-none px-1">
      {/* 2x2 Bento Grid */}
      <div className="grid grid-cols-2 gap-2.5 w-full flex-1">
        {/* Card 1: CPU */}
        <div className="bg-white/[0.04] border border-white/[0.08] hover:border-white/[0.14] rounded-xl p-2.5 flex flex-col justify-between transition-colors shadow-sm relative overflow-hidden group">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-white/50 group-hover:text-white/80 transition-colors" />
              <span className="text-[10px] font-semibold tracking-wider text-white/60 uppercase">
                CPU
              </span>
            </div>
            <span className="text-[9px] font-mono text-white/40">Load</span>
          </div>

          <div className="flex items-end justify-between mt-1">
            <div className="flex items-baseline gap-0.5">
              <span className="text-xl font-bold font-mono text-white tracking-tight">
                {stats ? stats.cpu_usage.toFixed(0) : "0"}
              </span>
              <span className="text-[11px] font-mono text-white/50">%</span>
            </div>

            {/* Mini Sparkline Chart */}
            <div className="w-20 h-6 relative">
              <svg className="w-full h-full overflow-visible" viewBox="0 0 80 24">
                <defs>
                  <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={accentColor} stopOpacity="0.35" />
                    <stop offset="100%" stopColor={accentColor} stopOpacity="0.0" />
                  </linearGradient>
                </defs>
                {sparklineArea && (
                  <polygon points={sparklineArea} fill="url(#cpuGrad)" />
                )}
                {sparklinePoints && (
                  <polyline
                    fill="none"
                    stroke={accentColor}
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    points={sparklinePoints}
                  />
                )}
              </svg>
            </div>
          </div>
        </div>

        {/* Card 2: Memory (RAM) */}
        <div className="bg-white/[0.04] border border-white/[0.08] hover:border-white/[0.14] rounded-xl p-2.5 flex flex-col justify-between transition-colors shadow-sm relative overflow-hidden group">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <HardDrive className="w-3.5 h-3.5 text-white/50 group-hover:text-white/80 transition-colors" />
              <span className="text-[10px] font-semibold tracking-wider text-white/60 uppercase">
                RAM
              </span>
            </div>
            <span className="text-[9px] font-mono text-white/40">
              {ramUsedGb}/{ramTotalGb} GB
            </span>
          </div>

          <div className="mt-1">
            <div className="flex items-baseline justify-between mb-1.5">
              <div className="flex items-baseline gap-0.5">
                <span className="text-xl font-bold font-mono text-white tracking-tight">
                  {stats ? stats.ram_percent.toFixed(0) : "0"}
                </span>
                <span className="text-[11px] font-mono text-white/50">%</span>
              </div>
              <span className="text-[9px] font-mono text-white/40">
                {stats ? (stats.ram_avail_mb / 1024).toFixed(1) : "0"} GB free
              </span>
            </div>

            {/* RAM Progress Bar */}
            <div className="w-full h-1.5 bg-white/[0.08] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500 ease-out"
                style={{
                  width: `${Math.min(100, stats?.ram_percent ?? 0)}%`,
                  backgroundColor:
                    (stats?.ram_percent ?? 0) > 85 ? "#ef4444" : accentColor,
                }}
              />
            </div>
          </div>
        </div>

        {/* Card 3: Network / Wi-Fi Speed */}
        <div className="bg-white/[0.04] border border-white/[0.08] hover:border-white/[0.14] rounded-xl p-2.5 flex flex-col justify-between transition-colors shadow-sm relative overflow-hidden group">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Wifi className="w-3.5 h-3.5 text-white/50 group-hover:text-white/80 transition-colors" />
              <span className="text-[10px] font-semibold tracking-wider text-white/60 uppercase">
                Wi-Fi / Net
              </span>
            </div>
            {/* Live activity pulse */}
            <div className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[9px] font-mono text-white/40">Live</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-1 mt-1">
            {/* Download */}
            <div className="flex flex-col">
              <div className="flex items-center gap-0.5 text-emerald-400/80">
                <ArrowDown className="w-3 h-3" />
                <span className="text-[9px] font-mono font-medium uppercase tracking-tight">
                  Down
                </span>
              </div>
              <div className="flex items-baseline gap-0.5 mt-0.5">
                <span className="text-sm font-bold font-mono text-white tracking-tight">
                  {down.value}
                </span>
                <span className="text-[9px] font-mono text-white/50">
                  {down.unit}
                </span>
              </div>
            </div>

            {/* Upload */}
            <div className="flex flex-col">
              <div className="flex items-center gap-0.5 text-sky-400/80">
                <ArrowUp className="w-3 h-3" />
                <span className="text-[9px] font-mono font-medium uppercase tracking-tight">
                  Up
                </span>
              </div>
              <div className="flex items-baseline gap-0.5 mt-0.5">
                <span className="text-sm font-bold font-mono text-white tracking-tight">
                  {up.value}
                </span>
                <span className="text-[9px] font-mono text-white/50">
                  {up.unit}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Card 4: GPU & System */}
        <div className="bg-white/[0.04] border border-white/[0.08] hover:border-white/[0.14] rounded-xl p-2.5 flex flex-col justify-between transition-colors shadow-sm relative overflow-hidden group">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-white/50 group-hover:text-white/80 transition-colors" />
              <span className="text-[10px] font-semibold tracking-wider text-white/60 uppercase">
                GPU & Uptime
              </span>
            </div>
            <div className="flex items-center gap-1 text-white/40 text-[9px] font-mono">
              <Clock className="w-2.5 h-2.5" />
              <span>{formatUptime(stats?.uptime_secs ?? 0)}</span>
            </div>
          </div>

          <div className="mt-1 flex flex-col justify-between">
            <div className="text-[11px] font-medium text-white/80 truncate">
              {stats?.gpu_name || "AMD Radeon Graphics"}
            </div>
            <div className="flex items-center justify-between mt-1 text-[10px] font-mono">
              <span className="text-white/40">VRAM Budget</span>
              <span className="text-white/80 font-semibold">{vramTotalGb} GB</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
