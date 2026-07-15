/**
 * 音声入出力(Web Speech API)の薄いラッパー。
 * どちらも対応していない環境では静かに無効化される。
 */

// SpeechRecognition は TypeScript の DOM 型定義に無いため最小限を宣言する
interface RecognitionResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function recognitionCtor(): (new () => Recognition) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => Recognition) | null;
}

export function speechInputSupported(): boolean {
  return recognitionCtor() !== null;
}

let activeRecognition: Recognition | null = null;

/**
 * 1回分の音声入力を開始する。認識結果(または空文字)を onDone で返す。
 * 返り値の関数を呼ぶとキャンセルできる。
 */
export function listenOnce(onDone: (text: string) => void): () => void {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    onDone("");
    return () => {};
  }
  stopListening();
  const rec = new Ctor();
  activeRecognition = rec;
  rec.lang = "ja-JP";
  rec.interimResults = false;
  rec.maxAlternatives = 1;

  let finished = false;
  const finish = (text: string) => {
    if (finished) return;
    finished = true;
    activeRecognition = null;
    onDone(text);
  };

  rec.onresult = (e) => {
    const text = e.results[0]?.[0]?.transcript ?? "";
    finish(text.trim());
  };
  rec.onerror = () => finish("");
  rec.onend = () => finish("");
  try {
    rec.start();
  } catch {
    finish("");
  }
  return () => {
    try {
      rec.abort();
    } catch {
      /* noop */
    }
    finish("");
  };
}

export function stopListening(): void {
  if (activeRecognition) {
    try {
      activeRecognition.abort();
    } catch {
      /* noop */
    }
    activeRecognition = null;
  }
}

export function speechOutputSupported(): boolean {
  return "speechSynthesis" in window;
}

/** ゆっくり・やさしく読み上げる(設定でOFFのときは呼び出し側で抑止) */
export function speak(text: string): void {
  if (!speechOutputSupported()) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    u.rate = 0.9;
    u.pitch = 1.05;
    window.speechSynthesis.speak(u);
  } catch {
    /* noop */
  }
}

export function stopSpeaking(): void {
  if (!speechOutputSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* noop */
  }
}
