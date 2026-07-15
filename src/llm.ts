import { CreateMLCEngine, prebuiltAppConfig, type MLCEngine } from "@mlc-ai/web-llm";
import type { Assistant, DecomposeResult } from "./types.ts";
import { DECOMPOSE_FEWSHOT, DECOMPOSE_SYSTEM, HELP_SYSTEM, RETRY_JSON_MESSAGE } from "./prompts.ts";

/**
 * ブラウザ内LLM(WebLLM)によるアシスタント。
 * 第一候補: Qwen3-0.6B(q4量子化・約500MB)。
 * モデルはWebLLMがCache APIに保存するため、2回目以降は高速に起動する。
 */

// 優先順に試すモデルID(prebuiltAppConfig に存在するものだけ使う)
const MODEL_CANDIDATES = [
  "Qwen3-0.6B-q4f16_1-MLC",
  "Qwen2.5-0.5B-Instruct-q4f16_1-MLC"
];

// 品質引き上げ時は localStorage で差し替えられる(例: "Qwen3-1.7B-q4f16_1-MLC")
const MODEL_OVERRIDE_KEY = "tamayura.modelId";

export function resolveModelId(): string | null {
  const available = new Set(prebuiltAppConfig.model_list.map((m) => m.model_id));
  const override = localStorage.getItem(MODEL_OVERRIDE_KEY);
  if (override && available.has(override)) return override;
  return MODEL_CANDIDATES.find((id) => available.has(id)) ?? null;
}

/**
 * GPUが shader-f16 に対応しているか。
 * 非対応端末(Android等に多い)で q4f16 モデルを使うと
 * GPUPipelineError(Invalid ShaderModule)になるため、事前に判定する。
 */
async function shaderF16Supported(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as {
      gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> };
    }).gpu;
    const adapter = await gpu?.requestAdapter();
    return adapter?.features.has("shader-f16") ?? false;
  } catch {
    return false;
  }
}

const toF32 = (id: string) => id.replace("q4f16_1", "q4f32_1");
const toF16 = (id: string) => id.replace("q4f32_1", "q4f16_1");

export interface LoadProgress {
  /** 0〜1 */
  progress: number;
  text: string;
}

