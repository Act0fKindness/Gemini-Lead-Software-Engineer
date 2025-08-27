# Gemini-Lead-Software-Engineer

This project provides a command line agent that uses Google's Gemini models to search, edit, and test code within a workspace. It demonstrates a minimal "AI engineer" loop with tool calling and gated writes.

## Quick start

```bash
cd ~/ai-engineer
npm run setup
export GEMINI_API_KEY="AIzaSyAZrrxtFuj2T_VBtx8v585iB6-4jr0ZEKs"; export WORKSPACE="/var/www/html/Uni-Sign"
npm run smoke   # should print: pong.
node ai-engineer.mjs "Diagnose failing login and propose patch"
node ai-engineer.mjs "Implement fix" --approve
```

## Troubleshooting

- Missing deps → `npm i`
- Model not found → switch to `gemini-2.5-flash`
- Permission denied in WORKSPACE → adjust directory permissions

Configuration for models and runners lives under `config/` and logs are written to `logs/sessions` and `logs/patches`.
