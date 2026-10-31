import { useEffect, useReducer, useRef, useState } from "react";
import { Send, Square, Trash2, Wrench } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Lightweight agent chat. Calls an OpenAI-compatible endpoint directly (9Router)
 * from the webview — no Hermes involved. Tool loop (function calling) lets the
 * model act: open URLs, search, control media & volume. History in localStorage.
 *
 * RUNTIME DI MODULE SCOPE: loop tool + state percakapan TIDAK hidup di dalam
 * komponen. Kalau notch collapse, AgentPanel unmount — mesin di bawah tetap
 * jalan dan mount ulang menampilkan state yang sedang berjalan.
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
const MAX_TOOL_ROUNDS = 4; // hard cap: model cannot loop tools forever

// ponytail: tool schema duplicated in src-tauri/src/lib.rs agent_run_tool —
// upgrade path: generate this list from a Rust command to keep one source.
const TOOLS = [
  {
    type: "function",
    function: {
      name: "open_url",
      description:
        "Buka URL di browser default user (link Spotify otomatis dibuka lewat aplikasi Spotify desktop kalau terpasang).",
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
      name: "find_file",
      description:
        "Cari file ATAU folder di laptop berdasarkan nama (substring, tidak case-sensitive). Mencari di Desktop, Documents, Downloads, Pictures, Videos, Music, dan drive D:\\ (folder juga bisa cocok). Kembalikan daftar path lengkap.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Bagian nama file/folder, mis. 'laporan' atau 'Film'" },
          dir: { type: "string", description: "Opsional: folder mulai searching, mis. 'D:\\Film'" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_file",
      description:
        "Buka file ATAU folder lokal: file dibuka aplikasi default, FOLDER dibuka di File Explorer. path harus absolut (hasil find_file atau path yang user sebut).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path absolut, mis. C:\\Users\\...\\laporan.docx atau D:\\Film" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_app",
      description:
        "Buka aplikasi yang terpasang di laptop user (dicari dari shortcut Start Menu & Desktop). PANGGIL INI DULU sebelum open_url kalau user minta membuka sebuah aplikasi/layanan (Gemini, Hermes, Spotify, dsb). Kalau gagal (tidak ada di laptop), bertanya dulu ke user: mau dibuka lewat browser atau tidak.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Nama app, mis. 'spotify' atau 'gemini'" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory",
      description:
        "Simpan fakta permanen tentang user & laptop ke memori agent (contoh: 'folder film di D:\\Film', 'user kampus UPN'). Panggil setiap kali mempelajari fakta penting yang belum ada di memori. Jangan simpan info sementara.",
      parameters: {
        type: "object",
        properties: { content: { type: "string", description: "Satu fakta, satu baris" } },
        required: ["content"],
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

// Skill loader: file .md lokal di %LOCALAPPDATA%\Notch\skills\<nama>.md.
// Front-matter `keywords: foo, bar` dipakai untuk auto-matching; kalau pesan
// user mengandung salah satu keyword, isi skill disuntik ke system prompt.
// Bisa juga dipaksa: pesan diawali "/skill nama".
interface SkillInfo {
  name: string;
  keywords: string[];
}

function parseSkillMeta(text: string): SkillInfo {
  const m = text.match(/^keywords:\s*(.+)/m);
  const keywords = m
    ? m[1].split(",").map((k) => k.trim().toLowerCase()).filter(Boolean)
    : [];
  return { name: "", keywords };
}

function skillBody(text: string): string {
  // buang front-matter sederhana (blok --- sampai ---) kalau ada
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

async function loadSkills(): Promise<{ names: string[]; files: Record<string, string> }> {
  const names = await invoke<string[]>("agent_list_skills");
  const files: Record<string, string> = {};
  for (const n of names) {
    try {
      files[n] = await invoke<string>("agent_read_skill", { name: n });
    } catch {
      // file hilang/terkunci: skip, jangan bunuh panel
    }
  }
  return { names, files };
}

/* ================= RUNTIME (module scope, tahan unmount) ================= */

type Exec = { name: string; ok: boolean; detail: string };

interface AgentStore {
  messages: AgentMessage[];
  busy: boolean;
  toolNote: string | null;
  toolMessages: Exec[];
  error: string | null;
  activeSkill: string | null;
  skillNames: string[];
  skillFiles: Record<string, string>;
}

const store: AgentStore = {
  messages: loadHistory(),
  busy: false,
  toolNote: null,
  toolMessages: [],
  error: null,
  activeSkill: null,
  skillNames: [],
  skillFiles: {},
};

const listeners = new Set<() => void>();
function setStore(patch: Partial<AgentStore>) {
  Object.assign(store, patch);
  listeners.forEach((l) => l());
}
function runSkillLoad() {
  loadSkills().then(({ names, files }) => setStore({ skillNames: names, skillFiles: files }));
}
runSkillLoad();

function save(): void {
  // ponytail: history unbounded in storage but only last 20 go to the API —
  // upgrade path: trim store to last 200.
  localStorage.setItem(HISTORY_KEY, JSON.stringify(store.messages.slice(-100)));
}

let abortCtrl: AbortController | null = null;

const cleanOut = (t: string) =>
  t
    // Buang sisa markup function-call model (</invoke>, <function_call>, dll)
    .replace(/<\/?(?:function_call|invoke|parameter|antml:[a-z-]+)[^>]*>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
    .replace(/^(?:```xml|```)\n?/, "");

async function callModel(
  controller: AbortController,
  convo: { role: string; content: string }[],
  systemContent: string,
  config: AgentConfig
) {
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
        { role: "system", content: systemContent },
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
}

async function runTool(name: string, rawArgs: string) {
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
}

export function agentStop() {
  try {
    abortCtrl?.abort();
  } finally {
    abortCtrl = null;
  }
  setStore({ busy: false, toolNote: null });
}

export function agentClear() {
  if (store.busy) agentStop();
  setStore({
    messages: [],
    toolMessages: [],
    toolNote: null,
    activeSkill: null,
    error: null,
  });
  localStorage.removeItem(HISTORY_KEY);
}

async function sendAgent(
  text: string,
  config: AgentConfig,
  forcedSkill: string | null
) {
  agentStop();
  setStore({ error: null, busy: true, toolMessages: [], toolNote: null, activeSkill: null });

  // Skill: "/skill nama ..." memaksa satu skill; tanpa itu, keyword auto-match.
  const slash = text.match(/^\/skill\s+([^\s]+)/);
  const lower = text.toLowerCase();
  let skillName: string | null = null;
  if (slash) {
    skillName =
      store.skillNames.find((n) => n.toLowerCase() === slash[1].toLowerCase()) ?? null;
    if (!skillName) {
      setStore({
        busy: false,
        error: `Skill "${slash[1]}" tidak ditemukan. Ada: ${store.skillNames.join(", ") || "belum ada"}`,
      });
      return;
    }
  } else {
    skillName =
      forcedSkill ??
      store.skillNames.find((n) =>
        (parseSkillMeta(store.skillFiles[n] ?? "").keywords ?? []).some(
          (k) => k && lower.includes(k)
        )
      ) ??
      null;
  }

  // Perilaku bawaan + memori agent (fakta permanen tentang user & laptop).
  let memory = "";
  try {
    memory = (await invoke<string | null>("agent_memory_read")) ?? "";
  } catch {
    memory = "";
  }

  const agentPersona =
    `\n\n--- KARAKTER (wajib dipatuhi) ---\n` +
    `Bicara seperti teman dekat orang Indonesia: bahasa santai (makasih, gaskeun, wkwk boleh, tapi jangan berlebihan), enggak formal, enggak seperti robot/CS.\n` +
    `JANGAN tampilkan kode, tag XML, JSON, nama tool, atau markup (<invoke>, </parameter>, <function_call>) di jawaban. Hasil tool tampilkan sebagai kalimat biasa: "Spotify udah kubuka, lagunya jalan." Fungsi pencarian/tool kerjakan di belakang.\n` +
    `Jawaban pendek dan manusiawi. Kasih opini atau reaksi ringan, tanya balik kalau perlu. Jangan mulai dengan "Tentu!", "Baik,", atau kalimat asisten. Jendela percakapan: user mau tempat bercerita juga, bukan cuma minta komando.\n` +
    `Boleh pakai sedikit emoji yang relevan kalau konteksnya musik/kegiatan; enggak wajib.\n` +
    `Contoh gaya jawaban:\n` +
    `- "Dah kebuka tuh di Spotify, cari 2001x Ada Khalif. Tinggal tap lagunya biar mulai."\n` +
    `- "Ada dua, Spotify mana yang kamu maksud? Yang biasa atau Spotify Studio Labs?"\n`;
  let systemContent =
      config.systemPrompt +
      agentPersona +
      `\n\n--- PERILAKU LOKAL (wajib) ---\n` +
      `1. Jika user meminta membuka sebuah aplikasi/layanan di laptop (Gemini, Hermes, Spotify, VS Code, dsb): PANGGIL open_app PADA PERMUTAMA. Kalau open_app gagal (tidak terpasang), TANYAKAN DULU: "Tidak ketemu di laptop, mau dibuka lewat browser?" dan tunggu jawaban sebelum open_url.\n` +
      `2. Untuk perintah musik Spotify ('setel/play lagu X'): open_url dengan url \`https://open.spotify.com/search/<judul lagu plus artis>\` — ini OTOMATIS dibuka di aplikasi Spotify desktop di halaman pencarian lagu itu (dipilih user untuk play). Kalau ada link open.spotify.com/track/... dari user, pakai link itu.\n` +
      `3. Untuk mencari/buka di web (search, situs, video, artikel, link): langsung open_search/open_url tanpa bertanya. Untuk MEMBUKA APLIKASI desktop (Gemini, Hermes, VS Code, dsb), open_app dulu. Jika tidak terpasang, bertanya dulu sebelum open_url.\n` +
      `4. Kamu MEMORI: fakta permanen user & laptop di bawah. Gunakan sebelum bertanya ulang hal yang sudah diketahui. Pelajari terus user & laptop: setiap kali menemukan fakta penting baru (preferensi, folder penting, app terpasang, kebiasaan), panggil tool memory.\n` +
      `5. USER MINTA BUKA FILE ATAU FOLDER DI LAPTOP: find_file dulu untuk temukan path-nya, lalu open_file dengan SALAH SATU path hasilnya — jangan cuma menceritakan hasil pencarian. FOLDER dibuka open_file juga (kebuka di File Explorer).\n` +
      `--- MEMORI AGENT ---\n${memory || "(masih kosong)"}`;
  if (skillName) {
    const body = skillBody(store.skillFiles[skillName] ?? "");
    systemContent =
      `${config.systemPrompt}\n\n--- SKILL DIAKTIFKAN: ${skillName} ---\n` +
      body +
      `\n--- GUNAKAN pengetahuan skill ini untuk menjawab (jangan sebut "skill" atau "injeksi") ---`;
  }

  setStore({ activeSkill: skillName });
  const userMsg: AgentMessage = { role: "user", content: text };
  const baseHistory: AgentMessage[] = [...store.messages, userMsg];
  setStore({ messages: baseHistory });
  save();
  const controller = new AbortController();
  abortCtrl = controller;

  try {
    // Tool loop: model may request tool calls; execute them locally, feed
    // results back, and let it produce the final answer. Capped rounds.
    const convo: { role: string; content: string }[] = [
      ...baseHistory.map((m) => ({ role: m.role as string, content: m.content })),
    ];
    let history = baseHistory;
    let lastExecuted: Exec[] = [];
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const json = await callModel(controller, convo, systemContent, config);
      const msg = json.choices?.[0]?.message;
      if (!msg) throw new Error("Respons model kosong");
      const toolCalls = msg.tool_calls ?? [];
      if (toolCalls.length === 0) {
        const cleaned = cleanOut(msg.content ?? "");
        if (!cleaned && round > 0) {
          // Model jawab kosong setelah eksekusi tool → jangan tampilkan
          // bubble kosong; rangkum sendiri dari hasil tool (ponytail:
          // teks generik, upgrade dengan per-tool phrasing kalau terasa kaku).
          const okNames = lastExecuted.filter((e) => e.ok).map((e) => e.name);
          const failNames = lastExecuted.filter((e) => !e.ok).map((e) => e.name);
          const parts = [
            okNames.length ? `dah kujalanin ${okNames.join(" dan ")}` : "",
            failNames.length ? `tapi ${failNames.join(" dan ")} gagal` : "",
          ].filter(Boolean);
          history = [
            ...history,
            {
              role: "assistant",
              content: parts.length
                ? `Oke, ${parts.join(", ")}.`
                : "Hmm, prosesnya kelewat tanpa hasil. Coba tanya lagi ya.",
            },
          ];
          setStore({ messages: history });
          save();
          return;
        }
        history = [...history, { role: "assistant", content: cleaned }];
        setStore({ messages: history });
        save();
        return;
      }
      if (msg.content) {
        // progressive assistant text between tool rounds
        history = [...history, { role: "assistant", content: cleanOut(msg.content) }];
        setStore({ messages: history });
      }
      setStore({ toolNote: `Menjalankan ${toolCalls.map((c) => c.function.name).join(", ")}…` });
      const executed: Exec[] = [];
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
      setStore({ toolMessages: executed });
      lastExecuted = executed;
      // Nudge: model sering balas kosong/verbatim setelah tool round.
      convo.push({
        role: "user",
        content:
          "Sekarang jawab user: rangkum hasil di atas dalam 1-2 kalimat santai (bahasa Indonesia, gaya teman), TANPA kode/tag markup/nama tool. Jangan jawab kosong.",
      });
      setStore({ toolNote: null });
    }
    // hit tool round cap without a final text answer
    history = [
      ...history,
      { role: "assistant", content: "Berhenti: batas putaran tool tercapai tanpa jawaban final." },
    ];
    setStore({ messages: history });
    save();
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      setStore({ error: `Gagal: ${(e as Error).message}` });
    }
  } finally {
    abortCtrl = null;
    setStore({ busy: false, toolNote: null });
  }
}

/* ================= PANEL (hanya tampilan) ================= */

// ponytail: history unbounded in storage but only last 20 go to the API —
// upgrade path: trim store to last 200.
export default function AgentPanel({
  config,
  accentColor,
}: {
  config: AgentConfig;
  accentColor: string;
}) {
  const [, tick] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    listeners.add(tick);
    return () => void listeners.delete(tick);
  }, []);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const { messages, busy, toolNote, toolMessages, error, activeSkill } = store;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, toolMessages]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!config.apiKey || !config.baseUrl || !config.model) {
      setStore({ error: "Isi API key, Base URL, dan model dulu di Settings → tab Agent." });
      return;
    }
    setInput("");
    await sendAgent(text, config, store.activeSkill);
  };

  return (
    <div className="flex h-full flex-col gap-2 px-5 pt-3 pb-4">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-white/50">
          Agent · {config.model || "not configured"}
          {activeSkill && <span style={{ color: accentColor }}> · skill: {activeSkill}</span>}
        </div>
        <button
          onClick={agentClear}
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
            onClick={agentStop}
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
