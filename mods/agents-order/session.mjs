// 来源会话身份：omp 的 session-owner lock、dsh 的 session-mounts，以及既有 probe。
// 只读文件名/元数据，不读对话正文；可在 check/测试中安全导入。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function sessionIdFromOmpPaths(paths) {
  const ids = new Set();
  for (const raw of paths ?? []) {
    const p = String(raw);
    let m = p.match(new RegExp(`\\.omp/run/session-owners/${UUID.source}\\.lock$`, 'i'));
    if (!m) m = p.match(new RegExp(`\\.omp/agent/sessions/.*_${UUID.source}\\.jsonl$`, 'i'));
    if (m) ids.add(m[1].toLowerCase());
  }
  return ids.size === 1 ? [...ids][0] : null;
}

export function pickDshSession(mounts, pids) {
  const owners = (mounts?.owners ?? []).filter(o => pids?.has?.(o.pid));
  const ids = new Set(owners.flatMap(o => o.sessionIds ?? []));
  if (ids.size !== 1) return null;
  const sessionId = [...ids][0];
  return { sessionId, owner: owners.find(o => (o.sessionIds ?? []).includes(sessionId)) };
}

export function programKey(argv) {
  const text = (Array.isArray(argv) ? argv : [argv]).join(' ').toLowerCase();
  if (text.includes('dsh-tui')) return 'dsh-tui';
  if (/(^|[/\s])omp($|\s)/.test(text)) return 'omp';
  if (text.includes('codex')) return 'codex';
  if (text.includes('claude')) return 'claude';
  if (text.includes('opencode')) return 'opencode';
  return null;
}

function lsof(args) {
  return execFileSync('/usr/sbin/lsof', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 4000 });
}
function parentMap() {
  const out = lsof(['-F', 'pR']);
  const map = new Map();
  let pid = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('R') && pid) map.set(pid, Number(line.slice(1)));
  }
  return map;
}
function descendants(root, parents) {
  const set = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of parents) if (!set.has(pid) && set.has(ppid)) { set.add(pid); changed = true; }
  }
  return set;
}
function ompSession(pid) {
  const out = lsof(['-Fn', '-p', String(pid)]);
  const paths = out.split('\n').filter(l => l.startsWith('n')).map(l => l.slice(1));
  const sessionId = sessionIdFromOmpPaths(paths);
  return sessionId ? { sessionId, evidence: '~/.omp/run/session-owners/<uuid>.lock' } : { reason: 'omp-lock-not-found' };
}
function dshSession(pid, createdMs) {
  const mounts = JSON.parse(readFileSync(`${HOME}/.dsh-tui/session-mounts.json`, 'utf8'));
  const chosen = pickDshSession(mounts, descendants(pid, parentMap()));
  if (!chosen) return { reason: 'dsh-owner-not-found' };
  const skew = Math.abs(Number(chosen.owner.startedAt) - Number(createdMs));
  if (Number.isFinite(skew) && skew > 5000) return { reason: `dsh-start-skew:${skew}` };
  return { sessionId: chosen.sessionId, evidence: `session-mounts owner pid ${chosen.owner.pid}` };
}
function probeSession(pid, program) {
  const probe = fileURLToPath(new URL('./probe.mjs', import.meta.url));
  const out = execFileSync('node', [probe, String(pid), program], { encoding: 'utf8', timeout: 4000 });
  const sessionId = JSON.parse(out).sessionId;
  return sessionId ? { sessionId, evidence: 'probe.mjs' } : { reason: 'probe-no-session' };
}

function verify(terminal, expected) {
  const term = JSON.parse(execFileSync('hc', ['get', terminal], { encoding: 'utf8', timeout: 4000 }));
  const pid = term.foreground?.pid;
  if (!pid) return { ok: false, reason: 'no-pid', terminal };
  const program = programKey(term.foreground?.argv ?? []);
  let found;
  try {
    if (program === 'omp') found = ompSession(pid);
    else if (program === 'dsh-tui') found = dshSession(pid, term.created_ms);
    else if (['codex', 'claude', 'opencode'].includes(program)) found = probeSession(pid, program);
    else found = { reason: `unsupported:${program ?? 'unknown'}` };
  } catch (error) {
    return { ok: false, reason: `verify-error:${String(error?.message ?? error).slice(0, 80)}`, terminal };
  }
  if (!found.sessionId) return { ok: false, terminal, program, reason: found.reason ?? 'unverified' };
  if (expected && found.sessionId !== expected) return { ok: false, terminal, program, sessionId: found.sessionId, reason: 'session_changed' };
  return { ok: true, terminal, program, sessionId: found.sessionId, evidence: found.evidence };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, terminal, expected] = process.argv.slice(2);
  if (command !== 'verify' || !terminal) {
    console.error('usage: session.mjs verify <terminal> [expectedSessionId]');
    process.exit(2);
  }
  const result = verify(terminal, expected);
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
