#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { GoogleGenerativeAI } from '@google/genai';
import { searchFiles, readFile, applyPatch } from './tools/files.mjs';
import { runTests, runCmd } from './tools/cmd.mjs';
import { gitMakeBranch, gitCommit, gitDiff } from './tools/git.mjs';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

const defaults = JSON.parse(await fs.readFile(path.join(__dirname, 'config', 'defaults.json'), 'utf8'));
const runners = JSON.parse(await fs.readFile(path.join(__dirname, 'config', 'runners.json'), 'utf8'));
const args = process.argv.slice(2);
const approve = args.includes('--approve');
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

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
let model = genAI.getGenerativeModel({ model: defaults.model });

const history = [
  { role: 'user', parts: [{ text: `You are an AI engineering assistant. Use provided tools to help with user requests.\n\nUser request: ${prompt}` }] }
];

for (let i = 0; i < defaults.maxToolIters; i++) {
  let response;
  try {
    response = await model.generateContent({ contents: history, tools: toolDefs });
  } catch (err) {
    if (err.status === 404 && defaults.model !== 'gemini-2.5-flash') {
      model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      response = await model.generateContent({ contents: history, tools: toolDefs });
    } else {
      throw err;
    }
  }
  const parts = response.response.candidates[0].content.parts;
  const functionCall = parts.find(p => p.functionCall);
  if (functionCall) {
    await log({ role: 'model', functionCall });
    const impl = toolImpls[functionCall.functionCall.name];
    if (!impl) {
      history.push({ role: 'model', parts: [{ text: `Unknown tool ${functionCall.functionCall.name}` }] });
      continue;
    }
    const args = JSON.parse(functionCall.functionCall.args || '{}');
    const result = await impl(args);
    await log({ role: 'tool', name: functionCall.functionCall.name, result: redact(JSON.stringify(result)) });
    history.push({ role: 'model', parts: [ { functionCall: functionCall.functionCall } ] });
    history.push({ role: 'user', parts: [ { functionResponse: { name: functionCall.functionCall.name, response: JSON.stringify(result) } } ] });
    continue;
  } else {
    const text = parts.map(p => p.text || '').join('\n');
    await log({ role: 'model', text: redact(text) });
    console.log(text);
    break;
  }
}
