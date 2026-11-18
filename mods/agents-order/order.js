// 同一 Space 的持久排序与拖动终态；不改终端或其他 Space 的位置。
const rank = value => /^(0|[1-9]\d*)$/.test(String(value ?? '')) ? Number(value) : Infinity;

export function orderedGroup(list, ranks) {
  return [...list].sort((a, b) => rank(ranks[a.address]) - rank(ranks[b.address]));
}

// 置顶区保持内置面板的模型顺序；标签只排序同 Space 的普通 Agent。
export function orderedBySpace(list, spaceIds, ranks, previews = new Map()) {
  const pinned = list.filter(a => a.pinned);
  const known = new Set(spaceIds);
  const normal = spaceIds.flatMap(space => {
    const group = orderedGroup(list.filter(a => !a.pinned && a.space === space), ranks);
    const preview = previews.get(space);
    if (preview) {
      const positions = new Map(preview.ids.map((id, i) => [id, i]));
      group.sort((a, b) => (positions.get(a.address) ?? Infinity) - (positions.get(b.address) ?? Infinity));
    }
    return group;
  });
  return [...pinned, ...normal, ...list.filter(a => !a.pinned && !known.has(a.space))];
}

export function reorderGroup(list, address, target) {
  const source = list.find(a => a.address === address);
  if (!source || source.pinned || list.some(a => a.pinned || a.space !== source.space)) return null;
  const ids = list.map(a => a.address).filter(id => id !== address);
  ids.splice(Math.max(0, Math.min(target, ids.length)), 0, address);
  return ids;
}

export function dragDecision({ dy, origin, target, valid }, threshold = 4) {
  if (Math.abs(dy) <= threshold) return 'focus';
  if (!valid) return 'cancel';
  return origin === target ? 'noop' : 'reorder';
}

// 普通 mouseup 不得刷新抑制点击的时戳。
export function releaseTime(drag, previous, now) {
  return drag ? now : previous;
}

// 每个主行 30px；展开的子行各占 26px，拖动命中按真实行心而非固定索引。
export function rowCenters(origin, originCenter, children) {
  const centers = new Array(children.length);
  centers[origin] = originCenter;
  for (let i = origin + 1; i < centers.length; i++)
    centers[i] = centers[i - 1] + 30 + children[i - 1] * 26;
  for (let i = origin - 1; i >= 0; i--)
    centers[i] = centers[i + 1] - 30 - children[i] * 26;
  return centers;
}

export function dropIndex(y, centers) {
  if (!centers.length) return 0;
  for (let i = 0; i < centers.length - 1; i++) {
    if (y < (centers[i] + centers[i + 1]) / 2) return i;
  }
  return centers.length - 1;
}

// 预览只计算主行与展开子行的块顶点；不触碰 Space、pane 或 core 顺序。
export function projectedPositions(members, address, target, heights) {
  const ids = reorderGroup(members, address, target) ?? members.map(a => a.address);
  const positions = new Map();
  let top = 0;
  for (const id of ids) {
    positions.set(id, top);
    top += heights[id];
  }
  return positions;
}

export async function persistOrder(ids, previous, label) {
  const written = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    try {
      await label(id, String(i));
      written.push(id);
    } catch {
      const rollbackFailed = [];
      for (const earlier of written.reverse()) {
        try { await label(earlier, previous[earlier] ?? ''); }
        catch { rollbackFailed.push(earlier); }
      }
      return { ok: false, failedAt: id, rollbackFailed };
    }
  }
  return { ok: true };
}
