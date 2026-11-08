import fs from 'node:fs/promises';import path from 'node:path';import {spawn} from 'node:child_process';
export async function startTestServer(port,prefix='test-'){
 const dir=await fs.mkdtemp(path.resolve('runtime/'+prefix));let processHandle;
 const start=async()=>{processHandle=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),DATA_DIR:dir},windowsHide:true,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{processHandle.kill();reject(Error('테스트 서버 시작 시간 초과'));},30000);processHandle.stdout.on('data',b=>{if(String(b).includes('LOCAL_SERVER')){clearTimeout(timer);resolve();}});processHandle.once('error',reject);processHandle.once('exit',code=>{if(code)reject(Error('테스트 서버 종료'));});});};
 const stop=async()=>{if(processHandle&&processHandle.exitCode===null){processHandle.kill();await new Promise(r=>processHandle.exitCode!==null?r():processHandle.once('exit',r));}};await start();return {dir,base:'http://127.0.0.1:'+port,restart:async()=>{await stop();await start();},close:async()=>{await stop();const resolved=await fs.realpath(dir);if(!resolved.startsWith(path.resolve('runtime')+path.sep))throw Error('테스트 디렉터리 경계 오류');await fs.rm(resolved,{recursive:true,force:true});}};
}
export const testOwner={username:'test-owner',password:'TEST_ONLY_Password_2026'};
export async function bootstrapTestOwner(base){
 const first=await fetch(base);const loginHTML=await first.text();const boot=first.headers.getSetCookie().find(s=>s.startsWith('flight_boot=')).split(';')[0];const csrf=loginHTML.match(/csrf='([^']+)'/)[1];
 const setup=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Token':csrf,Cookie:boot},body:JSON.stringify({...testOwner,passwordConfirm:testOwner.password})});if(!setup.ok)throw Error('테스트 계정 생성 실패');
 const session=setup.headers.getSetCookie().find(s=>s.startsWith('flight_session=')).split(';')[0];const authenticatedFetch=(url,options={})=>fetch(url,{...options,headers:{...options.headers,Cookie:session}});const html=await(await authenticatedFetch(base)).text();const token=html.match(/const token='([^']+)'/)[1];return {token,fetch:authenticatedFetch,session,install:async context=>context.addCookies([{name:'flight_session',value:session.slice(session.indexOf('=')+1),url:base,httpOnly:true,sameSite:'Strict'}])};
}
