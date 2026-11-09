import {SavedMailConnection} from './saved-mail-connection.mjs';
import {refreshDeployment} from './cloud/refresh.mjs';
import {cloudStatus,savedCloudConfig,syncCloudConfig,testCloudEmail} from './cloud/status.mjs';
import {CourseStore} from './course/store.mjs';
import {CourseAgents,CodexRoleRunner,codexStatus} from './course/agents.mjs';
import {inspectMcp} from './mcp/inspect.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import http from 'node:http';
import {exportCloudConfig} from './cloud/config.mjs';
import {AIChatJobs} from './ai-chat.mjs';
import {SavedAISettings} from './saved-ai-settings.mjs';
import {ChatGPTConnection,ChatGPTFlights,RoutedAI} from './chatgpt-auth.mjs';
import {verifyPayable} from './pricing.mjs';
import {ComparisonJobs} from './comparison.mjs';
import {recurringComparison} from './recurring-comparison.mjs';
import {Notifications} from './notifications.mjs';
import {MemberNotifications} from './member-notifications.mjs';
import {writeFileSync} from 'node:fs';
import {providers,validateObservation} from './providers.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {validate,evaluate,canTransition,demoQuote,airports,destinationCatalog} from './core.mjs';
import {Browser} from './browser.mjs';
import {checkSites} from './monitor.mjs';

