// 只解析身份元数据；多个匹配一律拒绝，不使用最近会话猜测。
export function mountedIdentity(document,pids) {
  if(document?.version!==1||!Array.isArray(document.owners))return null;
  const owners=document.owners.filter(o=>pids.includes(o.pid));
  const ids=[...new Set(owners.flatMap(o=>Array.isArray(o.sessionIds)?o.sessionIds:[]))];
  return ids.length===1&&/^[0-9a-f-]{36}$/i.test(ids[0])?ids[0]:null;
}
export function descendants(root,rows) {
  const found=new Set([root]);let changed=true;
  while(changed){changed=false;for(const [pid,parent]of rows)if(found.has(parent)&&!found.has(pid)){found.add(pid);changed=true;}}
  return [...found];
}
export function selectedIdentity(records,pids) {
  const matches=records.filter(r=>pids.includes(r.pid)&&/^ses_[a-zA-Z0-9]+$/.test(r.sessionId??''));
  const ids=[...new Set(matches.map(r=>r.sessionId))];
  return ids.length===1?ids[0]:null;
}
