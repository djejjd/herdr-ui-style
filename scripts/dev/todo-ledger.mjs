// 只读账本工具：source 打印精确来源；validate 检查 ID/版本/来源/冲突。
// TODO-EVENT 类型：OPEN/DECISION/REWORK/REVIEW-PASSED/UNBLOCKED/OPERATION-DONE；
// 除 OPEN(expectedVersion=0) 外必须匹配当前递增版本，eventId 幂等。
// 不写 pending.md，不启动 agent，不读对话正文。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseTodoLedger, buildTodoView } from '../../mods/agents-order/todo.js';

const here = dirname(fileURLToPath(import.meta.url));
const sessionScript = resolve(here, '../../mods/agents-order/session.mjs');

function hcGet(terminal) {
  return JSON.parse(execFileSync('hc', ['get', terminal], { encoding: 'utf8', timeout: 4000 }));
}

function appLs() {
  try { return JSON.parse(execFileSync('herdr-app', ['ls'], { encoding: 'utf8', timeout: 4000 })); }
  catch { return { spaces: [] }; }
}

function locate(terminal) {
  for (const space of appLs().spaces ?? []) {
    for (const tab of space.tabs ?? []) {
      for (const t of tab.terminals ?? []) {
        if (t.terminal === terminal) return { space: space.id, tab: tab.id, name: space.name };
      }
    }
  }
  return { space: '', tab: '', name: '' };
}

function source(terminal) {
  if (!terminal) throw new Error('usage: todo-ledger.mjs source <terminal>');
  const term = hcGet(terminal);
  const loc = locate(terminal);
  let id = null;
  try {
    const out = execFileSync('node', [sessionScript, 'verify', terminal], { encoding: 'utf8', timeout: 5000 });
    id = JSON.parse(out).sessionId ?? null;
  } catch { id = null; }
  const labels = term.labels ?? {};
  const agent = labels['workbench.name'] || term.name || labels.where || terminal;
  console.log(`来源Space=${loc.space}`);
  console.log(`来源Tab=${loc.tab}`);
  console.log(`来源终端=${terminal}`);
  console.log(`来源会话=${id ? `session:${id}` : 'unknown'}`);
  console.log(`来源Agent=${agent}`);
}

function validate(file) {
  if (!file) throw new Error('usage: todo-ledger.mjs validate <file>');
  const parsed = parseTodoLedger(readFileSync(file, 'utf8'));
  if (!parsed.ok) {
    console.error(`账本解析失败：${parsed.error}`);
    process.exit(1);
  }
  const view = buildTodoView(parsed);
  const errors = [...view.errors];
  const ids = new Set();
  for (const row of parsed.rows) {
    if (!row.id && !row.done) { /* legacy pending: 可见但不可跳，不阻断迁移 */ }
    if (row.id) {
      if (ids.has(row.id)) errors.push(`duplicate-id:${row.id}`);
      ids.add(row.id);
    }
    if (!row.done && !row.legacy && !row.version) errors.push(`version:${row.id || row.index}`);
    if (!row.done && !row.legacy && !row.sourceTerminal) errors.push(`source:${row.id || row.index}`);
    if (row.sourceSessionRaw && !row.sourceSession) errors.push(`session-format:${row.id || row.index}`);
  }
  for (const item of view.items) {
    if (item.conflict) errors.push(`conflict:${item.id}`);
  }
  if (errors.length) {
    for (const error of [...new Set(errors)]) console.error(error);
    process.exit(1);
  }
  console.log(`ok rows=${parsed.rows.length} pending=${view.items.length}`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'source') source(args[0]);
  else if (command === 'validate') validate(args[0]);
  else { console.error('usage: todo-ledger.mjs source <terminal> | validate <file>'); process.exit(2); }
} catch (error) {
  console.error(String(error?.message ?? error).slice(0, 200));
  process.exit(2);
}
