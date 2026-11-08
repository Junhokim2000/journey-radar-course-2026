import {bootstrapTestOwner,startTestServer} from './helpers.mjs';
import {test} from 'node:test';import assert from 'node:assert/strict';import {chromium} from 'playwright';import fs from 'node:fs/promises';

test('브라우저 데모 5개 시나리오와 알림·중복·중지 검증',async()=>{
 const fixture=await startTestServer(8769,'browser-test-');const base=fixture.base;const access=await bootstrapTestOwner(base);
 const c=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:false});
 try{const context=await c.newContext();await access.install(context);const p=await context.newPage();await p.goto(base);await p.getByRole('heading',{name:'여정 레이더'}).waitFor();const token=access.token;
 const api=async(url,data)=>{const r=await access.fetch(base+url,{method:data?'POST':'GET',headers:{'X-Local-Token':token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const x=await r.json();assert.ok(r.ok,JSON.stringify(x));return x;};
 const results=[];
 for(const [scenario,expected] of [['below','prepayment'],['equal','prepayment'],['above','monitoring'],['baggage','monitoring'],['rise','action_required'],['unknown','needs_review'],['session','action_required']]){
  const t=await api('/api/tasks',{origin:'ICN',destination:'KIX',departure:'2026-11-21',returnDate:'2026-11-24',trip:'roundtrip',adults:1,target:'300000',currency:'KRW',interval:60,mode:'demo',scenario,autoPrepare:true,baggage:true});
  await api('/api/action',{id:t.id,action:'start'});let status;
  for(let i=0;i<200;i++){status=await api('/api/status');const task=status.tasks.find(x=>x.id===t.id);if(task.last&&!status.busy)break;await new Promise(r=>setTimeout(r,100));}
  const task=status.tasks.find(x=>x.id===t.id);assert.equal(task.state,expected,scenario+': '+JSON.stringify(task));
  const before=status.events.filter(x=>x.taskId===t.id).length;
  if(expected==='prepayment'){assert.equal(status.handoff,true);await api('/api/browser',{action:'release'});}
  await api('/api/action',{id:t.id,action:'pause'});
  assert.equal((await api('/api/status')).tasks.find(x=>x.id===t.id).state,'paused');
  if(scenario==='below'){await api('/api/action',{id:t.id,action:'start'});for(let i=0;i<200;i++){status=await api('/api/status');if(!status.busy)break;await new Promise(r=>setTimeout(r,100));}assert.equal(status.events.filter(x=>x.taskId===t.id).length,before);await api('/api/browser',{action:'release'});await api('/api/action',{id:t.id,action:'pause'});}
  results.push({scenario,expected,actual:task.state,mode:'demo',aiCalled:false,humanVerified:false,at:new Date().toISOString()});
 }
 assert.equal((await fetch(base+'/api/status')).status,401);
 assert.equal((await fetch(base+'/api/tasks',{method:'POST',headers:{'Origin':'https://example.com','X-Local-Token':token},body:'{}'})).status,403);
 await fs.writeFile('docs/browser-results.json',JSON.stringify(results,null,2));
 await p.reload();await p.getByRole('heading',{name:/감시 작업/}).waitFor();await p.screenshot({path:'docs/dashboard-demo.png',fullPage:true});
 }finally{await access.fetch(base+'/api/browser',{method:'POST',headers:{'X-Local-Token':access.token,'Content-Type':'application/json'},body:JSON.stringify({action:'close'})}).catch(()=>{});await c.close();await fixture.close();}
});