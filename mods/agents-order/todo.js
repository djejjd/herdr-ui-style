// 待办账本的纯逻辑：双表解析、冲突/版本、事件协议、导航计划与异步 Store。
// 不依赖 herdr/gpui，不写账本；所有函数可用 fixture 测试。

// 账本单元格拆分：与 workbench-tabs/pending.js 的既有规则一致；mod 不能跨目录 import。
function splitRow(line) {
  if (typeof line !== 'string') return [];
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i += 1; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const WHAT = '要你做什么';
const MAX_ROWS = 200;
const MAX_CELL = 200;
const DONE_RE = /^(已处理|已完成|done|closed)(?=$|[\s（(,，;；:：])/i;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION_RE = /^session:([0-9a-f-]{36})$/i;
const STATE_RANK = { needs_user: 0, review: 1, blocked: 2, operation: 3, conflict: 4, legacy: 5 };
const ACTION_STATES = new Set(['needs_user', 'review', 'blocked', 'operation']);

const cut = (v, n = MAX_CELL) => {
  const s = String(v ?? '').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const cell = (cells, header, name) => {
  const i = header.indexOf(name);
  return i >= 0 ? cut(cells[i]) : '';
};
const fnv = (text) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};
const versionOf = (raw) => (/^[1-9]\d*$/.test(String(raw ?? '').trim()) ? Number(String(raw).trim()) : 0);
const sessionOf = (raw) => {
  const m = SESSION_RE.exec(String(raw ?? '').trim());
  return m ? m[1] : null;
};

function tableBlocks(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith('|')) continue;
    const start = i;
    const table = [];
    while (i < lines.length && lines[i].trim().startsWith('|')) table.push(lines[i++]);
    i -= 1;
    if (table.length < 2) continue;
    const header = splitRow(table[0]);
    const sep = splitRow(table[1]);
    if (!sep.length || !sep.every(c => /^:?-{2,}:?$/.test(c))) continue;
    blocks.push({ header, rows: table.slice(2).map(splitRow), at: start });
  }
  return blocks;
}

