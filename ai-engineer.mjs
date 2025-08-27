#!/usr/bin/env node
import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'node:readline';
import { execa } from 'execa';

import { searchFiles, readFile, applyPatch } from './tools/files.mjs';
import { runTests, runCmd } from './tools/cmd.mjs';
import { gitMakeBranch, gitCommit, gitDiff } from './tools/git.mjs';

// --- paths & config
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaults = JSON.parse(await fs.readFile(path.join(__dirname, 'config', 'defaults.json'), 'utf8'));
const runners  = JSON.parse(await fs.readFile(path.join(__dirname, 'config', 'runners.json'),  'utf8'));

// --- args & env
const args        = process.argv.slice(2);
const approve     = args.includes('--approve');
const autoInstall = args.includes('--auto-install');
const untilDone   = args.includes('--until-done');
const modelFlagIx = args.findIndex(a => a === '--model');
const modelFlag   = modelFlagIx >= 0 ? args[modelFlagIx + 1] : null;
const userPrompt  = args.filter((a, i) => !a.startsWith('--') && (i !== modelFlagIx + 1)).join(' ')?.trim() ?? '';

const workspace   = process.env.WORKSPACE || defaults.workspace;
const byteLimit   = defaults.byteLimit || 120000;

// --- logs
const timestamp   = new Date().toISOString().replace(/[:.]/g, '-');
const sessionsDir = path.join(__dirname, 'logs', 'sessions');
const patchesDir  = path.join(__dirname, 'logs', 'patches');
await fs.mkdir(sessionsDir, { recursive: true });
await fs.mkdir(patchesDir,  { recursive: true });
const sessionLog  = path.join(sessionsDir, `${timestamp}.jsonl`);

async function log(entry) {
  try { await fs.appendFile(sessionLog, JSON.stringify(entry) + '\n'); } catch {}
}

function redact(str = '') {
  const s = typeof str === 'string' ? str : JSON.stringify(str);
  return s.replace(/([A-Z0-9_]*KEY|PASS(WORD)?|TOKEN)\s*=\s*["']?[^"'\s]+/gi, '$1=[redacted]');
}

async function preflight({ autoInstall, workspace, approve }) {
  const v = Number(process.versions.node.split('.')[0]);
  if (v < 20) { console.error(`Node ${process.versions.node} detected. Please use Node >= 20.`); process.exit(1); }
  if (!process.env.GEMINI_API_KEY) { console.error('GEMINI_API_KEY is not set. export GEMINI_API_KEY=...'); process.exit(1); }

  let genaiModule;
  try {
    genaiModule = await import('@google/genai');
  } catch {
    if (autoInstall) {
      console.log('📦 Installing @google/genai locally...');
      await execa('npm', ['i', '@google/genai'], { stdio: 'inherit' });
      genaiModule = await import('@google/genai');
    } else {
      console.error('Missing @google/genai. Run: npm i @google/genai  (or pass --auto-install)');
      process.exit(1);
    }
  }

  try { await fs.access(workspace); }
  catch { console.error(`WORKSPACE ${workspace} is not accessible.`); process.exit(1); }

  if (approve) {
    try { await fs.access(workspace, fsConstants.W_OK); }
    catch { console.warn(`WORKSPACE ${workspace} is not writable; --approve may fail.`); }
  }

  return genaiModule;
}

const genaiModule = await preflight({ autoInstall, workspace, approve });

// --- detect runner
async function detectRunner() {
  try { await fs.access(path.join(workspace, 'package.json')); return 'node'; } catch {}
  try { await fs.access(path.join(workspace, 'composer.json')); return 'php'; } catch {}
  try { await fs.access(path.join(workspace, 'pyproject.toml')); return 'python'; } catch {}
  return 'fallback';
}
const runner      = await detectRunner();
const testCommand = runners[runner]?.test || runners.fallback.test;

// --- tools (impls)
const toolImpls = {
  search_files: async ({ query, globs = ['**/*'], max_results = 20 }) => {
    return await searchFiles(query, globs, max_results, { workspace });
  },
  read_file: async ({ filepath, max_bytes = byteLimit }) => {
    return await readFile(filepath, { workspace, byteLimit: max_bytes });
  },
  run_tests: async ({ cmd = testCommand, timeout_ms = 600000 }) => {
    return await runTests(cmd, timeout_ms, { workspace });
  },
  apply_patch: async ({ filepath, new_content, rationale }) => {
    return await applyPatch(
      filepath,
      new_content,
      { workspace, approve: approve && (!('writeGating' in defaults) || !defaults.writeGating), patchesDir, rationale }
    );
  },
  git_make_branch: async ({ name }) => gitMakeBranch(name, { workspace }),
  git_commit:      async ({ message }) => gitCommit(message, { workspace }),
  git_diff:        async () => gitDiff({ workspace }),
  run_cmd:         async ({ command, timeout_ms = 0 }) => runCmd(command, { workspace, timeout_ms })
};

// --- tool definitions (for function calling)
const toolDefs = [
  { name: 'search_files', description: 'Search for text in files', parameters: { type: 'object', properties: { query: { type: 'string' }, globs: { type: 'array', items: { type: 'string' } }, max_results: { type: 'integer' } }, required: ['query'] } },
  { name: 'read_file',    description: 'Read a file',             parameters: { type: 'object', properties: { filepath: { type: 'string' }, max_bytes: { type: 'integer' } }, required: ['filepath'] } },
  { name: 'run_tests',    description: 'Run project tests/build', parameters: { type: 'object', properties: { cmd: { type: 'string' }, timeout_ms: { type: 'integer' } } } },
  { name: 'apply_patch',  description: 'Apply FULL-FILE patch',   parameters: { type: 'object', properties: { filepath: { type: 'string' }, new_content: { type: 'string' }, rationale: { type: 'string' } }, required: ['filepath', 'new_content'] } },
  { name: 'git_make_branch', description: 'Create git branch',    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'git_commit',      description: 'Commit changes',       parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
  { name: 'git_diff',        description: 'Show git diff',        parameters: { type: 'object', properties: {} } },
  { name: 'run_cmd',         description: 'Run shell command',    parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'integer' } }, required: ['command'] } }
];

