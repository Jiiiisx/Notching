import { useSyncExternalStore } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";

export type PomodoroPhase = "focus" | "short" | "long";

const DURATIONS: Record<PomodoroPhase, number> = {
  focus: 25 * 60,
  short: 5 * 60,
  long: 15 * 60,
};

const PHASE_LABELS: Record<PomodoroPhase, string> = {
  focus: "Fokus",
  short: "Istirahat Pendek",
  long: "Istirahat Panjang",
};

interface PomodoroState {
  phase: PomodoroPhase;
  remaining: number;
  running: boolean;
  sessions: number;
}

/**
 * Timer state lives outside React so it survives module switches (the panel unmounts when the user
 * navigates away) and keeps ticking from an absolute deadline, immune to setInterval throttling.
 */
let state: PomodoroState = {
  phase: "focus",
  remaining: DURATIONS.focus,
  running: false,
  sessions: 0,
};
let endsAt = 0;
let ticker: number | null = null;

const listeners = new Set<() => void>();
const completeHandlers = new Set<(s: PomodoroState) => void>();

function setState(patch: Partial<PomodoroState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function stopTicker() {
  if (ticker !== null) {
    window.clearInterval(ticker);
    ticker = null;
  }
}

function tick() {
  if (!state.running) return;
  const remaining = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
  if (remaining === state.remaining) return;
  if (remaining === 0) {
    completePhase();
    return;
  }
  setState({ remaining });
}

/** Ends the running phase, advances to the next one, and notifies listeners about the finished phase */
function completePhase() {
  stopTicker();
  const completed = state.phase;
  const sessions = completed === "focus" ? state.sessions + 1 : state.sessions;
  const nextPhase: PomodoroPhase =
    completed === "focus" ? (sessions % 4 === 0 ? "long" : "short") : "focus";
  setState({
    phase: nextPhase,
    remaining: DURATIONS[nextPhase],
    running: false,
    sessions,
  });
  completeHandlers.forEach((h) => h({ ...state, phase: completed }));
}

function startTicker() {
  if (ticker === null) ticker = window.setInterval(tick, 1000);
}

export function startPomodoro() {
  if (state.running) return;
  if (state.remaining <= 0) {
    setState({ remaining: DURATIONS[state.phase] });
  }
  endsAt = Date.now() + state.remaining * 1000;
  setState({ running: true });
  startTicker();
}

export function pausePomodoro() {
  if (!state.running) return;
  stopTicker();
  setState({
    remaining: Math.max(0, Math.round((endsAt - Date.now()) / 1000)),
    running: false,
  });
}

export function resetPomodoro() {
  stopTicker();
  setState({ remaining: DURATIONS[state.phase], running: false });
}

export function selectPomodoroPhase(phase: PomodoroPhase) {
  stopTicker();
  setState({ phase, remaining: DURATIONS[phase], running: false });
}

export function onPomodoroComplete(handler: (s: PomodoroState) => void) {
  completeHandlers.add(handler);
  return () => {
    completeHandlers.delete(handler);
  };
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

// Dev-only hook so the completion path (toast + notification) can be exercised without a 25 min wait
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__pomodoroForceComplete = () => {
    stopTicker();
    setState({
      remaining: 0,
      running: false,
      sessions: state.phase === "focus" ? state.sessions + 1 : state.sessions,
    });
    completeHandlers.forEach((h) => h(state));
  };
}

export function usePomodoro(): PomodoroState {
  return useSyncExternalStore(subscribe, () => state);
}

export function formatPomodoro(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

export function Pomodoro({ accentColor }: { accentColor: string }) {
  const s = usePomodoro();
  const total = DURATIONS[s.phase];
  const progress = total > 0 ? Math.round(((total - s.remaining) / total) * 100) : 0;

  return (
    <div className="flex flex-col gap-2.5 select-none">
      {/* Phase selector */}
      <div className="flex items-center gap-1 p-0.5 rounded-lg bg-white/5 border border-white/5 w-fit mx-auto">
        {(Object.keys(DURATIONS) as PomodoroPhase[]).map((phase) => {
          const active = s.phase === phase;
          return (
            <button
              key={phase}
              type="button"
              onClick={() => selectPomodoroPhase(phase)}
              aria-pressed={active}
              className={`px-2.5 h-6 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                active
                  ? "bg-white/[0.14] text-white"
                  : "text-neutral-400 hover:text-white hover:bg-white/[0.06]"
              }`}
            >
              {PHASE_LABELS[phase]}
            </button>
          );
        })}
      </div>

      {/* Timer */}
      <div className="text-center">
        <div
          className="font-mono font-semibold tabular-nums leading-none tracking-tight"
          style={{ fontSize: 44, color: accentColor }}
        >
          {formatPomodoro(s.remaining)}
        </div>
        <div className="text-[11px] text-neutral-400 mt-1.5">
          {s.running ? PHASE_LABELS[s.phase] : "Siap"} · sesi fokus selesai:{" "}
          <span className="text-neutral-200 tabular-nums">{s.sessions}</span>
        </div>
      </div>

      {/* Progress */}
      <div className="h-1 rounded-full bg-white/10 overflow-hidden mx-1">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${progress}%`, backgroundColor: accentColor }}
        />
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={s.running ? pausePomodoro : startPomodoro}
          className="h-8 px-4 rounded-lg text-xs font-semibold flex items-center gap-1.5 bg-white text-black hover:bg-neutral-200 transition-transform active:scale-95 cursor-pointer"
        >
          {s.running ? (
            <>
              <Pause className="w-3.5 h-3.5 fill-current" /> Jeda
            </>
          ) : (
            <>
              <Play className="w-3.5 h-3.5 fill-current" /> Mulai
            </>
          )}
        </button>
        <button
          type="button"
          onClick={resetPomodoro}
          title="Reset timer ke durasi awal"
          className="h-8 px-3 rounded-lg text-xs font-medium flex items-center gap-1.5 bg-white/[0.04] border border-white/[0.06] text-neutral-300 hover:text-white hover:bg-white/[0.09] transition-colors cursor-pointer"
        >
          <RotateCcw className="w-3 h-3" /> Reset
        </button>
      </div>
    </div>
  );
}
