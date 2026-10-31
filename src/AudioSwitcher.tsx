import React, { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { motion } from "motion/react";
import { Volume2, VolumeX, Mic, Check, X, RefreshCw, Radio } from "lucide-react";

export interface AudioDeviceItem {
  id: string;
  name: string;
  is_default: boolean;
}

export interface AudioStatus {
  master_volume: number; // 0.0 - 1.0
  is_muted: boolean;
  output_devices: AudioDeviceItem[];
  input_devices: AudioDeviceItem[];
  current_output_id: string | null;
  current_output_name: string | null;
  current_input_id: string | null;
  current_input_name: string | null;
}

interface AudioSwitcherProps {
  accentColor?: string;
  fontSizeScale?: number;
  onClose: () => void;
  onStatusChange?: (status: AudioStatus) => void;
}

export const AudioSwitcher: React.FC<AudioSwitcherProps> = ({
  accentColor = "#38bdf8",
  fontSizeScale = 1,
  onClose,
  onStatusChange,
}) => {
  const [audioStatus, setAudioStatus] = useState<AudioStatus | null>(null);
  const [volume, setVolume] = useState<number>(0.5);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<"all" | "output" | "input">("all");
  const [loading, setLoading] = useState<boolean>(true);
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  const isDraggingRef = useRef<boolean>(false);

  const fetchAudioStatus = useCallback(async () => {
    try {
      setLoading(true);
      const status = await invoke<AudioStatus>("get_audio_status");
      setAudioStatus(status);
      if (!isDraggingRef.current) {
        setVolume(status.master_volume);
        setIsMuted(status.is_muted);
      }
      if (onStatusChange) onStatusChange(status);
    } catch (err) {
      console.error("Failed to get audio status:", err);
    } finally {
      setLoading(false);
    }
  }, [onStatusChange]);

  useEffect(() => {
    fetchAudioStatus();
  }, [fetchAudioStatus]);

  // Real-time synchronization with system & keyboard volume shortcuts
  useEffect(() => {
    const unlisten = listen<{
      volume: number;
      is_muted: boolean;
      output_id: string;
      output_name: string;
    }>("audio_status_changed", (event) => {
      if (!isDraggingRef.current) {
        setVolume(event.payload.volume);
        setIsMuted(event.payload.is_muted);
      }
      setAudioStatus((prev) => {
        if (!prev) return null;
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
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const handleVolumeChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVol = parseFloat(e.target.value);
    setVolume(newVol);
    if (isMuted && newVol > 0) setIsMuted(false);
    try {
      await invoke("set_master_volume", { level: newVol });
    } catch (err) {
      console.error("Failed to set master volume:", err);
    }
  };

  const handleToggleMute = async () => {
    const nextMute = !isMuted;
    setIsMuted(nextMute);
    try {
      await invoke("set_master_mute", { mute: nextMute });
    } catch (err) {
      console.error("Failed to toggle mute:", err);
    }
  };

  const handleSelectDevice = async (deviceId: string) => {
    try {
      setSwitchingId(deviceId);
      const updated = await invoke<AudioStatus>("set_default_audio_device", { deviceId });
      if (updated) {
        setAudioStatus(updated);
        onStatusChange?.(updated);
      }
      await fetchAudioStatus();
    } catch (err) {
      console.error("Failed to set default audio device:", err);
    } finally {
      setSwitchingId(null);
    }
  };

  const outputs = audioStatus?.output_devices || [];
  const inputs = audioStatus?.input_devices || [];

  const renderDeviceRow = (device: AudioDeviceItem, type: "output" | "input") => {
    const isCurrent = device.is_default;
    const isSwitching = switchingId === device.id;

    return (
      <button
        key={device.id}
        type="button"
        onClick={() => handleSelectDevice(device.id)}
        disabled={isCurrent || isSwitching}
        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-xl text-left transition-all ${
          isCurrent
            ? "bg-white/10 border border-white/15 cursor-default text-white shadow-sm"
            : "hover:bg-white/5 border border-transparent text-neutral-300 hover:text-white"
        }`}
      >
        <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
          <div
            className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 ${
              isCurrent ? "bg-white/15" : "bg-neutral-900 border border-white/5"
            }`}
          >
            {type === "output" ? (
              <Volume2
                className="w-3.5 h-3.5"
                style={{ color: isCurrent ? accentColor : "#9ca3af" }}
              />
            ) : (
              <Mic
                className="w-3.5 h-3.5"
                style={{ color: isCurrent ? accentColor : "#9ca3af" }}
              />
            )}
          </div>

          <span
            className="truncate text-xs font-medium"
            style={{ fontSize: `${12 * fontSizeScale}px` }}
          >
            {device.name}
          </span>
        </div>

        <div className="shrink-0 flex items-center gap-1.5">
          {isCurrent && (
            <span
              className="flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded-full font-semibold border"
              style={{
                backgroundColor: `${accentColor}1a`,
                borderColor: `${accentColor}40`,
                color: accentColor,
              }}
            >
              <Check className="w-3 h-3 stroke-[2.5]" />
              ACTIVE
            </span>
          )}
          {isSwitching && (
            <RefreshCw className="w-3.5 h-3.5 text-neutral-400 animate-spin" />
          )}
        </div>
      </button>
    );
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.16 }}
      className="absolute inset-0 z-40 bg-neutral-950/95 backdrop-blur-xl rounded-2xl flex flex-col p-3 border border-white/10 overflow-hidden shadow-2xl"
    >
      {/* Top Header */}
      <div className="flex items-center justify-between pb-2 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2">
          <div
            className="w-2 h-2 rounded-full shadow-[0_0_8px_rgba(255,255,255,0.4)]"
            style={{ backgroundColor: accentColor }}
          />
          <span className="text-xs font-mono tracking-wider text-neutral-300 uppercase font-semibold">
            Audio Switcher & Volume
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={fetchAudioStatus}
            title="Refresh devices"
            className="p-1 rounded-md text-neutral-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            onClick={onClose}
            title="Close"
            className="p-1 rounded-md text-neutral-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Master Volume Bar */}
      <div className="py-2 px-1 shrink-0 flex items-center gap-2.5 border-b border-white/5">
        <button
          onClick={handleToggleMute}
          title={isMuted ? "Unmute" : "Mute"}
          className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-neutral-300 hover:text-white transition-colors shrink-0"
        >
          {isMuted || volume === 0 ? (
            <VolumeX className="w-4 h-4 text-rose-400" />
          ) : (
            <Volume2 className="w-4 h-4" style={{ color: accentColor }} />
          )}
        </button>

        <div className="flex-1 flex items-center gap-2">
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={isMuted ? 0 : volume}
            onMouseDown={() => {
              isDraggingRef.current = true;
            }}
            onMouseUp={() => {
              isDraggingRef.current = false;
            }}
            onTouchStart={() => {
              isDraggingRef.current = true;
            }}
            onTouchEnd={() => {
              isDraggingRef.current = false;
            }}
            onChange={handleVolumeChange}
            className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-white"
            style={{
              accentColor: accentColor,
            }}
          />
          <span className="text-xs font-mono text-neutral-400 w-10 text-right tabular-nums shrink-0">
            {isMuted ? "Mute" : `${Math.round(volume * 100)}%`}
          </span>
        </div>
      </div>

      {/* Tabs / Filter Bar */}
      <div className="flex items-center gap-1 py-1.5 shrink-0">
        <button
          onClick={() => setActiveTab("all")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1 px-2 rounded-lg text-xs font-medium transition-all ${
            activeTab === "all"
              ? "bg-white/15 text-white shadow-sm"
              : "text-neutral-400 hover:text-neutral-200 hover:bg-white/5"
          }`}
        >
          <Radio className="w-3.5 h-3.5" />
          <span>Semua ({outputs.length + inputs.length})</span>
        </button>

        <button
          onClick={() => setActiveTab("output")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1 px-2 rounded-lg text-xs font-medium transition-all ${
            activeTab === "output"
              ? "bg-white/15 text-white shadow-sm"
              : "text-neutral-400 hover:text-neutral-200 hover:bg-white/5"
          }`}
        >
          <Volume2 className="w-3.5 h-3.5" />
          <span>Output ({outputs.length})</span>
        </button>

        <button
          onClick={() => setActiveTab("input")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1 px-2 rounded-lg text-xs font-medium transition-all ${
            activeTab === "input"
              ? "bg-white/15 text-white shadow-sm"
              : "text-neutral-400 hover:text-neutral-200 hover:bg-white/5"
          }`}
        >
          <Mic className="w-3.5 h-3.5" />
          <span>Input ({inputs.length})</span>
        </button>
      </div>

      {/* Device List Section */}
      <div
        className="flex-1 overflow-y-auto space-y-2 pr-1 pt-0.5"
        style={{ scrollbarWidth: "none" }}
      >
        {/* Output Section */}
        {(activeTab === "all" || activeTab === "output") && (
          <div className="space-y-1">
            <div className="flex items-center justify-between px-1 text-[11px] font-mono text-neutral-400 uppercase tracking-wider">
              <span>Output (Playback)</span>
              <span>{outputs.length} perangkat</span>
            </div>
            {outputs.length === 0 ? (
              <div className="text-center text-xs text-neutral-500 py-3">
                Tidak ada output audio terdeteksi
              </div>
            ) : (
              outputs.map((dev) => renderDeviceRow(dev, "output"))
            )}
          </div>
        )}

        {/* Input Section */}
        {(activeTab === "all" || activeTab === "input") && (
          <div className="space-y-1 pt-1">
            <div className="flex items-center justify-between px-1 text-[11px] font-mono text-neutral-400 uppercase tracking-wider">
              <span>Input (Microphone)</span>
              <span>{inputs.length} perangkat</span>
            </div>
            {inputs.length === 0 ? (
              <div className="text-center text-xs text-neutral-500 py-3">
                Tidak ada mikrofon terdeteksi
              </div>
            ) : (
              inputs.map((dev) => renderDeviceRow(dev, "input"))
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
};
