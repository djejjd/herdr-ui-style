// 只从目标进程打开的会话文件名获取身份；不读取对话正文、不扫描最新会话。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { descendants,mountedIdentity,selectedIdentity } from './identity.js';
const [pid,program]=process.argv.slice(2);
if(!/^\d+$/.test(pid??''))process.exit(1);
try {
  if(program==='dsh-tui'||program==='opencode') {
    const rows=execFileSync('/bin/ps',['-axo','pid=,ppid='],{encoding:'utf8',timeout:2000}).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
    const pids=descendants(Number(pid),rows);
    let sessionId=null;
    if(program==='dsh-tui')sessionId=mountedIdentity(JSON.parse(readFileSync(join(homedir(),'.dsh-tui/session-mounts.json'),'utf8')),pids);
    else {
      const root=join(dirname(fileURLToPath(import.meta.url)),'../../data/workbench-opencode');
      const records=pids.flatMap(pid=>{try{
        const record=JSON.parse(readFileSync(join(root,pid+'.json'),'utf8'));
        const started=execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:1000}).trim();
        return record.started===started?[record]:[];
      }catch{return [];}});
      sessionId=selectedIdentity(records,pids);
    }
    console.log(JSON.stringify({sessionId}));process.exit(0);
  }
  const lines=execFileSync('/usr/sbin/lsof',['-Fn','-p',pid],{encoding:'utf8',timeout:2000,maxBuffer:1024*1024}).split('\n');
  const ids=new Set();
  for(const line of lines) {
    if(!line.startsWith('n'))continue;
    const path=line.slice(1);
    if(program==='codex'&&path.includes('/.codex/')&&path.endsWith('.jsonl')) {
      const match=path.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i);if(match)ids.add(match[1]);
    }
    if(program==='claude'&&path.includes('/.claude/projects/')&&path.endsWith('.jsonl')) {
      const match=path.match(/\/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i);if(match)ids.add(match[1]);
    }
  }
  console.log(JSON.stringify({sessionId:ids.size===1?[...ids][0]:null}));
}catch{console.log('{"sessionId":null}');}
