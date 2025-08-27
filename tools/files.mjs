import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import { execa } from 'execa';
import * as Diff from 'diff';

// --- helpers
function resolveInside(workspace, targetPath) {
  const root = path.resolve(workspace);
  const abs = path.resolve(root, targetPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes workspace: ${targetPath}`);
  }
  return abs;
}

async function ensureParent(absPath) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
}

// --- search (rg preferred; respects globs)
export async function searchFiles(query, globs = ['**/*'], maxResults = 20, { workspace }) {
  try {
    const args = ['-n', '-S', '--hidden', '--no-ignore-parent'];
    for (const g of globs) args.push('--glob', g);
    // pattern + root
    args.push(query, '.');

    const { stdout } = await execa('rg', args, { cwd: workspace });
    const lines = stdout.split('\n').filter(Boolean).slice(0, maxResults);
    return lines.join('\n');
  } catch (err) {
    // rg exits non-zero on no matches; return its (possibly empty) stdout
    return (err && err.stdout) ? String(err.stdout) : '';
  }
}

// --- read
export async function readFile(filePath, { workspace, byteLimit }) {
  const abs = resolveInside(workspace, filePath);
  const data = await fs.readFile(abs);
  const buf = byteLimit ? data.slice(0, byteLimit) : data;
  return buf.toString('utf8');
}

// --- apply (atomic, workspace-scoped, patch logged, git status surfaced)
export async function applyPatch(filePath, newContent, { workspace, approve, patchesDir }) {
  const abs = resolveInside(workspace, filePath);
  await ensureParent(abs);

  const oldContent = await fs.readFile(abs, 'utf8').catch(() => '');
  const diffText = Diff.createPatch(filePath, oldContent, newContent);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // Save patch artifact
  const patchName = `${timestamp}-${filePath.replace(/[\\/]/g, '_')}.patch`;
  const patchAbs = resolveInside(patchesDir, patchName); // patchesDir is already outside workspace; just resolve + mkdir
  await fs.mkdir(path.dirname(patchAbs), { recursive: true });
  await fs.writeFile(patchAbs, diffText, 'utf8');

  // Also keep a full copy of the new file for traceability
  const fullName = `${timestamp}-${filePath.replace(/[\\/]/g, '_')}.full`;
  const fullAbs = path.join(patchesDir, fullName);
  await fs.writeFile(fullAbs, newContent, 'utf8');

  let wrote = false;
  let gitStatus = '';

  if (approve) {
    // Atomic write
    const tmp = `${abs}.tmp.${process.pid}`;
    await fs.writeFile(tmp, newContent, { encoding: 'utf8', mode: 0o664 });
    await fs.rename(tmp, abs);

    // Feedback to console so you SEE writes as they happen
    console.log(`✏️  WROTE ${filePath} (${Buffer.byteLength(newContent, 'utf8')} bytes)`);

    // If repo present, show porcelain line for this file
    try {
      const rel = path.relative(workspace, abs) || filePath;
      const { stdout } = await execa('git', ['status', '--porcelain', '--', rel], { cwd: workspace });
      gitStatus = stdout.trim();
      if (gitStatus) console.log(`🧾 git status: ${gitStatus}`);
    } catch {
      // not a git repo or git missing – ignore
    }
    wrote = true;

    // Best effort: ensure readable/writable
    try { await fs.access(abs, fsConstants.R_OK | fsConstants.W_OK); } catch {}
  } else {
    console.log(`📝 DRY-RUN: patch saved at ${patchAbs} (no file write — pass --approve to apply).`);
  }

  return {
    filepath: filePath,
    wrote,
    diff: diffText,
    patchFile: patchAbs,
    fullFileArtifact: fullAbs,
    gitStatus
  };
}