export async function createWebLLMAssistant(
  onProgress: (p: LoadProgress) => void
): Promise<Assistant> {
  const baseId = resolveModelId();
  if (!baseId) throw new Error("no compatible model in prebuilt config");

  // 端末のf16対応に合わせた量子化版を第一候補にし、失敗したらもう一方で再試行する
  const available = new Set(prebuiltAppConfig.model_list.map((m) => m.model_id));
  const f16ok = await shaderF16Supported();
  const primary = f16ok ? toF16(baseId) : toF32(baseId);
  const secondary = primary.includes("q4f16_1") ? toF32(primary) : toF16(primary);
  const tryIds = [primary, secondary].filter((id, i, a) => available.has(id) && a.indexOf(id) === i);
  if (tryIds.length === 0) throw new Error("no compatible model in prebuilt config");

  let engine: MLCEngine | null = null;
  let loadedId = "";
  let lastError: unknown = null;
  for (const id of tryIds) {
    try {
      engine = await CreateMLCEngine(id, {
        initProgressCallback: (report) => {
          onProgress({ progress: report.progress ?? 0, text: report.text ?? "" });
        }
      });
      loadedId = id;
      break;
    } catch (err) {
      console.warn(`model load failed for ${id}:`, err);
      lastError = err;
    }
  }
  if (!engine) throw lastError ?? new Error("model load failed");
  const llm: MLCEngine = engine;

  // 遅い端末でも完走できるようストリーミングで受け取り、
  // 「進まなくなったとき」だけ打ち切る(停滞30秒 / 合計4分)
  const STALL_TIMEOUT_MS = 30_000;
  const TOTAL_TIMEOUT_MS = 240_000;

  async function chat(
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    maxTokens: number,
    onProgress?: (chars: number) => void
  ): Promise<string> {
    const stream = await llm.chat.completions.create({
      messages,
      temperature: 0.3,
      max_tokens: maxTokens,
      // Qwen3の思考モードをテンプレートレベルで無効化(思考トークンの浪費と出力崩れを防ぐ)
      extra_body: { enable_thinking: false },
      stream: true
    });
    let text = "";
    const startedAt = Date.now();
    let lastChunkAt = Date.now();
    let timeoutReason: string | null = null;
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (now - lastChunkAt > STALL_TIMEOUT_MS) {
        timeoutReason = "とちゅうで とまってしまった";
      } else if (now - startedAt > TOTAL_TIMEOUT_MS) {
        timeoutReason = "じかんが かかりすぎた";
      }
      if (timeoutReason) {
        clearInterval(watchdog);
        try {
          void llm.interruptGenerate();
        } catch {
          /* noop */
        }
      }
    }, 1000);
    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) {
          text += delta;
          lastChunkAt = Date.now();
          onProgress?.(text.length);
        }
      }
    } finally {
      clearInterval(watchdog);
    }
    if (timeoutReason) {
      throw new Error(`AIの こたえが ${timeoutReason}ため、うちきりました(${text.length}もじまで生成)`);
    }
    return stripThink(text);
  }

  return {
    kind: "ai",
    modelId: loadedId,

    async decompose(taskText, clarify, onProgress): Promise<DecomposeResult> {
      const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
        { role: "system", content: DECOMPOSE_SYSTEM },
        ...DECOMPOSE_FEWSHOT,
        { role: "user", content: `やること: ${taskText}` }
      ];
      if (clarify) {
        messages.push({
          role: "assistant",
          content: JSON.stringify({ type: "question", question: clarify.question })
        });
        messages.push({
          role: "user",
          content: `こたえ: ${clarify.answer}\nこの答えをふまえて、ステップに分けてください。もう質問はしないでください。`
        });
      }

      let raw = await chat(messages, 600, onProgress);
      let result = parseDecomposeResult(raw);
      if (!result) {
        // JSONとして読めなかったら、形式を念押しして1回だけリトライ
        messages.push({ role: "assistant", content: raw });
        messages.push({ role: "user", content: RETRY_JSON_MESSAGE });
        raw = await chat(messages, 600, onProgress);
        result = parseDecomposeResult(raw);
      }
      if (!result) throw new Error("decompose failed: " + raw.slice(0, 200));
      // 質問への回答後にさらに質問が返ってきたら打ち切って汎用扱いにしない(呼び出し側で処理)
      return result;
    },

    async help(taskTitle, stepTitle, question): Promise<string> {
      const answer = await chat(
        [
          { role: "system", content: HELP_SYSTEM(taskTitle, stepTitle) },
          { role: "user", content: question }
        ],
        400
      );
      return answer.trim() || "うまく こたえられなかったよ。おうちの人に きいてみてね。";
    }
  };
}

/** Qwen3 の <think>...</think> ブロックを除去する(未クローズの場合は以降を捨てる) */
function stripThink(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const open = t.indexOf("<think>");
  if (open >= 0) t = t.slice(0, open);
  return t.trim();
}

/** モデル出力からJSONを抽出・検証・正規化する */
export function parseDecomposeResult(raw: string): DecomposeResult | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  if (obj.type === "question" && typeof obj.question === "string" && obj.question.trim()) {
    return { type: "question", question: obj.question.trim() };
  }

  if (obj.type === "steps" && Array.isArray(obj.steps)) {
    const steps = obj.steps
      .map((s) => {
        if (typeof s !== "object" || s === null) return null;
        const step = s as Record<string, unknown>;
        const title = typeof step.title === "string" ? step.title.trim() : "";
        if (!title) return null;
        const rawMinutes = typeof step.minutes === "number" ? step.minutes : Number(step.minutes);
        const minutes = Number.isFinite(rawMinutes)
          ? Math.min(30, Math.max(1, Math.round(rawMinutes)))
          : 5;
        return { title, minutes };
      })
      .filter((s): s is { title: string; minutes: number } => s !== null)
      .slice(0, 8);
    if (steps.length >= 2) return { type: "steps", steps };
  }

  return null;
}
