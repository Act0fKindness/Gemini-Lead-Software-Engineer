import { execa } from 'execa';

export async function gitMakeBranch(name) {
  await execa('git', ['checkout', '-b', name]);
  return `Created branch ${name}`;
}

export async function gitCommit(message) {
  await execa('git', ['commit', '-am', message]);
  return 'Committed';
}

export async function gitDiff() {
  const { stdout } = await execa('git', ['diff']);
  return stdout;
}
