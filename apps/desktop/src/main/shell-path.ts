// Apps started from the Dock/Finder (macOS) or a desktop launcher (Linux) get a minimal PATH,
// so `npx`, `uvx` or `node` from nvm/Homebrew are "not found". Ask the user's login shell once.
import { execFileSync } from 'node:child_process';

export function fixPathFromLoginShell(): void {
  if (process.platform === 'win32') return;
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  try {
    const marker = '__PROBE_PATH__';
    const out = execFileSync(shell, ['-ilc', `printf '${marker}%s${marker}' "$PATH"`], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(new RegExp(`${marker}(.*)${marker}`));
    if (m && m[1]) {
      const merged = new Set([...m[1].split(':'), ...(process.env.PATH ?? '').split(':')].filter(Boolean));
      process.env.PATH = [...merged].join(':');
    }
  } catch {
    // Keep the existing PATH; users can still put absolute paths in the command.
  }
}
