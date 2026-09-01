#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

process.stdin.setEncoding('utf8');
let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  // WorktreeCreate contract: a registered hook owns worktree creation outright.
  // The harness does no git setup itself. The hook must echo ONLY the path of a
  // directory that already exists (empty stdout is an error too), and the agent
  // works directly in that directory, so it has to be a real git worktree
  // whenever the session is inside a repo.
  const baseDir = path.join(os.tmpdir(), 'pro-workflow', 'worktrees');

  // Git ref names can't start with '.', contain '..', or end in '.lock'. Strip
  // disallowed characters first, then collapse anything left that would still
  // fail `git check-ref-format`.
  const sanitizeRefComponent = (rawName) => {
    let name = String(rawName || 'worktree').replace(/[^A-Za-z0-9._-]/g, '-');
    name = name.replace(/\.+/g, '.').replace(/^\.+/, '').replace(/\.lock$/, '-lock');
    return name || 'worktree';
  };

  const createWorktree = (rawName, cwdHint) => {
    const ts = Date.now();
    const unique = `${ts}-${crypto.randomBytes(3).toString('hex')}`;
    const name = sanitizeRefComponent(rawName);
    const target = path.join(baseDir, `${name}-${unique}`);
    const branch = `agents/${name}-${unique}`;
    const cwd = cwdHint && fs.existsSync(cwdHint) ? cwdHint : process.cwd();

    let inRepo = false;
    try {
      execFileSync('git', ['-C', cwd, 'rev-parse', '--git-dir'], { stdio: 'ignore' });
      inRepo = true;
    } catch (err) {
      // Genuinely not a git repo: a plain directory is the correct outcome.
    }

    if (inRepo) {
      try {
        fs.mkdirSync(baseDir, { recursive: true });
        execFileSync('git', ['-C', cwd, 'worktree', 'add', '-b', branch, target], { stdio: 'pipe' });
        return { target, branch, repo: cwd };
      } catch (err) {
        // We ARE in a repo but `worktree add` still failed (ref collision, disk,
        // git version, etc.). Never block the spawn over this, but make the
        // failure visible instead of silently handing back an empty directory
        // that looks identical to the "not a repo" case.
        console.error(`[ProWorkflow] git worktree add failed, falling back to a plain directory: ${(err.stderr || err.message || err).toString().trim()}`);
      }
    }

    fs.mkdirSync(target, { recursive: true });
    return { target, branch: null, repo: null };
  };

  let input = {};
  try { input = JSON.parse(data); } catch (e) { input = {}; }

  let created;
  try {
    created = createWorktree(input.name, input.cwd);
  } catch (err) {
    process.exit(1);
  }
  const worktreePath = created.target;

  try {
    const tempDir = path.join(os.tmpdir(), 'pro-workflow');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const worktreeLog = path.join(tempDir, 'worktrees.json');
    let worktrees = [];
    if (fs.existsSync(worktreeLog)) {
      try { worktrees = JSON.parse(fs.readFileSync(worktreeLog, 'utf8')); } catch (e) { worktrees = []; }
    }

    worktrees.push({
      timestamp: new Date().toISOString(),
      session_id: input.session_id || 'unknown',
      worktree_path: worktreePath,
      branch: created.branch,
      repo: created.repo
    });

    if (worktrees.length > 100) worktrees = worktrees.slice(-100);
    fs.writeFileSync(worktreeLog, JSON.stringify(worktrees, null, 2));

    console.error(`[ProWorkflow] Worktree created: ${worktreePath}`);
    console.error('[ProWorkflow] Isolated workspace ready for parallel work');
  } catch (err) {
    // Logging failures must never block the spawn.
  }

  console.log(worktreePath);
});
