// 任务名的读取/校验/提交：workbench.name 是唯一存储；读取不截断，新输入才校验长度。
const MAX_NAME = 16;
const AUTO_MAX = 24;
const PRODUCTS = ['omp', 'oh-my-pi', 'ds harness', 'deepseek harness', 'codex', 'claude', 'opencode', 'agent'];
const SEGMENT_RE = /[|｜:：、，,]|\s+并\s*/;

// 已存名称只 trim 用于判断，不截断、不改写；返回原值保证长名显示完整。
export function displayName(labels, fallback = '') {
  const raw = labels?.['workbench.name'];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return fallback || '';
}


// 只清洗 title 的非敏感语义片段：去状态字形/emoji/runner 前缀；不读正文、不拼 ID。
function truncateWords(value, max = AUTO_MAX) {
  const chars = [...value];
  if (chars.length <= max) return value;
  const limit = max - 1;
  let out = '';
  for (const part of value.split(/(\s+|[+|])/)) {
    if (!part) continue;
    if ([...out + part].length > limit) break;
    out += part;
  }
  out = out.replace(/[+\s]+$/, '').trim();
  if ([...out].length < 2) out = chars.slice(0, limit).join('').trim();
  return out ? `${out}…` : null;
}

export function autoNameFromTitle(title, program = '', cwd = '', address = '') {
  // 标题可能带 <标题>…</标题> 一类包裹；先整体剥掉，再取语义段。
  let s = String(title ?? '').replace(/<\/?[^<>]{1,32}>/g, ' ').replace(/[\u200b-\u200d\ufeff]/g, '').trim();
  s = s.replace(/^[^\p{Script=Han}\p{Script=Latin}\p{N}]+/u, '');
  s = s.replace(/^(?:AGENT|OMP|OH-MY-PI|DS Harness|DeepSeek Harness|Codex|Claude|OpenCode|SPEC)\s*[:：>\-–—]\s*/iu, '');
  s = s.replace(/^(?:AGENT|OMP|OH-MY-PI|DS Harness|DeepSeek Harness|Codex|Claude|OpenCode|SPEC)\s+/iu, '');
  s = s.replace(/^[^\p{Script=Han}\p{Script=Latin}\p{N}]+/u, '').trim();
  const first = s.split(SEGMENT_RE)[0].trim();
  if (!first) return null;
  const candidate = truncateWords(first);
  if (!candidate || [...candidate].length < 2) return null;
  if (/^https?:\/\//i.test(candidate)) return null;
  if (/^[A-Za-z]+[-_][A-Za-z0-9._-]+$/.test(candidate)) return null; // 纯任务/会话 ID
  if (/^\d+$/.test(candidate)) return null;
  const lower = candidate.toLowerCase();
  const p = String(program ?? '').toLowerCase();
  const base = String(cwd ?? '').split('/').filter(Boolean).pop()?.toLowerCase() ?? '';
  const addr = String(address ?? '').toLowerCase();
  if (PRODUCTS.includes(lower) || lower === p || lower === base || lower === addr) return null;
  return candidate;
}

export function shouldAutoName(labels = {}) {
  const name = String(labels['workbench.name'] ?? '').trim();
  const source = String(labels['workbench.name.source'] ?? '').trim();
  if (!name) return true;
  return source === 'auto';
}

export function autoNameCandidate({ labels, title, program, cwd, address } = {}) {
  if (!shouldAutoName(labels)) return null;
  const name = autoNameFromTitle(title, program, cwd, address);
  if (!name) return null;
  if (String(labels?.['workbench.name'] ?? '').trim() === name) return null;
  return { name, source: 'auto' };
}

export function validateName(name, siblings = []) {
  const s = String(name ?? '').trim();
  if (!s) return '请输入简短任务名';
  if ([...s].length > MAX_NAME) return '任务名请控制在 16 字以内';
  if ((siblings ?? []).some(n => String(n ?? '').trim() === s)) return '当前 Space 已有同名任务';
  return null;
}

// 只有该 Agent 独占一个单终端 tab 时才同步 tab 名；共用 tab 不动。
// 读取已有长名后原样保存不算“新输入”；只有实际改动才做长度/重名校验。
export function validateEdit(current, next, siblings = []) {
  const n = String(next ?? '').trim();
  if (n === String(current ?? '').trim()) return null;
  return validateName(n, siblings);
}

export function tabSyncPlan(panes, agent, name) {
  const tab = agent?.tab;
  if (!tab || !name || agent?.tab_name === name) return null;
  const inTab = (panes ?? []).filter(p => p?.tab === tab && p?.terminal);
  if (inTab.length !== 1 || inTab[0].terminal !== agent.address) return null;
  return { id: tab, name };
}

// 等待宿主回显 tab 名：命令已接收但快照可能下一/多帧才更新；有界轮询，不把延迟当失败。
export async function waitForTabName({ plan, name, read, wait, attempts = 8 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    let tab = null;
    try { tab = read?.(plan.id); } catch { tab = null; }
    if (tab?.name === name) return { ok: true };
    if (i < attempts - 1 && typeof wait === 'function') await wait();
  }
  return { ok: false, reason: 'tab-name-timeout' };
}

// 关闭后不得再聚焦：timer 回调只走这里，便于消费者回归。
export function focusIfOpen(closed, focus) {
  if (closed) return false;
  if (typeof focus === 'function') focus();
  return true;
}

// 先写 label；失败保留旧名。label 成功后 tab 同步失败单独报告，不回滚任务名。
export async function commitName({ label, address, name, currentName = '', syncTab, source } = {}) {
  const next = String(name ?? '').trim();
  try {
    const values = { 'workbench.name': next };
    if (source) values['workbench.name.source'] = source;
    await label(address, values);
  } catch {
    return { ok: false, name: currentName, error: '名称未保存，请重试' };
  }
  let tabSyncFailed = false;
  if (next && typeof syncTab === 'function') {
    try { await syncTab(next); }
    catch { tabSyncFailed = true; }
  }
  return {
    ok: true,
    name: next,
    tabSyncFailed,
    error: tabSyncFailed ? '任务名已保存，标签页名称未同步' : null,
  };
}
