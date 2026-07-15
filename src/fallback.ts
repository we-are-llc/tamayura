import type { Assistant, DecomposeResult } from "./types.ts";

/**
 * かんたんモード:
 * WebGPU非対応端末や、AIモデルのロードに失敗したときのフォールバック。
 * よくある「やること」はテンプレートで、それ以外は汎用ステップで分解する。
 * ネットワークもモデルダウンロードも不要で、必ず動く。
 */

interface Template {
  match: RegExp;
  steps: [title: string, minutes: number][];
}

const TEMPLATES: Template[] = [
  {
    match: /かたづけ|片付け|片づけ|そうじ|掃除/,
    steps: [
      ["ごみを ごみばこに いれる", 3],
      ["ふくを かごに いれる", 3],
      ["おもちゃや ものを もとの ばしょに もどす", 5],
      ["つくえや ゆかの うえを きれいにする", 5],
      ["さいごに へやを みわたして かくにん", 2]
    ]
  },
  {
    match: /しゅくだい|宿題|べんきょう|勉強|ドリル/,
    steps: [
      ["つくえの うえを あける", 2],
      ["きょうの しゅくだいを ぜんぶ ならべる", 2],
      ["どれから やるか 1つ えらぶ", 1],
      ["えらんだ 1つを やる", 15],
      ["おわったら ランドセルや かばんに しまう", 2]
    ]
  },
  {
    match: /おふろ|お風呂|風呂|シャワー/,
    steps: [
      ["きがえと タオルを よういする", 3],
      ["ふくを ぬいで かごに いれる", 2],
      ["からだと かみを あらう", 10],
      ["からだを ふいて きがえる", 5],
      ["ぬいだ ふくを せんたくかごへ", 1]
    ]
  },
  {
    match: /はみがき|歯みがき|歯磨き|歯/,
    steps: [
      ["はぶらしに はみがきこを つける", 1],
      ["うえの はを みがく", 2],
      ["したの はを みがく", 2],
      ["くちを ゆすぐ", 1],
      ["はぶらしを あらって もどす", 1]
    ]
  },
  {
    match: /したく|支度|じゅんび|準備|あさ|朝|でかけ|出かけ|がっこう|学校/,
    steps: [
      ["もっていくものを こえに だして いう", 2],
      ["もちものを 1つずつ かばんに いれる", 5],
      ["ふくを きがえる", 5],
      ["かがみで みだしなみを チェック", 2],
      ["わすれものが ないか さいごに かくにん", 2]
    ]
  },
  {
    match: /ごはん|食事|たべ|食べ|あさごはん|ばんごはん/,
    steps: [
      ["てを あらう", 2],
      ["ごはんを テーブルに はこぶ", 3],
      ["すわって いただきますを する", 1],
      ["ごはんを たべる", 15],
      ["おさらを ながしに もっていく", 2]
    ]
  }
];

const GENERIC_STEPS: [string, number][] = [
  ["つかうものを あつめる", 3],
  ["さいしょの ひとつだけ やってみる", 5],
  ["つづきを すこしずつ すすめる", 10],
  ["おわったか じぶんで たしかめる", 2],
  ["つかったものを かたづける", 3]
];

const HELP_MESSAGES = [
  "むずかしいときは、もっと ちいさく わけて、1つだけ やってみよう。",
  "こまったら、ふかく いきを すって、ひとやすみ しても いいよ。",
  "どうしても わからないときは、おうちの人に きいてみてね。"
];

export function createSimpleAssistant(): Assistant {
  let helpIndex = 0;
  return {
    kind: "simple",
    async decompose(taskText: string): Promise<DecomposeResult> {
      const template = TEMPLATES.find((t) => t.match.test(taskText));
      const steps = (template ? template.steps : GENERIC_STEPS).map(([title, minutes]) => ({
        title,
        minutes
      }));
      return { type: "steps", steps };
    },
    async help(): Promise<string> {
      const msg = HELP_MESSAGES[helpIndex % HELP_MESSAGES.length];
      helpIndex++;
      return msg;
    }
  };
}
