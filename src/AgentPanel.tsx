import { useCallback, useEffect, useRef, useState } from "react";
import { Send, Square, Trash2, Wrench } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Lightweight agent chat. Calls an OpenAI-compatible endpoint directly (9Router)
 * from the webview — no Hermes involved. Tool loop (function calling) lets the
 * model act: open URLs, search, control media & volume. History in localStorage.
 */

export interface AgentConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
}

export interface AgentMessage {
  role: "user" | "assistant" | "tool";
  content: string;
}

const HISTORY_KEY = "notch_agent_history";
const MAX_CONTEXT_MESSAGES = 20; // keep payload slim: send last N messages
const MAX_TOOL_ROUNDS = 4; // hard cap: model cannot loop tools forever

// ponytail: tool schema duplicated in src-tauri/src/lib.rs agent_run_tool —
// upgrade path: generate this list from a Rust command to keep one source.
const TOOLS = [
  {
    type: "function",
    function: {
      name: "open_url",
      description: "Buka URL di browser default user. Pakai untuk membuka situs/video/profil.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "URL lengkap atau domain" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_search",
      description: "Buka halaman pencarian Google untuk sebuah query.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "media_play_pause",
      description: "Play/pause media yang sedang berjalan di Windows.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "media_next",
      description: "Lompat ke track berikutnya.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "media_prev",
      description: "Kembali ke track sebelumnya.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "set_volume",
      description: "Set volume master Windows. level 0.0 (diam) sampai 1.0 (penuh).",
      parameters: {
        type: "object",
        properties: { level: { type: "number", description: "0.0 - 1.0" } },
        required: ["level"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_media",
      description: "Baca judul/artis/status media yang sedang diputar.",
      parameters: { type: "object", properties: {} },
    },
  },
];

function loadHistory(): AgentMessage[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as AgentMessage[]) : [];
  } catch {
    return [];
  }
}

// ponytail: history unbounded in storage but only last 20 go to the API —
// upgrade path: trim store to last 200.
export default function AgentPanel({
  config,
  accentColor,
}: {
  config: AgentConfig;
  accentColor: string;
}) {
  const [messages, setMessages] = useState<AgentMessage[]>(loadHistory);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [toolNote, setToolNote] = useState<string | null>(null);
  const [toolMessages, setToolMessages] = useState<
    { name: string; ok: boolean; detail: string }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, toolMessages]);

  const save = useCallback((msgs: AgentMessage[]) => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(msgs.slice(-100)));
  }, []);

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  };

  const callModel = async (
    controller: AbortController,
    convo: { role: string; content: string }[]
  ) => {
    const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        stream: false, // ponytail: tool loop needs whole JSON; streaming+tools needs delta.tool_calls parsing. Upgrade path: add SSE tool_call parsing when wanted.
        messages: [
          { role: "system", content: config.systemPrompt },
          ...convo.slice(-MAX_CONTEXT_MESSAGES),
        ],
        tools: TOOLS,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    return (await res.json()) as {
      choices: {
        message: {
          role: "assistant";
          content: string | null;
          tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
        };
      }[];
    };
  };

  const runTool = async (name: string, rawArgs: string) => {
    let args: Record<string, unknown> = {};
    try {
      args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      return [name, false, "argumen JSON tidak valid"] as const;
    }
    try {
      const out = await invoke("agent_run_tool", { name, args });
      return [name, true, String(out)] as const;
    } catch (e) {
      return [name, false, String(e)] as const;
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!config.apiKey || !config.baseUrl || !config.model) {
      setError("Isi API key, Base URL, dan model dulu di Settings → tab Agent.");
      return;
    }
    setError(null);
    setInput("");
    const userMsg: AgentMessage = { role: "user", content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    save(history);
    setBusy(true);
    setToolMessages([]);
    setToolNote(null);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Tool loop: model may request tool calls; execute them locally, feed
      // results back, and let it produce the final answer. Capped rounds.
      const convo: { role: string; content: string }[] = [
        ...history.map((m) => ({ role: m.role as string, content: m.content })),
      ];
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const json = await callModel(controller, convo);
        const msg = json.choices?.[0]?.message;
        if (!msg) throw new Error("Respons model kosong");
        const toolCalls = msg.tool_calls ?? [];
        if (toolCalls.length === 0) {
          const finalMsg: AgentMessage = {
            role: "assistant",
            content: msg.content ?? "",
          };
          const withAnswer = [...history, finalMsg];
          setMessages(withAnswer);
          save(withAnswer);
          return;
        }
        if (msg.content) {
          // progressive assistant text between tool rounds
          const withText = [...history, { role: "assistant", content: msg.content } as AgentMessage];
          setMessages(withText);
        }
        setToolNote(`Menjalankan ${toolCalls.map((c) => c.function.name).join(", ")}…`);
        const executed: { name: string; ok: boolean; detail: string }[] = [];
        for (const call of toolCalls) {
          const [name, ok, detail] = await runTool(
            call.function.name,
            call.function.arguments
          );
          executed.push({ name, ok, detail });
          convo.push({
            role: "assistant",
            content: `${name} → ${ok ? "OK" : "GAGAL"}: ${detail}`,
          });
        }
        setToolMessages(executed);
        setToolNote(null);
      }
      // hit tool round cap without a final text answer
      const capMsg: AgentMessage = {
        role: "assistant",
        content: "Berhenti: batas putaran tool tercapai tanpa jawaban final.",
      };
      const withCap = [...history, capMsg];
      setMessages(withCap);
      save(withCap);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError(`Gagal: ${(e as Error).message}`);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setToolNote(null);
    }
  };

  const clear = () => {
    if (busy) stop();
    setMessages([]);
    setToolMessages([]);
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
        className="flex-1 overflow-y-auto rounded-lg border border-white/10 bg-white/[0.03] p-3 text-[12.5px] leading-relaxed text-white/85"
      >
        {messages.length === 0 && !error && (
          <div className="flex h-full items-center justify-center text-[12px] text-white/35">
            Tanya apa aja — bisa buka web, atur media & volume.
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
              {m.content}
            </div>
          ))}
          {toolMessages.length > 0 &&
            toolMessages.map((t, i) => (
              <div
                key={`tool-${i}`}
                className="mr-auto flex items-center gap-1.5 rounded-full bg-white/[0.04] px-2.5 py-1 text-[11px] text-white/50"
                title={t.detail}
              >
                <Wrench size={11} style={{ color: t.ok ? accentColor : "#f87171" }} />
                {t.name} {t.ok ? "ok" : "gagal"}
              </div>
            ))}
          {toolNote && (
            <div className="mr-auto flex items-center gap-1.5 rounded-full bg-white/[0.05] px-2.5 py-1 text-[11px] text-white/60">
              <Wrench size={11} style={{ color: accentColor }} />
              {toolNote}
            </div>
          )}
          {busy && toolNote === null && (
            <div className="mr-auto rounded-2xl bg-white/[0.06] px-3 py-1.5 text-white/40">…</div>
          )}
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
          placeholder={busy ? "Memproses…" : "Tulis pesan… (Enter kirim)"}
          className="h-8 flex-1 rounded-lg border border-white/10 bg-white/[0.05] px-3 text-[12.5px] text-white/90 outline-none placeholder:text-white/30 focus:border-white/25"
        />
        {busy ? (
          <button
            onClick={stop}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30"
            title="Stop"
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
