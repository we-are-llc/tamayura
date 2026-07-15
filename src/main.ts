import type { Assistant, Settings, Step, Task } from "./types.ts";
import {
  clearAllData,
  deleteTask,
  loadCurrentTaskId,
  loadSettings,
  loadTasks,
  newId,
  saveCurrentTaskId,
  saveSettings,
  upsertTask
} from "./storage.ts";
import { createSimpleAssistant } from "./fallback.ts";
import { listenOnce, speak, speechInputSupported, stopListening, stopSpeaking } from "./speech.ts";

const app = document.getElementById("app")!;
const overlayRoot = document.getElementById("overlay-root")!;

let settings: Settings = loadSettings();
let assistant: Assistant | null = null;
let simpleModeNotice = false; // AIが使えず「かんたんモード」になったことの表示用
let lastAiError: string | null = null; // 診断用: AIが使えなかった理由
let lastDecomposeWasFallback = false; // 直前の分解がテンプレートによるものか
let navToken = 0; // ホームに戻ったら進行中のAI処理の結果を画面に反映しないためのトークン

// モデル切り替え(llm.ts と同じキー。静的importするとWebLLM全体が初期バンドルに入るため定数を重複定義)
const MODEL_OVERRIDE_KEY = "tamayura.modelId";
const MODEL_SMALL = "Qwen3-0.6B-q4f16_1-MLC";
const MODEL_LARGE = "Qwen3-1.7B-q4f16_1-MLC";

function currentModelId(): string {
  return localStorage.getItem(MODEL_OVERRIDE_KEY) ?? MODEL_SMALL;
}

// ---------------------------------------------------------------------------
// 小さなDOMヘルパー
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", { class: className, type: "button" }, [label]);
  b.addEventListener("click", onClick);
  return b;
}

function show(...nodes: (Node | string)[]): void {
  stopListening();
  app.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}

function maybeSpeak(text: string): void {
  if (settings.speech) speak(text);
}

