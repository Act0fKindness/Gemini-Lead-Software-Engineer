#!/usr/bin/env bash
set -e

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node $(node -v) detected. Please use Node >= 20."
  exit 1
fi

npm install

if ! node -e "require.resolve('@google/genai')" >/dev/null 2>&1; then
  echo "Missing @google/genai. Run: npm i @google/genai"
  exit 1
fi

if [ -z "$GEMINI_API_KEY" ]; then
  echo "Hint: GEMINI_API_KEY is not set. export GEMINI_API_KEY=your_key"
else
  echo "GEMINI_API_KEY detected."
fi

echo "Setup complete."
