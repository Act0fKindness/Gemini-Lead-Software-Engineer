import fs from 'fs/promises';
import path from 'path';
import { execa } from 'execa';
import fg from 'fast-glob';
import * as Diff from 'diff';

function ensureInWorkspace(workspace, targetPath) {
  const resolved = path.resolve(workspace, targetPath);
  if (!resolved.startsWith(workspace)) {
    throw new Error(`Path ${targetPath} is outside workspace`);
  }
  return resolved;
}

export async function searchFiles(query, globs = ['**/*'], maxResults = 20, { workspace }) {
  const files = await fg(globs, { cwd: workspace, dot: true });
  if (files.length === 0) return '';
  try {
    const { stdout } = await execa('rg', ['--max-count', String(maxResults), query, '--', ...files], { cwd: workspace });
    return stdout;
  } catch (err) {
    return err.stdout || '';
  }
}

export async function readFile(filePath, { workspace, byteLimit }) {
  const abs = ensureInWorkspace(workspace, filePath);
  const data = await fs.readFile(abs);
  return data.slice(0, byteLimit).toString();
}

export async function applyPatch(filePath, newContent, { workspace, approve, patchesDir }) {
  const abs = ensureInWorkspace(workspace, filePath);
  const oldContent = await fs.readFile(abs, 'utf8').catch(() => '');
  const diff = Diff.createPatch(filePath, oldContent, newContent);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const patchFile = path.join(patchesDir, `${timestamp}-${filePath.replace(/\//g, '_')}.patch`);
  await fs.writeFile(patchFile, diff);
  if (approve) {
    await fs.writeFile(abs, newContent, 'utf8');
  }
  return diff;
}