/** 「ふん/ぷん」の読み分け(2・5・7・9分は「ふん」) */
function minutesLabel(minutes: number): string {
  const last = minutes % 10;
  const suffix = [2, 5, 7, 9].includes(last) ? "ふん" : "ぷん";
  return `${minutes}${suffix}`;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}ねん ${d.getMonth() + 1}がつ ${d.getDate()}にち`;
}

// ---------------------------------------------------------------------------
// 音声入力つきの入力欄
// ---------------------------------------------------------------------------

function inputWithMic(placeholder: string, onSubmit: (text: string) => void): HTMLElement {
  const input = el("input", {
    class: "text-input",
    type: "text",
    placeholder,
    "aria-label": placeholder
  });
  const submit = () => {
    const text = input.value.trim();
    if (text) onSubmit(text);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  const row = el("div", { class: "row" });
  row.append(input);

  if (speechInputSupported()) {
    const mic = button("🎤", "btn-icon", () => {
      if (mic.classList.contains("listening")) {
        stopListening();
        return;
      }
      mic.classList.add("listening");
      mic.setAttribute("aria-label", "きいています");
      listenOnce((text) => {
        mic.classList.remove("listening");
        mic.setAttribute("aria-label", "こえで いう");
        if (text) {
          input.value = text;
          input.focus();
        }
      });
    });
    mic.setAttribute("aria-label", "こえで いう");
    row.append(mic);
  }

  const go = button("けってい", "btn btn-primary", submit);
  const wrap = el("div", { class: "screen" });
  wrap.append(row, go);
  return wrap;
}

// ---------------------------------------------------------------------------
// アシスタント(AI / かんたんモード)の準備
// ---------------------------------------------------------------------------

async function webgpuSupported(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

async function ensureAssistant(): Promise<Assistant> {
  if (assistant) return assistant;

  if (settings.preferSimple) {
    assistant = createSimpleAssistant();
    return assistant;
  }
  if (!(await webgpuSupported())) {
    simpleModeNotice = true;
    lastAiError =
      "この ブラウザでは WebGPU(AIを うごかす きのう)が つかえません。" +
      (location.protocol === "http:"
        ? "「http://」で ひらいているのが げんいんです。「https://」で ひらきなおしてください。"
        : "べつの ブラウザ(Chrome・Edge など)や、あたらしい たんまつで ためしてください。");
    assistant = createSimpleAssistant();
    return assistant;
  }

  // 初回はモデルのダウンロードについて説明して同意をとる
  if (!settings.downloadAccepted) {
    const choice = await askDownloadConsent();
    if (choice === "simple") {
      settings = { ...settings, preferSimple: true };
      saveSettings(settings);
      assistant = createSimpleAssistant();
      return assistant;
    }
    settings = { ...settings, downloadAccepted: true };
    saveSettings(settings);
  }

  const progress = renderLoading();
  try {
    // WebLLM本体(約6MB)は必要になった時だけ読み込む
    const llm = await import("./llm.ts");
    if (llm.resolveModelId() === null) throw new Error("no compatible model");
    assistant = await llm.createWebLLMAssistant((p) => progress.update(p.progress));
  } catch (err) {
    console.warn("WebLLM load failed, falling back to simple mode:", err);
    simpleModeNotice = true;
    lastAiError = `AIの じゅんびに しっぱいしました: ${String(err).slice(0, 300)}`;
    assistant = createSimpleAssistant();
  }
  return assistant;
}

function askDownloadConsent(): Promise<"ai" | "simple"> {
  return new Promise((resolve) => {
    const screen = el("div", { class: "screen" }, [
      el("h1", { class: "app-title" }, ["じゅんびの おしらせ"]),
      el("div", { class: "card" }, [
        el("p", {}, [
          "AIの あたま(データ)を さいしょに 1かいだけ ダウンロードするよ。",
          el("br"),
          "おおきさは 500MB くらい。Wi-Fiで やるのが おすすめだよ。"
        ]),
        el("p", { class: "note" }, [
          "ダウンロードは 1回だけ。つぎからは すぐに つかえるよ。とちゅうで けしても だいじょうぶ。"
        ])
      ]),
      button("ダウンロードして はじめる", "btn btn-primary", () => resolve("ai")),
      button("ダウンロードしないで つかう(かんたんモード)", "btn btn-soft", () => resolve("simple")),
      el("p", { class: "note" }, [
        "かんたんモードは、きまった わけかたで ステップを つくるよ。あとで せっていから かえられるよ。"
      ])
    ]);
    show(screen);
  });
}

function renderLoading(): { update: (p: number) => void } {
  const fill = el("div", { class: "progress-fill" });
  fill.style.width = "0%";
  const percent = el("p", { class: "loading-big" }, ["じゅんびちゅう… 0%"]);
  const screen = el("div", { class: "screen loading-screen" }, [
    el("div", { class: "chara", "aria-hidden": "true" }),
    percent,
    el("div", { class: "progress-track" }, [fill]),
    el("p", { class: "note" }, ["はじめてのときは じかんが かかるよ。", el("br"), "つぎからは はやく はじまるよ!"])
  ]);
  show(screen);
  return {
    update(p: number) {
      const pct = Math.round(Math.min(1, Math.max(0, p)) * 100);
      fill.style.width = `${pct}%`;
      percent.textContent = `じゅんびちゅう… ${pct}%`;
    }
  };
}

function renderThinking(message: string): { setDetail: (text: string) => void } {
  const detail = el("p", { class: "note" }, ["すこし じかんが かかることが あるよ"]);
  const screen = el("div", { class: "screen loading-screen" }, [
    el("div", { class: "chara", "aria-hidden": "true" }),
    el("p", { class: "loading-big thinking-dots" }, [message]),
    detail,
    button("← やめて ホームへ", "btn-ghost", renderHome)
  ]);
  show(screen);
  return {
    setDetail(text: string) {
      detail.textContent = text;
    }
  };
}

// ---------------------------------------------------------------------------
// ホーム画面
// ---------------------------------------------------------------------------

function renderHome(): void {
  navToken++;
  stopSpeaking();
  const tasks = loadTasks();
  const active = tasks.filter((t) => !t.completedAt);

  const speechToggle = button(settings.speech ? "🔊" : "🔇", "btn-icon", () => {
    settings = { ...settings, speech: !settings.speech };
    saveSettings(settings);
    if (!settings.speech) stopSpeaking();
    renderHome();
  });
  speechToggle.setAttribute(
    "aria-label",
    settings.speech ? "よみあげを とめる" : "よみあげを つける"
  );

  const header = el("div", { class: "app-header" }, [
    el("h1", { class: "app-title" }, [
      el("img", { src: "./icon.svg", alt: "" }),
      "たまゆらβ"
    ]),
    speechToggle
  ]);

  const inputCard = el("div", { class: "card" }, [
    el("p", { style: "margin:0 0 10px; font-weight:700; font-size:20px;" }, [
      "やることを おしえてね"
    ]),
    inputWithMic("れい: へやを かたづける", (text) => void startTask(text))
  ]);

  const screen = el("div", { class: "screen" }, [header, inputCard]);

  // いまのモードを常に表示(AIが動いているかどうかを見えるようにする)
  const modeLabel = settings.preferSimple
    ? "モード: かんたん(AIなし)— せっていで AIに かえられるよ"
    : simpleModeNotice
      ? "モード: かんたん(AIが つかえませんでした)— くわしくは「せってい」へ"
      : assistant?.kind === "ai"
        ? "モード: AI(じゅんびOK)"
        : "モード: AI(はじめて つかうときに じゅんびするよ)";
  screen.append(el("p", { class: "note", style: "text-align:center;" }, [modeLabel]));

  if (active.length > 0) {
    screen.append(el("p", { class: "section-label" }, ["とちゅうの やること"]));
    const list = el("div", { class: "task-list" });
    for (const task of active) {
      const doneCount = task.steps.filter((s) => s.done).length;
      const item = button("", "task-item", () => {
        saveCurrentTaskId(task.id);
        renderSteps(task.id);
      });
      item.append(
        el("span", { class: "task-emoji", "aria-hidden": "true" }, ["📝"]),
        el("span", {}, [
          task.title,
          el("br"),
          el("span", { class: "task-meta" }, [`${doneCount} / ${task.steps.length} ステップ できた`])
        ])
      );
      list.append(item);
    }
    screen.append(list);
  }

  const parentLink = el(
    "a",
    {
      href: "./lp.html",
      class: "btn-ghost",
      style: "display:block; text-align:center; text-decoration:none;"
    },
    ["おうちの かたへ(このアプリの せつめい)"]
  );

  screen.append(
    button("📄 きろくを 見る(PDFに できるよ)", "btn btn-soft", renderReport),
    button("せってい と データ", "btn-ghost", renderSettingsScreen),
    parentLink
  );

  show(screen);
}

function renderSettingsScreen(): void {
  // AIの状態診断(なぜ「かんたんモード」になったかを見えるようにする)
  const diagWebgpu = el("p", { style: "margin:0" }, ["WebGPU(AIの きのう): しらべているよ…"]);
  void webgpuSupported().then((ok) => {
    diagWebgpu.textContent = ok
      ? "WebGPU(AIの きのう): ✅ つかえます"
      : "WebGPU(AIの きのう): ❌ つかえません";
  });
  const diagCard = el("div", { class: "card" }, [
    el("p", { style: "margin:0 0 6px; font-weight:700" }, ["AIの じょうたい"]),
    el("p", { style: "margin:0" }, [
      `いまのモード: ${settings.preferSimple ? "かんたん(AIなし)" : assistant?.kind === "ai" ? "AI(じゅんびOK)" : simpleModeNotice ? "かんたん(AIが つかえませんでした)" : "AI(みじゅんび)"}`
    ]),
    diagWebgpu,
    el("p", { style: "margin:0" }, [
      `ひらきかた: ${location.protocol === "https:" ? "✅ https" : `❌ ${location.protocol.replace(":", "")}(httpsで ひらいてください)`}`
    ]),
    el("p", { style: "margin:0" }, [
      `つかうモデル: ${currentModelId() === MODEL_LARGE ? "Qwen3-1.7B(かしこい)" : "Qwen3-0.6B(ふつう)"}` +
        (assistant?.kind === "ai" && assistant.modelId ? `【よみこみずみ: ${assistant.modelId}】` : "")
    ])
  ]);
  if (lastAiError) {
    diagCard.append(
      el("p", { class: "note", style: "margin:6px 0 0; word-break:break-all;" }, [`きろく: ${lastAiError}`])
    );
  }

  const screen = el("div", { class: "screen" }, [
    el("h1", { class: "app-title" }, ["せってい"]),
    diagCard,
    el("div", { class: "card" }, [
      el("p", { style: "margin:0" }, [
        "このアプリの データは ぜんぶ この たんまつの 中だけに ほぞんされるよ。",
        el("br"),
        "アカウントも つうしんりょう(AIの ダウンロードいがい)も いらないよ。"
      ])
    ]),
    button(
      settings.preferSimple ? "AIモードに もどす(ダウンロードあり)" : "かんたんモードに きりかえる",
      "btn btn-soft",
      () => {
        settings = { ...settings, preferSimple: !settings.preferSimple };
        saveSettings(settings);
        assistant = null;
        simpleModeNotice = false;
        lastAiError = null;
        renderSettingsScreen();
      }
    ),
    button(
      currentModelId() === MODEL_LARGE
        ? "AIモデルを「ふつう(0.6B)」に もどす"
        : "AIモデルを「かしこい(1.7B)」に かえる",
      "btn btn-soft",
      () => {
        const toLarge = currentModelId() !== MODEL_LARGE;
        if (toLarge) {
          if (
            !window.confirm(
              "かしこいモデル(Qwen3-1.7B)に かえますか?\nあたらしく 約1.1GBの ダウンロードが ひつようです(Wi-Fi推奨)。"
            )
          ) {
            return;
          }
          localStorage.setItem(MODEL_OVERRIDE_KEY, MODEL_LARGE);
        } else {
          localStorage.removeItem(MODEL_OVERRIDE_KEY);
        }
        assistant = null;
        simpleModeNotice = false;
        lastAiError = null;
        renderSettingsScreen();
      }
    ),
    button("データを ぜんぶ けす", "btn", () => {
      if (window.confirm("ほんとうに データを ぜんぶ けしますか?(もとに もどせません)")) {
        clearAllData();
        settings = loadSettings();
        renderHome();
      }
    }),
    el("p", { class: "note", style: "text-align:center;" }, [
      "AIモデル: Qwen3 © Alibaba Cloud(Apache License 2.0)",
      el("br"),
      "推論エンジン: WebLLM / MLC AI(Apache License 2.0)"
    ]),
    button("← ホームへ もどる", "btn-ghost", renderHome)
  ]);
  show(screen);
}

// ---------------------------------------------------------------------------
// タスク分解の流れ
// ---------------------------------------------------------------------------

async function startTask(text: string): Promise<void> {
  const token = navToken;
  const ai = await ensureAssistant();
  const thinking = renderThinking("ステップに わけているよ");
  try {
    const result = await ai.decompose(text, undefined, (chars) =>
      thinking.setDetail(`かんがえて かいているよ… ${chars}もじ`)
    );
    if (token !== navToken) return; // とちゅうでホームに戻っていたら何もしない
    lastDecomposeWasFallback = ai.kind === "simple";
    if (result.type === "question") {
      renderClarify(text, result.question);
    } else {
      createAndPreviewTask(text, result.steps);
    }
  } catch (err) {
    console.warn("decompose failed, using simple mode for this task:", err);
    lastAiError = `AIの こたえを よみとれませんでした: ${String(err).slice(0, 300)}`;
    if (token !== navToken) return;
    lastDecomposeWasFallback = true;
    const simple = createSimpleAssistant();
    const result = await simple.decompose(text);
    if (result.type === "steps") createAndPreviewTask(text, result.steps);
  }
}

function renderClarify(taskText: string, question: string): void {
  const screen = el("div", { class: "screen" }, [
    el("p", { class: "task-heading" }, [`「${taskText}」について`]),
    el("div", { class: "card step-card" }, [
      el("p", { class: "step-number" }, ["しつもんが あるよ"]),
      el("p", { class: "step-title", style: "font-size:24px;" }, [question])
    ]),
    inputWithMic("こたえを かいてね", (answer) => void answerClarify(taskText, question, answer)),
    button("← やめて ホームへ", "btn-ghost", renderHome)
  ]);
  show(screen);
  maybeSpeak(question);
}

async function answerClarify(taskText: string, question: string, answer: string): Promise<void> {
  const token = navToken;
  const ai = await ensureAssistant();
  const thinking = renderThinking("ステップに わけているよ");
  try {
    const result = await ai.decompose(taskText, { question, answer }, (chars) =>
      thinking.setDetail(`かんがえて かいているよ… ${chars}もじ`)
    );
    if (token !== navToken) return;
    if (result.type === "steps") {
      lastDecomposeWasFallback = ai.kind === "simple";
      createAndPreviewTask(taskText, result.steps);
      return;
    }
  } catch (err) {
    console.warn("clarify decompose failed:", err);
    lastAiError = `AIの こたえを よみとれませんでした: ${String(err).slice(0, 300)}`;
  }
  if (token !== navToken) return;
  // 2回目も質問が返る・失敗する場合は、かんたんモードで必ず前に進める
  lastDecomposeWasFallback = true;
  const simple = createSimpleAssistant();
  const result = await simple.decompose(`${taskText}(${answer})`);
  if (result.type === "steps") createAndPreviewTask(taskText, result.steps);
}

function createAndPreviewTask(title: string, steps: { title: string; minutes: number }[]): void {
  const task: Task = {
    id: newId(),
    title,
    createdAt: Date.now(),
    steps: steps.map((s) => ({ id: newId(), title: s.title, minutes: s.minutes, done: false }))
  };
  upsertTask(task);
  saveCurrentTaskId(task.id);
  renderPreview(task.id);
}

// ---------------------------------------------------------------------------
// 見通し(プレビュー)画面: 全ステップと合計時間を先に見せる
// ---------------------------------------------------------------------------

function renderPreview(taskId: string): void {
  const task = loadTasks().find((t) => t.id === taskId);
  if (!task) return renderHome();
  const total = task.steps.reduce((sum, s) => sum + s.minutes, 0);

  const list = el("ul", { class: "report-steps", style: "gap:10px;" });
  task.steps.forEach((s, i) => {
    list.append(
      el("li", {}, [
        el("span", { class: "report-check todo" }, [`${i + 1}.`]),
        el("span", {}, [`${s.title}(${minutesLabel(s.minutes)}くらい)`])
      ])
    );
  });

  const screen = el("div", { class: "screen" }, [
    el("p", { class: "task-heading" }, [`「${task.title}」を こんなふうに わけたよ`]),
    el("div", { class: "card" }, [list]),
    el("p", { class: "task-heading" }, [`ぜんぶで だいたい ${minutesLabel(total)}`]),
    button("はじめる!", "btn btn-green", () => renderSteps(task.id)),
    button("← やめて ホームへ", "btn-ghost", renderHome)
  ]);
  if (lastDecomposeWasFallback) {
    screen.insertBefore(
      el("p", { class: "note", style: "text-align:center;" }, [
        "※ AIは つかわず、きほんの わけかたに したよ(くわしくは「せってい」を みてね)"
      ]),
      screen.children[1]
    );
  }
  show(screen);
  maybeSpeak(`こんなふうに わけたよ。ぜんぶで だいたい ${minutesLabel(total)}だよ。`);
}

// ---------------------------------------------------------------------------
// ステップ実行画面: 1画面1ステップ
// ---------------------------------------------------------------------------

function renderSteps(taskId: string): void {
  const task = loadTasks().find((t) => t.id === taskId);
  if (!task) return renderHome();

  const index = task.steps.findIndex((s) => !s.done);
  if (index < 0) return renderCelebrate(task);
  const step = task.steps[index];

  const dots = el("div", { class: "step-progress", "aria-hidden": "true" });
  task.steps.forEach((s, i) => {
    dots.append(
      el("div", { class: `step-dot ${s.done ? "done" : ""} ${i === index ? "now" : ""}` })
    );
  });

  const readBtn = button("🔊 よんで", "btn btn-soft", () => speak(step.title));

  const screen = el("div", { class: "screen" }, [
    el("p", { class: "task-heading" }, [task.title]),
    dots,
    el("div", { class: "card step-card" }, [
      el("p", { class: "step-number" }, [`ステップ ${index + 1} / ${task.steps.length}`]),
      el("p", { class: "step-title" }, [step.title]),
      el("span", { class: "step-minutes" }, [`めやす: ${minutesLabel(step.minutes)}くらい`])
    ]),
    button("できた!", "btn btn-green", () => completeStep(task, step)),
    el("div", { class: "row" }, [
      button("🤔 こまった・しつもん", "btn btn-soft", () => openHelpOverlay(task, step)),
      readBtn
    ]),
    button("← ホームへ(とちゅうで やすんでも だいじょうぶ)", "btn-ghost", renderHome)
  ]);
  show(screen);
  maybeSpeak(step.title);
}

function completeStep(task: Task, step: Step): void {
  step.done = true;
  const allDone = task.steps.every((s) => s.done);
  if (allDone) task.completedAt = Date.now();
  upsertTask(task);
  if (allDone) renderCelebrate(task);
  else renderSteps(task.id);
}

function renderCelebrate(task: Task): void {
  if (!task.completedAt) {
    task.completedAt = Date.now();
    upsertTask(task);
  }
  saveCurrentTaskId(null);
  const screen = el("div", { class: "screen celebrate-screen" }, [
    el("div", { class: "stars", "aria-hidden": "true" }, ["🌟🌟🌟"]),
    el("p", { class: "celebrate-big" }, ["ぜんぶ できたね!"]),
    el("p", {}, [`「${task.title}」、よく がんばりました!`]),
    button("📄 きろくを 見る", "btn btn-soft", renderReport),
    button("ホームへ もどる", "btn btn-primary", renderHome)
  ]);
  show(screen);
  maybeSpeak("ぜんぶできたね。よくがんばりました!");
}

// ---------------------------------------------------------------------------
// こまったとき(Q&A)オーバーレイ
// ---------------------------------------------------------------------------

function openHelpOverlay(task: Task, step: Step): void {
  const chat = el("div", { style: "display:flex; flex-direction:column; gap:10px;" });

  const ask = async (question: string) => {
    chat.append(el("div", { class: "chat-q" }, [question]));
    const answerNode = el("div", { class: "chat-a thinking-dots" }, ["かんがえているよ"]);
    chat.append(answerNode);
    answerNode.scrollIntoView({ block: "end" });
    const ai = await ensureAssistant();
    try {
      const answer = await ai.help(task.title, step.title, question);
      answerNode.classList.remove("thinking-dots");
      answerNode.textContent = answer;
      maybeSpeak(answer);
    } catch (err) {
      console.warn("help failed:", err);
      answerNode.classList.remove("thinking-dots");
      answerNode.textContent = "うまく こたえられなかったよ。おうちの人に きいてみてね。";
    }
    answerNode.scrollIntoView({ block: "end" });
  };

  const close = () => {
    stopListening();
    overlayRoot.replaceChildren();
  };

  const panel = el("div", { class: "overlay-panel", role: "dialog", "aria-label": "しつもん" }, [
    el("p", { style: "margin:0; font-weight:700; font-size:20px;" }, ["こまったこと、きいてね"]),
    el("p", { class: "note", style: "margin:0;" }, [`いまの ステップ:「${step.title}」`]),
    chat,
    inputWithMic("なにに こまってる?", (q) => void ask(q)),
    button("とじる", "btn-ghost", close)
  ]);

  const overlay = el("div", { class: "overlay" }, [panel]);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlayRoot.replaceChildren(overlay);
}

// ---------------------------------------------------------------------------
// きろく(レポート / PDF)画面
// ---------------------------------------------------------------------------

function renderReport(): void {
  const tasks = loadTasks();

  const card = el("div", { class: "card" });
  if (tasks.length === 0) {
    card.append(el("p", { style: "margin:0" }, ["まだ きろくが ないよ。やることを はじめてみよう!"]));
  }
  for (const task of tasks) {
    const doneCount = task.steps.filter((s) => s.done).length;
    const title = el("p", { class: "report-title" }, [task.title]);
    if (task.completedAt) title.append(el("span", { class: "badge-done" }, ["ぜんぶ できた!"]));

    const steps = el("ul", { class: "report-steps" });
    for (const s of task.steps) {
      steps.append(
        el("li", {}, [
          el("span", { class: `report-check ${s.done ? "done" : "todo"}` }, [s.done ? "✓" : "○"]),
          el("span", {}, [`${s.title}(めやす ${minutesLabel(s.minutes)})`])
        ])
      );
    }

    const section = el("div", { class: "report-task" }, [
      title,
      el("p", { class: "report-meta" }, [
        `${formatDate(task.createdAt)} ・ ${doneCount} / ${task.steps.length} ステップ できた`
      ]),
      steps
    ]);

    const del = button("この きろくを けす", "btn-ghost print-hide", () => {
      if (window.confirm(`「${task.title}」の きろくを けしますか?`)) {
        deleteTask(task.id);
        renderReport();
      }
    });
    section.append(del);
    card.append(section);
  }

  const screen = el("div", { class: "screen" }, [
    el("h1", { class: "app-title" }, ["がんばりの きろく"]),
    card,
    button("🖨️ PDFに ほぞん(いんさつ)", "btn btn-primary print-hide", () => window.print()),
    el("p", { class: "note print-hide" }, [
      "いんさつの がめんで「PDFに ほぞん」を えらぶと、PDFファイルに できるよ。"
    ]),
    button("← ホームへ もどる", "btn-ghost print-hide", renderHome)
  ]);
  show(screen);
}

// ---------------------------------------------------------------------------
// 起動: とちゅうのタスクがあれば つづきから
// ---------------------------------------------------------------------------

function boot(): void {
  const currentId = loadCurrentTaskId();
  if (currentId) {
    const task = loadTasks().find((t) => t.id === currentId && !t.completedAt);
    if (task && task.steps.some((s) => s.done)) {
      renderSteps(task.id);
      return;
    }
  }
  renderHome();
}

boot();
