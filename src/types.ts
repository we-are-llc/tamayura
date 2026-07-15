/** 1つの小さなステップ */
export interface Step {
  id: string;
  title: string;
  /** 所要時間のめやす(分) */
  minutes: number;
  done: boolean;
}

/** 子どもが入力した「やること」1件 */
export interface Task {
  id: string;
  title: string;
  createdAt: number;
  completedAt?: number;
  steps: Step[];
}

export interface Settings {
  /** 音声読み上げ ON/OFF(感覚過敏への配慮で切り替え可能) */
  speech: boolean;
  /** モデルダウンロードの説明に同意済みか */
  downloadAccepted: boolean;
  /** AIを使わず「かんたんモード」を選んだか */
  preferSimple: boolean;
}

/** AIによるタスク分解の結果 */
export type DecomposeResult =
  | { type: "steps"; steps: { title: string; minutes: number }[] }
  | { type: "question"; question: string };

/** タスク分解・質問応答を提供するエンジンの共通インターフェース */
export interface Assistant {
  /** AI(WebLLM)か、テンプレートの「かんたんモード」か */
  kind: "ai" | "simple";
  decompose(taskText: string, clarify?: { question: string; answer: string }): Promise<DecomposeResult>;
  help(taskTitle: string, stepTitle: string, question: string): Promise<string>;
}
