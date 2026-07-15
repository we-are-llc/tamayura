---
name: verify
description: たまゆらステップ(ブラウザ内LLMタスク分解アプリ)の動作検証手順
---

# Verify: たまゆらステップ

## Build & launch

```bash
npm install
npm run build                       # tsc --noEmit + vite build
npm run preview -- --port 4173 &    # serves dist/ at http://localhost:4173
```

## Drive (headless Chromium + playwright-core)

- Chromium is at `/opt/pw-browsers/chromium` — launch with `executablePath`, do NOT `playwright install`.
- Install `playwright-core` in the scratchpad, not in this repo.
- Headless containers have **no WebGPU adapter** (`requestAdapter()` → null), so the app
  automatically runs in「かんたんモード」(template fallback). That path is fully drivable:
  home → input → preview → steps → help overlay → celebrate → report.
- The WebLLM/AI path (model download + Qwen3 inference) cannot be exercised headless;
  verify it manually on a WebGPU-capable machine.

## Flows worth driving

1. Task input `へやを かたづける` → template steps preview (total minutes shown) → はじめる.
2. Complete a step or two, then `page.reload()` → must resume at the first undone step.
3. Help overlay (こまった・しつもん) → ask → canned answer appears.
4. Finish all steps → celebrate screen → きろく (report) → `page.pdf()` succeeds and
   `emulateMedia({media:"print"})` hides `.print-hide` buttons.
5. Probes: empty input stays on home; unknown task gets generic steps;
   「データを ぜんぶ けす」(accept the confirm dialog) empties home.

## Gotchas

- `window.confirm` is used for deletions — register `page.once("dialog", d => d.accept())` first.
- Buttons are matched easiest by text (`text=こまった・しつもん`); inputs by `input.text-input`.
- Speech (mic / TTS) buttons are hidden or inert headless — not verifiable here.
