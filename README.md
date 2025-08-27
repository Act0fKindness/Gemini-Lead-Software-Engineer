# Gemini-Lead-Software-Engineer

This project provides a command line agent that uses Google's Gemini models to search, edit, and test code within a workspace. It demonstrates a minimal "AI engineer" loop with tool calling and gated writes.

## Installation

```bash
npm install
```

## Usage

```bash
# dry run
WORKSPACE=/path/to/repo node ai-engineer.mjs "Diagnose failing tests"

# allow file writes
WORKSPACE=/path/to/repo node ai-engineer.mjs "Refactor auth module" --approve
```

Configuration for models and runners lives under `config/` and logs are written to `logs/sessions` and `logs/patches`.
