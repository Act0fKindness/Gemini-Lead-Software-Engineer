#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { execa } from 'execa';
import { searchFiles, readFile, applyPatch } from './tools/files.mjs';
import { runTests, runCmd } from './tools/cmd.mjs';
import { gitMakeBranch, gitCommit, gitDiff } from './tools/git.mjs';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

const defaults = JSON.parse(await fs.readFile(path.join(__dirname, 'config', 'defaults.json'), 'utf8'));
const runners = JSON.parse(await fs.readFile(path.join(__dirname, 'config', 'runners.json'), 'utf8'));
const args = process.argv.slice(2);
const approve = args.includes('--approve');
const autoInstall = args.includes('--auto-install');
const prompt = args.filter(a => !a.startsWith('--')).join(' ');
const workspace = process.env.WORKSPACE || defaults.workspace;
const byteLimit = defaults.byteLimit || 120000;

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const sessionLog = path.join(__dirname, 'logs', 'sessions', `${timestamp}.jsonl`);
const patchesDir = path.join(__dirname, 'logs', 'patches');

async function log(entry) {
  await fs.appendFile(sessionLog, JSON.stringify(entry) + '\n');
}

function redact(str) {
  return str.replace(/([A-Z_]*KEY|PASSWORD)=\S+/gi, '$1=[redacted]');
}

async function preflight({ autoInstall, workspace, approve }) {
  const v = Number(process.versions.node.split('.')[0]);
  if (v < 20) {
    console.error(`Node ${process.versions.node} detected. Please use Node >= 20.`);
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set. export GEMINI_API_KEY=...');
    process.exit(1);
  }
  let genaiModule;
  try {
    genaiModule = await import('@google/genai');
  } catch {
    if (autoInstall) {
      console.log('Installing @google/genai locally...');
      await execa('npm', ['i', '@google/genai'], { stdio: 'inherit' });
      genaiModule = await import('@google/genai');
    } else {
      console.error('Missing @google/genai. Run: npm i @google/genai');
      process.exit(1);
    }
  }
  try {
    await fs.access(workspace);
  } catch {
    console.error(`WORKSPACE ${workspace} is not accessible.`);
    process.exit(1);
  }
  if (approve) {
    try {
      await fs.access(workspace, fs.constants.W_OK);
    } catch {
      console.warn(`WORKSPACE ${workspace} is not writable; --approve may fail.`);
    }
  }
  return genaiModule;
}

const genaiModule = await preflight({ autoInstall, workspace, approve });

async function detectRunner() {
  try { await fs.access(path.join(workspace, 'package.json')); return 'node'; } catch {}
  try { await fs.access(path.join(workspace, 'composer.json')); return 'php'; } catch {}
  try { await fs.access(path.join(workspace, 'pyproject.toml')); return 'python'; } catch {}
  return 'fallback';
}

const runner = await detectRunner();
const testCommand = runners[runner]?.test || runners.fallback.test;

const toolImpls = {
  search_files: async ({ query, globs = ['**/*'], max_results = 20 }) => {
    return await searchFiles(query, globs, max_results, { workspace });
  },
  read_file: async ({ filepath, max_bytes = byteLimit }) => {
    return await readFile(filepath, { workspace, byteLimit: max_bytes });
  },
  run_tests: async ({ cmd = testCommand, timeout_ms = 600000 }) => {
    return await runTests(cmd, timeout_ms);
  },
  apply_patch: async ({ filepath, new_content, rationale }) => {
    return await applyPatch(filepath, new_content, { workspace, approve: approve && !defaults.writeGating ? true : approve, patchesDir });
  },
  git_make_branch: async ({ name }) => gitMakeBranch(name),
  git_commit: async ({ message }) => gitCommit(message),
  git_diff: async () => gitDiff(),
  run_cmd: async ({ command }) => runCmd(command)
};

const toolDefs = [
  { name: 'search_files', description: 'Search for text in files', parameters: { type: 'object', properties: { query: { type: 'string' }, globs: { type: 'array', items: { type: 'string' } }, max_results: { type: 'integer' } }, required: ['query'] } },
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { filepath: { type: 'string' }, max_bytes: { type: 'integer' } }, required: ['filepath'] } },
  { name: 'run_tests', description: 'Run project tests', parameters: { type: 'object', properties: { cmd: { type: 'string' }, timeout_ms: { type: 'integer' } } } },
  { name: 'apply_patch', description: 'Apply patch to file', parameters: { type: 'object', properties: { filepath: { type: 'string' }, new_content: { type: 'string' }, rationale: { type: 'string' } }, required: ['filepath', 'new_content'] } },
  { name: 'git_make_branch', description: 'Create git branch', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'git_commit', description: 'Commit changes', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
  { name: 'git_diff', description: 'Show git diff', parameters: { type: 'object', properties: {} } },
  { name: 'run_cmd', description: 'Run shell command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }
];

const { GoogleGenAI } = genaiModule;
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
let model = defaults.model;

// --- response normalizer: supports new + legacy shapes
function normalizeResponse(resp) {
  if (resp && (typeof resp.text === 'string' || Array.isArray(resp?.functionCalls))) {
    return { text: resp.text ?? '', functionCalls: resp.functionCalls ?? [] };
  }
  const cand = resp?.response?.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const text = parts.filter(p => typeof p?.text === 'string').map(p => p.text).join('\n');
  const functionCalls = parts
    .map(p => p?.functionCall)
    .filter(Boolean)
    .map(fc => ({ name: fc.name, args: fc.args || {} }));
  return { text, functionCalls };
}

async function modelTurn({ history, tools }) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await ai.models.generateContent({
        model,
        contents: history,
        tools,
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
      });
      const norm = normalizeResponse(resp);
      if (!norm.text && (!norm.functionCalls || norm.functionCalls.length === 0)) {
        lastErr = new Error('Empty model response; will retry');
        continue;
      }
      return norm;
    } catch (e) {
      if (e.status === 404 && model !== 'gemini-2.5-flash') {
        model = 'gemini-2.5-flash';
        continue;
      }
      lastErr = e;
      await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
  throw lastErr || new Error('Model did not return usable output');
}

const history = [
  { role: 'user', parts: [{ text: `You are an AI engineering assistant. Use provided tools to help with user requests.\n\nUser request: ${prompt}` }] }
];

for (let i = 0; i < defaults.maxToolIters; i++) {
  const resp = await modelTurn({ history, tools: toolDefs });

  if (resp.functionCalls?.length) {
    for (const fc of resp.functionCalls) {
      await log({ role: 'model', functionCall: { name: fc.name, args: fc.args } });
      const impl = toolImpls[fc.name];
      if (!impl) {
        history.push({ role: 'model', parts: [{ text: `Unknown tool ${fc.name}` }] });
        continue;
      }
      const result = await impl(fc.args);
      await log({ role: 'tool', name: fc.name, result: redact(JSON.stringify(result)) });
      history.push({ role: 'model', parts: [{ functionCall: { name: fc.name, args: fc.args } }] });
      history.push({ role: 'user', parts: [{ functionResponse: { name: fc.name, response: JSON.stringify(result) } }] });
    }
    continue;
  }

  const out = (resp.text ?? '').trim();
  if (out) {
    await log({ role: 'model', text: redact(out) });
    console.log(out);
  }
  break;
}