// --- model setup
const { GoogleGenAI } = genaiModule;
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
let model = modelFlag || defaults.model || 'gemini-2.5-pro';

// --- response normalizer (new + legacy)
function normalizeResponse(resp) {
  if (resp && (typeof resp.text === 'string' || Array.isArray(resp?.functionCalls))) {
    return { text: resp.text ?? '', functionCalls: resp.functionCalls ?? [] };
  }
  const cand = resp?.response?.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const text = parts.filter(p => typeof p?.text === 'string').map(p => p.text).join('\n');
  const functionCalls = parts.map(p => p?.functionCall).filter(Boolean).map(fc => ({ name: fc.name, args: fc.args || {} }));
  return { text, functionCalls };
}

async function modelTurn({ history, tools }) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log('🤖 Calling model…');
      const resp = await ai.models.generateContent({
        model,
        contents: history,
        tools,
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
      });
      const norm = normalizeResponse(resp);
      console.log('📩 Model response received.');
      if (!norm.text && (!norm.functionCalls || norm.functionCalls.length === 0)) {
        lastErr = new Error('Empty model response; will retry');
        continue;
      }
      return norm;
    } catch (e) {
      if (e.status === 404 && model !== 'gemini-2.5-flash') {
        console.warn(`⚠️  Model ${model} unavailable; falling back to gemini-2.5-flash`);
        model = 'gemini-2.5-flash';
        continue;
      }
      lastErr = e;
      console.warn(`⚠️  Model turn failed: ${e?.message || e}`);
      await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
  throw lastErr || new Error('Model did not return usable output');
}

// --- conversation state
const baseInstruction =
  `You are an AI engineering assistant operating inside ${workspace}.
Use tools in this order: search_files → read_file → run_cmd/run_tests → apply_patch.
When writing files, ALWAYS call apply_patch with the FULL updated file content.
After any write, run "git_diff" and show a summary. Keep output concise.`;

const history = [
  { role: 'user', parts: [{ text: baseInstruction }] }
];

async function executeToolLoop() {
  let iterations = 0;
  const maxIters = defaults.maxToolIters ?? 100;
  while (iterations++ < maxIters) {
    const resp = await modelTurn({ history, tools: toolDefs });

    if (resp.functionCalls?.length) {
      for (const fc of resp.functionCalls) {
        console.log(`🔧 Executing tool: ${fc.name} ${JSON.stringify(fc.args || {})}`);
        await log({ role: 'model', functionCall: { name: fc.name, args: fc.args } });

        const impl = toolImpls[fc.name];
        if (!impl) {
          const msg = `Unknown tool ${fc.name}`;
          history.push({ role: 'model', parts: [{ text: msg }] });
          await log({ role: 'tool', name: fc.name, result: msg });
          console.log(`❓ ${msg}`);
          continue;
        }

        let result;
        try { result = await impl(fc.args || {}); }
        catch (e) { result = { error: String(e) }; }

        await log({ role: 'tool', name: fc.name, result: redact(result) });
        console.log(`✅ Tool ${fc.name} complete`);

        // append function call (model) then our functionResponse (user)
        history.push({ role: 'model', parts: [{ functionCall: { name: fc.name, args: fc.args || {} } }] });
        history.push({ role: 'user',  parts: [{ functionResponse: { name: fc.name, response: result } }] });
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
}

async function runTask(taskText) {
  if (!taskText) return;
  console.log(`📝 Task: ${taskText}`);
  history.push({ role: 'user', parts: [{ text: taskText }] });
  await log({ role: 'user', text: redact(taskText) });

  do {
    await executeToolLoop();

    if (untilDone) {
      try {
        console.log('🧪 Running verification tests…');
        const testRes = await toolImpls.run_tests({});
        await log({ role: 'tool', name: 'run_tests', result: redact(testRes) });
        if (testRes && testRes.exitCode === 0) {
          console.log('✅ Success: tests/build completed without errors.');
          break;
        }
        console.log('❌ Tests still failing; handing results back to model.');
        history.push({ role: 'user', parts: [{ functionResponse: { name: 'run_tests', response: testRes } }] });
      } catch (e) {
        const errObj = { exitCode: -1, stderr: String(e) };
        history.push({ role: 'user', parts: [{ functionResponse: { name: 'run_tests', response: errObj } }] });
      }
    } else {
      break;
    }
  } while (untilDone);
}

// --- entrypoint: one-shot or REPL
console.log(`🏁 Workspace: ${workspace}`);
console.log(`🧠 Model: ${model}`);
if (approve) console.log('✍️  Write mode: ENABLED (--approve)');
if (untilDone) console.log('♻️  Until-done loop: ENABLED');

if (userPrompt) {
  await runTask(userPrompt);
  process.exit(0);
} else {
  // Interactive REPL
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'AI> ' });
  console.log('💬 Interactive mode. Type a directive and press Enter. Type "exit" or Ctrl+C to quit.');
  rl.prompt();
  rl.on('line', async (line) => {
    const cmd = line.trim();
    if (!cmd) return rl.prompt();
    if (['exit', 'quit'].includes(cmd.toLowerCase())) { rl.close(); return; }
    try { await runTask(cmd); }
    catch (e) { console.error('Error:', e?.message || e); }
    rl.prompt();
  }).on('close', () => {
    console.log('Goodbye 👋');
    process.exit(0);
  });
}