function parseRows(block, table, index) {
  const h = block.header;
  if (table === 'approval' && !h.includes('状态')) return { error: 'no-status' };
  const rows = [];
  for (const cells of block.rows) {
    if (!cells.length || cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
    const what = table === 'approval' ? cell(cells, h, WHAT) : cell(cells, h, '标题');
    if (!what || /（示例）|\(示例\)/.test(what)) continue;
    const statusRaw = cell(cells, h, '状态');
    const done = DONE_RE.test(statusRaw.trim());
    const id = cell(cells, h, '事项ID');
    const versionRaw = cell(cells, h, '版本');
    const version = versionOf(versionRaw);
    const sourceTerminal = cell(cells, h, '来源终端');
    // 已完成的历史旧行没有新字段：跳过，不能变成错误待办。
    if (done && (!id || !version || !sourceTerminal)) continue;
    const idValid = !id || ID_RE.test(id);
    const type = cell(cells, h, '类型');
    const sourceSessionRaw = cell(cells, h, '来源会话');
    const row = {
      table, index, id, idValid, legacy: !id,
      type, statusRaw, done, title: cut(what, 80), version, versionRaw,
      sourceSpace: cell(cells, h, '来源Space'),
      sourceTab: cell(cells, h, '来源Tab'),
      sourceTerminal,
      sourceSessionRaw,
      sourceSession: sessionOf(sourceSessionRaw),
      sourceAgent: cell(cells, h, '来源Agent') || cell(cells, h, '发起人'),
      proposedAt: cell(cells, h, '提出时间'),
      project: cell(cells, h, '项目'),
      originator: cell(cells, h, '发起人'),
      evidence: table === 'approval' ? cut(statusRaw, 120) : cell(cells, h, '证据'),
      versionError: !version,
    };
    if (!idValid) row.invalidId = true;
    rows.push(row);
  }
  return { rows };
}

export function parseTodoLedger(text) {
  if (typeof text !== 'string') return { ok: false, error: 'unreadable', rows: [], errors: [] };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks = tableBlocks(lines);
  const rows = [];
  const errors = [];
  let approvalTable = false;
  for (const [i, block] of blocks.entries()) {
    const isApproval = block.header.includes(WHAT);
    const isAgent = !isApproval && block.header.includes('事项ID') && block.header.includes('标题');
    if (!isApproval && !isAgent) continue;
    if (isApproval) approvalTable = true;
    const parsed = parseRows(block, isApproval ? 'approval' : 'agent', i);
    if (parsed.error) { errors.push(parsed.error); continue; }
    rows.push(...parsed.rows.slice(0, Math.max(0, MAX_ROWS - rows.length)));
  }
  if (!approvalTable && !blocks.some(b => b.header.includes('事项ID') && b.header.includes('标题'))) {
    return { ok: false, error: 'no-table', rows: [], errors: [] };
  }
  if (errors.includes('no-status')) return { ok: false, error: 'no-status', rows, errors };
  const meta = {};
  for (const line of lines) {
    const m = /^\s*监督者\s*[:：]\s*(\S+)/.exec(line);
    if (m) { meta.supervisor = m[1]; break; }
  }
  return { ok: true, error: null, rows, errors, meta };
}

function signature(row) {
  return JSON.stringify([row.version, row.type, row.statusRaw, row.title, row.sourceSpace,
    row.sourceTab, row.sourceTerminal, row.sourceSessionRaw, row.done]);
}

function stateFor(row) {
  if (row.table === 'approval') return 'needs_user';
  if (row.type === '待审') return 'review';
  if (row.type === '阻塞') return 'blocked';
  if (row.type === '执行') return 'operation';
  return 'invalid';
}

function sourceOf(row) {
  return {
    space: row.sourceSpace, tab: row.sourceTab, terminal: row.sourceTerminal,
    session: row.sourceSessionRaw, sessionId: row.sourceSession, agent: row.sourceAgent,
  };
}

function itemFrom(row, extra = {}) {
  const source = sourceOf(row);
  const displayState = extra.state ?? stateFor(row);
  const sig = signature(row);
  return {
    key: extra.key ?? `${row.id || 'legacy'}:${row.version}:${fnv(sig)}`,
    id: row.id,
    kind: row.type,
    displayState,
    state: displayState,
    title: extra.title ?? row.title,
    source,
    sourceLabel: source.agent || source.terminal || '来源未记录',
    version: row.version,
    rev: `${row.id || 'legacy'}:${row.version}:${fnv(sig)}`,
    legacy: row.legacy,
    conflict: Boolean(extra.conflict),
    conflictCount: extra.conflictCount ?? 0,
    duplicateCount: extra.duplicateCount ?? 1,
    readOnly: Boolean(extra.conflict || row.legacy || row.versionError || !row.idValid),
    versionError: row.versionError,
    done: row.done,
    proposedAt: row.proposedAt,
    project: row.project,
    originator: row.originator,
    evidence: row.evidence,
    rows: extra.rows ?? [row],
  };
}

export function buildTodoView(parsed) {
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  const errors = Array.isArray(parsed?.errors) ? [...parsed.errors] : [];
  const groups = new Map();
  for (const row of rows) {
    if (!row.idValid) { errors.push(`invalid-id:${row.id || row.index}`); continue; }
    const key = row.id || `legacy:${fnv([row.title, row.proposedAt, row.sourceTerminal].join('\u0000'))}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const items = [];
  for (const [key, group] of groups) {
    if (group.every(r => r.done)) continue;
    if (group.length > 1) {
      const sigs = new Set(group.map(signature));
      if (sigs.size === 1) items.push(itemFrom(group[0], { key, duplicateCount: group.length }));
      else items.push({
        ...itemFrom(group[0], { key, conflict: true, conflictCount: group.length, rows: group }),
        state: 'conflict', displayState: 'conflict',
        title: `冲突：${group[0].id || '未命名'}（${group.length} 条）`,
        readOnly: true, sourceLabel: '冲突记录',
      });
      continue;
    }
    const row = group[0];
    if (row.versionError && !row.legacy) errors.push(`version:${row.id || key}`);
    const state = stateFor(row);
    if (state === 'invalid') { errors.push(`type:${row.id || key}`); continue; }
    items.push(itemFrom(row, { key }));
  }
  items.sort((a, b) => (STATE_RANK[a.displayState] ?? 9) - (STATE_RANK[b.displayState] ?? 9)
    || String(a.proposedAt).localeCompare(String(b.proposedAt))
    || String(a.id).localeCompare(String(b.id)));
  return { items, errors };
}

export function todoBadge(state) {
  const kind = state?.kind;
  if (kind === 'missing' || kind === 'error') return { kind: 'error', text: '!' };
  if (kind === 'stale') {
    const n = state.items?.length ?? 0;
    return n > 0 ? { kind: 'count', text: String(n), stale: true } : { kind: 'error', text: '!' };
  }
  if (kind === 'loading') return { kind: 'loading', text: '' };
  const n = state?.items?.length ?? 0;
  const errors = state?.errors?.length ?? 0;
  if (kind === 'ready' && errors) return n > 0 ? { kind: 'count', text: String(n), error: true } : { kind: 'error', text: '!' };
  return n > 0 ? { kind: 'count', text: String(n) } : { kind: 'hidden', text: '' };
}

export function modeAfterToggle(mode, dragging) {
  if (dragging) return mode;
  return mode === 'todo' ? 'agents' : 'todo';
}

export function preserveSelection(selected, items) {
  return selected && (items ?? []).some(i => i.id === selected) ? selected : null;
}

export function agentIconState(agent, items, verified = {}) {
  const actions = (items ?? []).filter(i => ACTION_STATES.has(i.displayState)
    && i.source.sessionId
    && i.source.terminal === agent?.address
    && (!verified[agent.address] || verified[agent.address] === i.source.sessionId));
  const order = ['needs_user', 'blocked', 'review', 'operation'];
  for (const s of order) if (actions.some(i => i.displayState === s)) return s;
  if (agent?.status === 'blocked') return 'blocked';
  if (agent?.status === 'working') return 'working';
  return 'idle';
}

function terminalOf(ctx, address) {
  return (ctx.terminals ?? []).find(t => t.address === address);
}
function spaceOf(ctx, id) {
  return (ctx.spaces ?? []).find(s => s.id === id);
}
function paneOf(ctx, address) {
  return (ctx.panes ?? []).find(p => p.terminal === address);
}

export function navigationPlan(item, ctx, identity) {
  if (!item || item.conflict || item.legacy || item.versionError || !item.source) return { ok: false, reason: 'unresolvable' };
  const { terminal, space, tab, sessionId } = item.source;
  if (!terminal || !space || !tab) return { ok: false, reason: 'source_missing' };
  const term = terminalOf(ctx, terminal);
  if (!term || term.state !== 'live') return { ok: false, reason: 'source_closed' };
  const sp = spaceOf(ctx, space);
  if (!sp) return { ok: false, reason: 'source_changed' };
  if (!identity?.ok) return { ok: false, reason: 'session_unverified' };
  if (!sessionId || identity.sessionId !== sessionId) return { ok: false, reason: 'session_changed' };
  const pane = paneOf(ctx, terminal);
  if (pane) {
    // keep 会把同一 terminal 放进新 tab：合法呈现位置变化，不是来源变化。
    // terminal + 当前会话已核验，只要求 pane 仍在原 space；使用 pane 的实际 tab。
    const paneSpace = (ctx.spaces ?? []).find(s => (s.tabs ?? []).some(t => t.id === pane.tab));
    if (!paneSpace || paneSpace.id !== space) return { ok: false, reason: 'source_changed' };
    return {
      ok: true, kind: 'pane',
      steps: [
        { name: 'space.select', args: { id: space } },
        { name: 'tab.select', args: { id: pane.tab } },
        { name: 'pane.focus', args: { pane: pane.pane } },
      ],
    };
  }
  // 不替换/关闭现有 pane：给无 pane 的终端新 tab，用户原 pane 保持不动。
  return { ok: true, kind: 'keep', steps: [{ name: 'terminal.keep', args: { terminal, place: 'tab' } }] };
}

export function applyModeAction(view, mode, cx, persist) {
  if (!view || view.drag || mode === view.mode) return false;
  view.mode = mode;
  if (typeof persist === 'function') persist(mode);
  if (typeof cx?.notify === 'function') cx.notify();
  return true;
}

export function modeActions(view, persist, refresh) {
  return {
    agents: (cx) => applyModeAction(view, 'agents', cx, persist),
    todo: (cx) => applyModeAction(view, 'todo', cx, persist),
    refresh: (cx) => (typeof refresh === 'function' ? refresh(cx) : null),
  };
}

export function subAgentState(agent, listedStatus, items, verified = {}) {
  return agentIconState({ address: agent?.address, status: listedStatus }, items, verified);
}

export function applyTodoEvent(rows, event, seen = new Set()) {
  const list = Array.isArray(rows) ? rows : [];
  const events = seen instanceof Set ? seen : new Set(seen ?? []);
  const eventId = String(event?.eventId ?? '');
  if (!eventId) return { ok: false, reason: 'missing-event-id', rows: list, seenEvents: events };
  if (events.has(eventId)) return { ok: true, idempotent: true, rows: list, seenEvents: events };
  const type = String(event?.type ?? '');
  const itemId = String(event?.itemId ?? '');
  const expected = Number(event?.expectedVersion);
  if (!itemId || !ID_RE.test(itemId)) return { ok: false, reason: 'invalid-id', rows: list, seenEvents: events };
  if (type === 'OPEN') {
    if (expected !== 0) return { ok: false, reason: 'stale-version', rows: list, seenEvents: events };
    if (list.some(r => r.id === itemId)) return { ok: false, reason: 'exists', rows: list, seenEvents: events };
    const src = event.source ?? {};
    const row = {
      table: 'agent', index: list.length, id: itemId, idValid: true, legacy: false,
      type: String(event.kind ?? '待审'), statusRaw: '未处理', done: false,
      title: cut(event.title ?? itemId, 80), version: 1, versionRaw: '1',
      sourceSpace: String(src.space ?? ''), sourceTab: String(src.tab ?? ''),
      sourceTerminal: String(src.terminal ?? ''), sourceSessionRaw: String(src.session ?? ''),
      sourceSession: sessionOf(src.session), sourceAgent: String(src.agent ?? ''),
      proposedAt: String(event.at ?? new Date().toISOString()), project: String(event.project ?? ''),
      originator: String(event.originator ?? ''), evidence: cut(event.evidence ?? '', 120), versionError: false,
    };
    events.add(eventId);
    return { ok: true, rows: [...list, row], seenEvents: events };
  }
  const matches = list.filter(r => r.id === itemId);
  if (!matches.length) return { ok: false, reason: 'unknown-id', rows: list, seenEvents: events };
  if (matches.length > 1) return { ok: false, reason: 'conflict', rows: list, seenEvents: events };
  const row = matches[0];
  if (!Number.isInteger(expected) || expected <= 0) return { ok: false, reason: 'stale-version', rows: list, seenEvents: events };
  if (row.version !== expected) return { ok: false, reason: 'stale-version', rows: list, seenEvents: events };
  if (type === 'DECISION' && row.table !== 'approval') return { ok: false, reason: 'wrong-kind', rows: list, seenEvents: events };
  if (type === 'REWORK' && !(row.table === 'agent' && row.type === '待审')) return { ok: false, reason: 'wrong-kind', rows: list, seenEvents: events };
  if (type === 'REVIEW-PASSED' && !(row.table === 'agent' && row.type === '待审')) return { ok: false, reason: 'wrong-kind', rows: list, seenEvents: events };
  if (type === 'UNBLOCKED' && !(row.table === 'agent' && row.type === '阻塞')) return { ok: false, reason: 'wrong-kind', rows: list, seenEvents: events };
  if (type === 'OPERATION-DONE' && !(row.table === 'agent' && row.type === '执行')) return { ok: false, reason: 'wrong-kind', rows: list, seenEvents: events };
  if (!['DECISION', 'REWORK', 'REVIEW-PASSED', 'UNBLOCKED', 'OPERATION-DONE'].includes(type)) return { ok: false, reason: 'unknown-type', rows: list, seenEvents: events };
  const next = list.map(r => r === row ? { ...r, done: true, statusRaw: '已处理', version: r.version + 1, versionRaw: String(r.version + 1) } : r);
  events.add(eventId);
  return { ok: true, rows: next, seenEvents: events };
}

// 读账本的状态机：single-flight、generation、close 后无写入；失败保留 last-good。
export class TodoStore {
  constructor({ read, now = () => Date.now() } = {}) {
    this.read = read ?? (async () => null);
    this.now = now;
    this.state = { kind: 'loading', items: [], errors: [], at: 0 };
    this.generation = 0;
    this.closed = false;
    this.inflight = null;
  }
  refresh() {
    if (this.closed) return Promise.resolve(this.state);
    if (this.inflight) return this.inflight;
    const gen = ++this.generation;
    const previous = this.state;
    let task;
    task = (async () => {
      let text;
      try { text = await this.read(); }
      catch { text = undefined; }
      if (this.closed || gen !== this.generation) return this.state;
      if (text === undefined) {
        this.state = previous.items?.length
          ? { kind: 'stale', items: previous.items, errors: ['read'], at: this.now() }
          : { kind: 'error', items: [], errors: ['read'], at: this.now() };
        return this.state;
      }
      if (text === null) {
        this.state = previous.items?.length
          ? { kind: 'stale', items: previous.items, errors: ['missing'], at: this.now() }
          : { kind: 'missing', items: [], errors: ['missing'], at: this.now() };
        return this.state;
      }
      const parsed = parseTodoLedger(text);
      if (!parsed.ok) {
        this.state = previous.items?.length
          ? { kind: 'stale', items: previous.items, errors: [parsed.error], at: this.now() }
          : { kind: 'error', items: [], errors: [parsed.error], at: this.now() };
        return this.state;
      }
      const view = buildTodoView(parsed);
      this.state = { kind: 'ready', items: view.items, errors: view.errors, at: this.now() };
      return this.state;
    })().finally(() => { if (this.inflight === task) this.inflight = null; });
    this.inflight = task;
    return task;
  }
  close() {
    this.closed = true;
    this.generation += 1;
    this.inflight = null;
  }
}
