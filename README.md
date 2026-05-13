<p align="center">
  <img src="gemma-extruded-app.png" alt="Gemma Chat" width="180" />
</p>

<h1 align="center">Gemma Chat</h1>

<p align="center">
  <strong>Vibe code locally or with cloud models.</strong><br/>
  A coding agent powered by Google's Gemma 4 on Apple MLX, with optional Vercel AI Gateway models.<br/>
  Local models still work offline after download.
</p>

---

## The Idea

<img width="960" height="593" alt="Gemma4-Vibecoding" src="https://github.com/user-attachments/assets/4c45a83c-7c87-4c70-a293-fe475b7e34fa" />


What if you could vibe code from an airplane? Or a cabin with no cell signal? Or just... without sending your code to someone else's server?

**Gemma Chat** is an open-source Electron app that runs Gemma 4 natively on Apple Silicon, with optional cloud models through Vercel AI Gateway. You describe what you want to build, and it writes the code — HTML, CSS, JavaScript, multi-file projects — with a live preview that updates as the model types. Local Gemma models need no internet connection after the initial model download.

It's a proof-of-concept for **fully offline, local-first vibe coding** using a small open model. The model is ~3 GB. The whole thing runs on your laptop.

## How It Works

1. **Describe what you want to build** — "A retro calculator app" or "A landing page for a coffee shop"
2. **Watch it code** — Gemma writes files character-by-character with a live preview
3. **Iterate** — Ask for changes, it edits the files and the preview updates in real-time

Local models run via [MLX-LM](https://github.com/ml-explore/mlx-examples/tree/main/llms/mlx_lm), Apple's framework for running LLMs on Apple Silicon. Cloud models route chat completions through [Vercel AI Gateway](https://vercel.com/docs/ai-gateway).

## Features

- 🛠 **Build Mode** — Coding agent with a live preview canvas. Writes multi-file projects into a sandboxed workspace.
- 💬 **Chat Mode** — Conversational AI with tool use (web search, URL fetch, calculator, bash).
- 🔄 **Model Switching** — Hot-swap between local Gemma variants and cloud Gateway models on the fly.
- 🎤 **Voice Input** — Local speech-to-text via in-browser Whisper.
- ✈️ **Works Offline** — Local Gemma models run without internet after the one-time model download.
- ☁️ **Cloud Models** — Vercel AI Gateway support, starting with Xiaomi MiMo V2.5 Pro.
- 💾 **Zero Config** — Python venv + MLX runtime auto-provisions on first launch.

## Available Models

| Model | Size | Best For |
|---|---|---|
| Gemma 4 E2B | ~1.5 GB | Fast Q&A, simple tasks |
| **Gemma 4 E4B** | **~3 GB** | **Recommended.** Speed + capability balance |
| Gemma 4 27B MoE | ~8 GB | Stronger reasoning (needs 16 GB+ RAM) |
| Gemma 4 31B | ~18 GB | Maximum quality (needs 32 GB+ RAM) |
| MiMo V2.5 Pro | Cloud | Vercel AI Gateway model for stronger coding and long-horizon tasks |

## Getting Started

**Requirements:** macOS on Apple Silicon, Python 3.10–3.13, Node 20+.

```bash
git clone https://github.com/ammaarreshi/gemma-chat-public.git
cd gemma-chat-public
npm install
npm run dev
```

First launch will auto-detect Python → create a venv → install MLX-LM → download the model (~3 GB) → ready to vibe code.

> **Tip:** Install Python via Homebrew if you don't have it: `brew install python@3.13`

To use Vercel AI Gateway models, set `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` before launching the app. In development, you can also put either value in `.env.local`.

### Building a Distributable

```bash
npm run dist
```

Produces a signed `.dmg` in `dist/`. Share it directly — recipients just drag to Applications.

## Tech Stack

| Layer | Tech |
|---|---|
| App Shell | Electron + Vite + React 19 + TypeScript + Tailwind |
| Model Runtime | MLX-LM (auto-installed into a local venv) |
| Cloud Models | Vercel AI Gateway OpenAI-compatible API |
| Speech-to-Text | transformers.js (Whisper, runs in-browser via WASM) |
| Workspace | Per-conversation sandboxed filesystem + local HTTP server |

## Architecture

```
src/
├── main/              Electron main process
│   ├── index.ts       Window + IPC + agent loop
│   ├── mlx.ts         MLX-LM venv install / server lifecycle / chat streaming
│   ├── gateway.ts     Vercel AI Gateway chat streaming
│   ├── workspace.ts   Per-conversation workspace + static file server
│   └── tools.ts       Tool definitions + system prompts + XML action parser
├── preload/           contextBridge API surface
├── renderer/src/
│   ├── components/
│   │   ├── Setup.tsx      First-run onboarding + download progress
│   │   ├── Chat.tsx       Main layout + model switcher
│   │   ├── Canvas.tsx     Preview / Code / Files tabs (Build mode)
│   │   ├── Message.tsx    Chat bubbles + tool cards + activity bar
│   │   ├── Composer.tsx   Input + mic button
│   │   └── Sidebar.tsx    Conversation list
│   └── lib/whisper.ts     Browser Whisper pipeline
└── shared/types.ts    IPC types + model registry
```

### Under the Hood

**Agent Loop** — In Build mode, each assistant turn streams tokens from the selected model runtime. XML `<action>` blocks are parsed from the stream, executed (file writes, bash commands, etc.), and results are fed back for the next turn. Up to 40 rounds per user message.

**Live Streaming** — As the model generates file content, partial writes are flushed to disk every ~450ms. The preview iframe reloads in real-time so you watch the page build itself.

**Tool Protocol** — Small models handle XML more reliably than JSON function calling, so tools are invoked via an XML-based format:

```xml
<action name="write_file">
<path>index.html</path>
<content>
<!doctype html>
...
</content>
</action>
```

## Credits

- [Gemma](https://ai.google.dev/gemma) by Google DeepMind
- [MLX](https://github.com/ml-explore/mlx) by Apple Machine Learning Research
- [transformers.js](https://github.com/huggingface/transformers.js) by Hugging Face

Created by [@ammaar](https://x.com/ammaar)

## License

MIT
