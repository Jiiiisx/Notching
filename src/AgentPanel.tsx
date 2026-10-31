import { useCallback, useEffect, useRef, useState } from "react";
import { Send, Square, Trash2 } from "lucide-react";

/**
 * Lightweight streaming chat agent. Calls an OpenAI-compatible endpoint directly
 * (9Router) from the webview — no Hermes involved. History lives in localStorage.
 */

export interface AgentConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
}

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

const HISTORY_KEY = "notch_agent_history";
const MAX_CONTEXT_MESSAGES = 20; // keep payload slim: send last N messages

function loadHistory(): AgentMessage[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as AgentMessage[]) : [];
  } catch {
    return [];
  }
}

// ponytail: history is unbounded in storage but only last 20 go to the API —
// upgrade path: trim store to last 200 with a "clear" button (already present).
export default function AgentPanel({
  config,
  accentColor,
}: {
  config: AgentConfig;
  accentColor: string;
}) {
  const [messages, setMessages] = useState<AgentMessage[]>(loadHistory);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const save = useCallback((msgs: AgentMessage[]) => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(msgs.slice(-100)));
  }, []);

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    if (!config.apiKey || !config.baseUrl || !config.model) {
      setError("Isi API key, Base URL, dan model dulu di Settings → tab Agent.");
      return;
    }
    setError(null);
    setInput("");
    const userMsg: AgentMessage = { role: "user", content: text };
    const history = [...messages, userMsg];
    const withPlaceholder: AgentMessage[] = [
      ...history,
      { role: "assistant", content: "" },
    ];
    setMessages(withPlaceholder);
    save(withPlaceholder);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    try {
      const res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          stream: true,
          messages: [
            { role: "system", content: config.systemPrompt },
            ...history.slice(-MAX_CONTEXT_MESSAGES),
          ],
        }),
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${body.slice(0, 180)}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") break;
          try {
            const json = JSON.parse(data) as {
              choices?: { delta?: { content?: string } }[];
            };
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) acc += delta;
          } catch {
            // keep-alive comments or partial frames — ignore
          }
        }
        setMessages((prev) => {
          const next: AgentMessage[] = [
            ...prev.slice(0, -1),
            { role: "assistant", content: acc },
          ];
          return next;
        });
      }
      save([...history, { role: "assistant", content: acc }]);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError(`Gagal: ${(e as Error).message}`);
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  };

  const clear = () => {
    if (streaming) stop();
    setMessages([]);
    localStorage.removeItem(HISTORY_KEY);
  };

  return (
    <div className="flex h-full flex-col gap-2 px-5 pt-3 pb-4">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-white/50">
          Agent · {config.model || "not configured"}
        </div>
        <button
          onClick={clear}
          title="Hapus riwayat chat"
          className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white/80"
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div
        ref={scrollRef}
        className="chat-scroll flex-1 overflow-y-auto rounded-lg border border-white/10 bg-white/[0.03] p-3 text-[12.5px] leading-relaxed text-white/85"
      >
        {messages.length === 0 && !error && (
          <div className="flex h-full items-center justify-center text-[12px] text-white/35">
            Tanya apa aja — riwayat tersimpan lokal di notch.
          </div>
        )}
        <div className="flex flex-col gap-2.5">
          {messages.map((m, i) => (
            <div
              key={i}
              className={
                m.role === "user"
                  ? "ml-auto max-w-[85%] rounded-2xl rounded-br-sm px-3 py-1.5 text-white"
                  : "mr-auto max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-white/[0.06] px-3 py-1.5 text-white/90"
              }
              style={m.role === "user" ? { background: accentColor + "26" } : undefined}
            >
              {m.content || (streaming && i === messages.length - 1 ? "…" : "")}
            </div>
          ))}
        </div>
      </div>

      {error && <div className="text-[11px] text-red-400">{error}</div>}

      <div className="flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={streaming ? "Streaming…" : "Tulis pesan… (Enter kirim)"}
          className="h-8 flex-1 rounded-lg border border-white/10 bg-white/[0.05] px-3 text-[12.5px] text-white/90 outline-none placeholder:text-white/30 focus:border-white/25"
        />
        {streaming ? (
          <button
            onClick={stop}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30"
            title="Stop streaming"
          >
            <Square size={13} />
          </button>
        ) : (
          <button
            onClick={() => void send()}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-black disabled:opacity-40"
            style={{ background: accentColor }}
            disabled={!input.trim()}
            title="Kirim"
          >
            <Send size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