export async function createWorkspace({db,auth,root,dataDir,base,username=null,sharedAI=null,sharedNotifications=null,canUseBrowser=()=>true}){
const tasks=new Map(db.prepare('SELECT * FROM tasks').all().map(r=>{const t=JSON.parse(r.body);t.state=t.state==='ended'?'ended':'paused';t.next=null;t.reason='재시작 후 자동 실행 안 함';return [r.id,t];}));
const notifications=sharedNotifications?new MemberNotifications(db,sharedNotifications):new Notifications(db);const mailConnection=new SavedMailConnection(db,notifications);await mailConnection.restore();
const browser=new Browser(root,base,{profileDir:username?path.join(dataDir,'app-browser-profile'):process.env.FLIGHT_BROWSER_PROFILE||path.join(dataDir,'app-browser-profile'),authorizeContext:async context=>context.addCookies([auth.workerCookie(base,username||auth.account()?.username)])});let busy=false;
const comparisons=new ComparisonJobs(db,(provider,task,alive)=>browser.compareSite(provider,task,alive));
const aiChat=new AIChatJobs(db,{comparisons,canBrowse:()=>canUseBrowser()&&!busy&&!browser.handoff});
const aiSettings=new SavedAISettings(db);await aiSettings.restore((username||auth.account()?.username),aiChat.client);
const apiClient=aiChat.client;const chatgpt=new ChatGPTConnection(db,{base,owner:()=>(username||auth.account()?.username)});await chatgpt.load();const routedAI=new RoutedAI(apiClient,new ChatGPTFlights(chatgpt),chatgpt);aiChat.client=sharedAI||routedAI;
const course=new CourseStore(db);course.backfill();comparisons.onComplete=job=>course.ingest(job);const courseAgents=new CourseAgents(course,new CodexRoleRunner({root,dbFile:path.join(dataDir,'local.sqlite'),dataDir}));let courseCodexCache=null;async function courseCodexStatus(){if(!courseCodexCache||Date.now()-courseCodexCache.at>30000)courseCodexCache={at:Date.now(),value:await codexStatus()};return courseCodexCache.value;}
function aiStatus(username){const saved=aiSettings.status(apiClient,username),selected=routedAI.status();return {...saved,...selected,keyStorage:selected.provider==='api'?saved.keyStorage:'windows-dpapi',apiModel:apiClient.model,apiConfigured:apiClient.status().configured};}
function exportSettings(){writeFileSync(path.join(dataDir,'monitoring-conditions.json'),JSON.stringify({updatedAt:new Date().toISOString(),intervalMinutes:10,providers:providers.map(({id,name,url})=>({id,name,url})),tasks:[...tasks.values()].filter(t=>t.mode==='real'&&t.state!=='ended')},null,2));}
const save=t=>{db.prepare('INSERT OR REPLACE INTO tasks VALUES (?,?)').run(t.id,JSON.stringify(t));exportSettings();};
exportSettings();
function state(t,s,reason=''){if(t.state!==s&&!canTransition(t.state,s))throw Error('상태 전이 불가');t.state=s;t.reason=reason;save(t);}
function notify(t,stage,message,identity=null){const key=t.id+':'+t.mode+':'+t.scenario+':'+stage+':'+(identity||message);if(db.prepare('SELECT id FROM events WHERE id=?').get(key))return;const event={id:randomUUID(),taskId:t.id,comparisonId:t.comparisonId||null,mode:t.mode,stage,message,time:new Date().toISOString(),ack:false};db.prepare('INSERT INTO events VALUES (?,?)').run(key,JSON.stringify(event));notifications.queue(event);}
function history(t,q,result){db.prepare('INSERT INTO history VALUES (?,?)').run(randomUUID(),JSON.stringify({taskId:t.id,mode:t.mode,quote:q,result,time:new Date().toISOString(),aiCalled:false,humanVerified:false}));}
async function run(t){if(!canUseBrowser()||busy||comparisons.busy||browser.handoff||t.state!=='monitoring')return;busy=true;const generation=t.generation;const alive=()=>t.generation===generation&&t.state!=='paused'&&t.state!=='ended';
 try{state(t,'searching');if(t.mode!=='real')t.last=new Date().toISOString();t.next=null;save(t);
 if(t.mode==='real'){
 await recurringComparison(t,{comparisons,alive,save,notify,history,inputStageAlerts:notifications.settings().mail.inputStageAlerts===true});
 if(alive()){state(t,'monitoring',t.reason);t.failures=0;}return;}

 let matched=false;
 const result=await browser.demo(t,alive,async q=>{if(!alive())return;const verdict=evaluate(t,q);t.latest=q.total;history(t,q,verdict);save(t);
 if(verdict.status==='matched'){matched=true;state(t,'candidate',verdict.reason);notify(t,'1차 후보 발견','데모 전체 총액 '+q.total+' '+t.currency+' · 좌석 확보 아님');}
 else if(verdict.status==='needs_review')state(t,'needs_review',verdict.reason);
 else state(t,'monitoring',verdict.reason);
 });
 if(!result||!alive())return;
 if(matched&&t.autoPrepare){state(t,'preparing');const final=await browser.prepare(t,alive);if(!final||!alive())return;
 if(final.status==='action_required'){state(t,'action_required',final.reason);notify(t,'2차 준비 실패',final.reason);return;}
 const verdict=evaluate(t,final);history(t,final,verdict);
 if(verdict.status!=='matched'){state(t,'action_required','준비 중 가격 또는 조건 변경: '+verdict.reason);notify(t,'2차 준비 중단',t.reason);return;}
 state(t,'prepayment','데모 정보 입력 완료 · 결제 기한 미확인 · 주문 생성 없음');await browser.hold();notify(t,'2차 결제 전 화면',t.reason+' · 최종 총액 '+final.total+' '+t.currency);
 }else if(matched)state(t,'monitoring','후보 발견 · 검색만 모드');
 t.failures=0;
 }catch(e){if(alive()){t.failures=(t.failures||0)+1;state(t,t.mode==='real'?'monitoring':t.failures>=3?'error':'action_required',e.message==='HANDOFF'?'사용자 브라우저 확인 대기':'브라우저 또는 페이지 오류 · 다음 예약 시각에 재시도');notify(t,'오류',t.reason);}}
 finally{if(t.state==='monitoring')t.next=new Date(Date.now()+t.interval*60000*(t.mode==='real'?1:Math.min(4,2**(t.failures||0)))).toISOString();save(t);busy=false;}}

return {db,dataDir,username,tasks,notifications,mailConnection,browser,comparisons,aiChat,aiSettings,apiClient,chatgpt,routedAI,course,courseAgents,aiStatus,courseCodexStatus,exportSettings,save,state,notify,history,run,get busy(){return busy;}};
}
