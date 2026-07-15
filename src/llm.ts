import { CreateMLCEngine, prebuiltAppConfig, type MLCEngine } from "@mlc-ai/web-llm";
import type { Assistant, DecomposeResult } from "./types.ts";
import { DECOMPOSE_SYSTEM, HELP_SYSTEM, RETRY_JSON_MESSAGE } from "./prompts.ts";

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

export interface LoadProgress {
  /** 0〜1 */
  progress: number;
  text: string;
}

export async function createWebLLMAssistant(
  onProgress: (p: LoadProgress) => void
): Promise<Assistant> {
  const modelId = resolveModelId();
  if (!modelId) throw new Error("no compatible model in prebuilt config");

  const engine: MLCEngine = await CreateMLCEngine(modelId, {
    initProgressCallback: (report) => {
      onProgress({ progress: report.progress ?? 0, text: report.text ?? "" });
    }
  });

  async function chat(
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    maxTokens: number,
    jsonMode: boolean
  ): Promise<string> {
    const res = await engine.chat.completions.create({
      messages,
      temperature: 0.3,
      max_tokens: maxTokens,
      // Qwen3の思考モードをテンプレートレベルで無効化(思考トークンの浪費と出力崩れを防ぐ)
      extra_body: { enable_thinking: false },
      ...(jsonMode ? { response_format: { type: "json_object" as const } } : {})
    });
    return stripThink(res.choices[0]?.message?.content ?? "");
  }

  /** JSONグラマー強制で呼び、環境が対応していなければ通常モードで再試行する */
  async function chatForJson(
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    maxTokens: number
  ): Promise<string> {
    try {
      return await chat(messages, maxTokens, true);
    } catch (err) {
      console.warn("json mode failed, retrying without grammar:", err);
      return await chat(messages, maxTokens, false);
    }
  }

  return {
    kind: "ai",

    async decompose(taskText, clarify): Promise<DecomposeResult> {
      const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
        { role: "system", content: DECOMPOSE_SYSTEM },
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

      let raw = await chatForJson(messages, 1000);
      let result = parseDecomposeResult(raw);
      if (!result) {
        // JSONとして読めなかったら、形式を念押しして1回だけリトライ
        messages.push({ role: "assistant", content: raw });
        messages.push({ role: "user", content: RETRY_JSON_MESSAGE });
        raw = await chatForJson(messages, 1000);
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
        400,
        false
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
