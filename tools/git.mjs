import { execa } from 'execa';

export async function gitMakeBranch(name, { workspace }) {
  await execa('git', ['checkout', '-b', name], { cwd: workspace });
  return { message: `Created branch ${name}` };
}

export async function gitCommit(message, { workspace }) {
  await execa('git', ['commit', '-am', message], { cwd: workspace });
  return { message: 'Committed' };
}

export async function gitDiff({ workspace }) {
  const { stdout } = await execa('git', ['diff'], { cwd: workspace });
  return { diff: stdout };
}
