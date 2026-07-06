#!/usr/bin/env node
// WorktreeRemove hook: cleanup counterpart to worktree-create.js.
// Input (stdin JSON): { session_id, transcript_path, cwd, hook_event_name,
// worktree_path } where worktree_path is the path worktree-create.js echoed.
// Best-effort: remove the git worktree, delete the matching agents/* branch,
// prune stale admin entries, drop the ledger row. Never blocks the harness:
// always exits 0 and echoes stdin, matching the original script's contract.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const tempDir = path.join(os.tmpdir(), 'pro-workflow');
const baseDir = path.join(tempDir, 'worktrees');
const worktreeLog = path.join(tempDir, 'worktrees.json');

const git = (args, cwd) => execFileSync('git', args, {
  cwd: cwd || process.cwd(),
  stdio: ['ignore', 'pipe', 'ignore'],
  timeout: 8000
}).toString().trim();

const tryGit = (args, cwd) => { try { return git(args, cwd); } catch (e) { return null; } };

function cleanup(input, raw) {
  const wt = input.worktree_path || input.worktreePath || input.path || '';

  // Capture the raw payload so future harness schema changes are diagnosable.
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.appendFileSync(path.join(tempDir, 'worktree-remove.log'),
      `${new Date().toISOString()} ${String(raw).replace(/\s+/g, ' ').slice(0, 2000)}\n`);
  } catch (e) { /* ignore */ }

  let ledger = [];
  try { ledger = JSON.parse(fs.readFileSync(worktreeLog, 'utf8')); } catch (e) { ledger = []; }
  if (!Array.isArray(ledger)) ledger = [];
  const entry = ledger.find(w => w && w.worktree_path === wt) || null;

  const resolved = wt ? path.resolve(wt) : '';
  // Only paths under our own baseDir are ever deleted from disk.
  const ours = !!resolved && resolved.startsWith(baseDir + path.sep);

  // Identify the branch before the directory disappears. Fallbacks cover the
  // case where the harness (or a previous attempt) already removed the dir:
  // the ledger row, then the create hook's own naming scheme.
  let branch = null;
  if (wt && fs.existsSync(wt)) branch = tryGit(['branch', '--show-current'], wt);
  if (!branch && entry && typeof entry.branch === 'string') branch = entry.branch;
  if (!branch && ours) branch = 'agents/' + path.basename(resolved);

  // Locate the main repo: from the worktree's git-common-dir, the ledger,
  // or the session cwd the payload carries.
  let repo = null;
  if (wt && fs.existsSync(wt)) {
    const common = tryGit(['rev-parse', '--git-common-dir'], wt);
    if (common) repo = path.dirname(path.resolve(wt, common));
  }
  if (!repo && entry && typeof entry.repo === 'string' && fs.existsSync(entry.repo)) repo = entry.repo;
  if (!repo && input.cwd && fs.existsSync(input.cwd)) repo = input.cwd;

  // Only touch git state when we've confirmed ownership: either the path
  // resolves under our own baseDir, or the ledger has a matching row for it.
  // `repo` alone isn't enough to gate on — it can resolve via input.cwd (the
  // session's cwd), which may be the user's main repo, not a worktree we made.
  const owned = ours || !!entry;

  if (owned) {
    if (repo) tryGit(['worktree', 'remove', '--force', resolved], repo);
    try {
      if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
    } catch (e) { /* ignore */ }
  }
  if (owned && repo) {
    tryGit(['worktree', 'prune'], repo);
    // agents/* is the namespace worktree-create.js owns; never touch others.
    if (branch && /^agents\//.test(branch)) tryGit(['branch', '-D', branch], repo);
  }

  try {
    if (entry) {
      fs.writeFileSync(worktreeLog, JSON.stringify(ledger.filter(w => w !== entry), null, 2));
    }
  } catch (e) { /* ignore */ }

  console.error(`[ProWorkflow] Worktree removed: ${wt || 'unknown'}${branch ? ` (branch ${branch})` : ''}`);
}

process.stdin.setEncoding('utf8');
let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(data); } catch (e) { input = {}; }
  try { cleanup(input, data); } catch (e) { /* cleanup is best-effort, never block */ }
  // No process.exit() here: stdout to a pipe is written asynchronously by
  // Node, and exit() doesn't wait for the flush. Letting the event loop drain
  // naturally (no open handles remain) guarantees the payload isn't truncated.
  console.log(data || '{}');
});
