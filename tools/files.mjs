import fs from 'fs/promises';
import path from 'path';
import { execa } from 'execa';
import crypto from 'crypto';

function ensureInWorkspace(workspace, targetPath) {
  const resolved = path.resolve(workspace, targetPath);
  if (!resolved.startsWith(path.resolve(workspace))) {
    throw new Error(`Path ${targetPath} is outside workspace`);
  }
  return resolved;
}

export async function searchFiles(query, globs = ['**/*'], maxResults = 20, { workspace }) {
  const args = ['-n', '-S', '--hidden'];
  for (const g of globs) {
    args.push('--glob', g);
  }
  args.push(query, '.');
  try {
    const { stdout } = await execa('rg', args, { cwd: workspace });
    const lines = stdout.trim().split('\n').filter(Boolean).slice(0, maxResults);
    return lines.map(line => {
      const m = line.match(/^(.*?):(\d+):(.*)$/);
      return m ? { file: m[1], line: Number(m[2]), text: m[3] } : { file: '', line: 0, text: line };
    });
  } catch (err) {
    return { error: err.stderr || err.stdout || err.message };
  }
}

export async function readFile(filePath, { workspace, byteLimit }) {
  const abs = ensureInWorkspace(workspace, filePath);
  const data = await fs.readFile(abs);
  const slice = data.slice(0, byteLimit);
  const sha = crypto.createHash('sha256').update(slice).digest('hex');
  return { content: slice.toString(), bytes: slice.length, sha256: sha };
}

export async function applyPatch(filePath, newContent, { workspace, approve, patchesDir }) {
  const abs = ensureInWorkspace(workspace, filePath);
  const before = await fs.readFile(abs).catch(() => Buffer.from(''));
  const beforeHash = crypto.createHash('sha256').update(before).digest('hex');
  const afterBuffer = Buffer.from(newContent);
  const afterHash = crypto.createHash('sha256').update(afterBuffer).digest('hex');
  await fs.mkdir(patchesDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const artifact = path.join(patchesDir, `${ts}-${filePath.replace(/\//g, '_')}.full`);
  await fs.writeFile(artifact, newContent, 'utf8');
  if (!approve) {
    return { wrote: false, mode: 'dry-run', beforeHash, afterHash, bytes: afterBuffer.length, artifact };
  }
  const tmp = `${abs}.tmp.${process.pid}`;
  await fs.writeFile(tmp, newContent, 'utf8');
  await fs.rename(tmp, abs);
  console.log(`✏️  WROTE ${filePath} (${afterBuffer.length} bytes) sha256=${afterHash}`);
  let status = '';
  try {
    const { stdout } = await execa('git', ['status', '--short', filePath], { cwd: workspace });
    status = stdout.trim();
    if (status) console.log(`🧾 git status: ${status}`);
  } catch {}
  return { wrote: true, beforeHash, afterHash, bytes: afterBuffer.length, artifact, status };
}
