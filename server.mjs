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
import {Auth,AuthError} from './auth.mjs';
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
const root=path.dirname(fileURLToPath(import.meta.url));const dataDir=process.env.DATA_DIR||path.join(root,'runtime');await fs.mkdir(dataDir,{recursive:true});
const port=Number(process.env.PORT||8765),base='http://127.0.0.1:'+port,token=randomBytes(32).toString('hex');
const db=new DatabaseSync(path.join(dataDir,'local.sqlite'));db.exec('CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, body TEXT); CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, body TEXT); CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY, body TEXT)');
const tasks=new Map(db.prepare('SELECT * FROM tasks').all().map(r=>{const t=JSON.parse(r.body);t.state=t.state==='ended'?'ended':'paused';t.next=null;t.reason='재시작 후 자동 실행 안 함';return [r.id,t];}));
const auth=new Auth(db);const notifications=new Notifications(db);const mailConnection=new SavedMailConnection(db,notifications);await mailConnection.restore();
const browser=new Browser(root,base,{profileDir:process.env.FLIGHT_BROWSER_PROFILE||path.join(dataDir,'app-browser-profile'),authorizeContext:async context=>context.addCookies([auth.workerCookie(base)])});let busy=false;
const comparisons=new ComparisonJobs(db,(provider,task,alive)=>browser.compareSite(provider,task,alive));
const aiChat=new AIChatJobs(db,{comparisons,canBrowse:()=>!busy&&!browser.handoff});
const aiSettings=new SavedAISettings(db);await aiSettings.restore(auth.account()?.username,aiChat.client);
const apiClient=aiChat.client;const chatgpt=new ChatGPTConnection(db,{base,owner:()=>auth.account()?.username});await chatgpt.load();const routedAI=new RoutedAI(apiClient,new ChatGPTFlights(chatgpt),chatgpt);aiChat.client=routedAI;
const course=new CourseStore(db);course.backfill();comparisons.onComplete=job=>course.ingest(job);const courseAgents=new CourseAgents(course,new CodexRoleRunner({root,dbFile:path.join(dataDir,'local.sqlite'),dataDir}));let courseCodexCache=null;async function courseCodexStatus(){if(!courseCodexCache||Date.now()-courseCodexCache.at>30000)courseCodexCache={at:Date.now(),value:await codexStatus()};return courseCodexCache.value;}
function aiStatus(username){const saved=aiSettings.status(apiClient,username),selected=routedAI.status();return {...saved,...selected,keyStorage:selected.provider==='api'?saved.keyStorage:'windows-dpapi',apiModel:apiClient.model,apiConfigured:apiClient.status().configured};}
function exportSettings(){writeFileSync(path.join(dataDir,'monitoring-conditions.json'),JSON.stringify({updatedAt:new Date().toISOString(),intervalMinutes:10,providers:providers.map(({id,name,url})=>({id,name,url})),tasks:[...tasks.values()].filter(t=>t.mode==='real'&&t.state!=='ended')},null,2));}
const save=t=>{db.prepare('INSERT OR REPLACE INTO tasks VALUES (?,?)').run(t.id,JSON.stringify(t));exportSettings();};
exportSettings();
function state(t,s,reason=''){if(t.state!==s&&!canTransition(t.state,s))throw Error('상태 전이 불가');t.state=s;t.reason=reason;save(t);}
function notify(t,stage,message,identity=null){const key=t.id+':'+t.mode+':'+t.scenario+':'+stage+':'+(identity||message);if(db.prepare('SELECT id FROM events WHERE id=?').get(key))return;const event={id:randomUUID(),taskId:t.id,comparisonId:t.comparisonId||null,mode:t.mode,stage,message,time:new Date().toISOString(),ack:false};db.prepare('INSERT INTO events VALUES (?,?)').run(key,JSON.stringify(event));notifications.queue(event);}
function history(t,q,result){db.prepare('INSERT INTO history VALUES (?,?)').run(randomUUID(),JSON.stringify({taskId:t.id,mode:t.mode,quote:q,result,time:new Date().toISOString(),aiCalled:false,humanVerified:false}));}
async function run(t){if(busy||comparisons.busy||browser.handoff||t.state!=='monitoring')return;busy=true;const generation=t.generation;const alive=()=>t.generation===generation&&t.state!=='paused'&&t.state!=='ended';
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
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function demo(url){let t;try{t=validate(JSON.parse(url.searchParams.get('data')));}catch{return '<h1>잘못된 데모 조건</h1>';}
 const q=demoQuote(t),encoded=esc(JSON.stringify(q));
 return '<!doctype html><meta charset="utf-8"><title>가상 항공권 데모 · 실제 예약 아님</title><style>body{font:20px sans-serif;max-width:850px;margin:60px auto;background:#eef4fa}button,input{padding:15px;margin:10px}section{padding:30px;background:white;border-radius:20px}</style><h1>DEMO · 가상 항공권</h1><p>실제 항공권·주문·결제 없음</p><section id="screen"><h2>'+esc(t.origin)+' → '+esc(t.destination)+'</h2><p>'+esc(t.departure)+' / '+esc(t.trip==='roundtrip'?t.returnDate:'편도')+' / 성인 '+t.adults+'명</p><button id="search">검색 실행</button></section><script>const q=JSON.parse('+JSON.stringify(JSON.stringify(q))+');document.querySelector("#search").onclick=()=>{document.querySelector("#screen").innerHTML="<h2>DEMO101 · 가상 운임</h2><p>표시 운임 "+q.displayFare+" / 필수 비용 포함 전체 총액 "+q.total+" "+q.currency+"</p><p>"+q.baggageText+"</p><pre id=quote hidden></pre><button id=select>가상 운임 선택</button>";document.querySelector("#quote").textContent=JSON.stringify(q);document.querySelector("#select").onclick=()=>{document.querySelector("#screen").innerHTML="<h2>가상 탑승객 정보</h2><label>가상 탑승객 이름 <input></label><button id=prepare>가상 입력 완료 · 주문 생성 없음</button>";document.querySelector("#prepare").onclick=()=>{const final={...q,total:q.scenario==="rise"?"350000":q.total};document.querySelector("#screen").innerHTML="<h2>데모 결제 전 확인</h2><p>최종 전체 총액 "+final.total+" "+q.currency+"</p><p>입력 완료 · 미결제 주문 없음 · 결제 기한 미확인 · 좌석 확보 아님</p><pre id=final hidden></pre>";document.querySelector("#final").textContent=JSON.stringify(final);};};};</script>';}
async function body(req){let s='';for await(const chunk of req){s+=chunk;if(s.length>12000)throw Error('요청 크기 초과');}return s?JSON.parse(s):{};}
const server=http.createServer(async(req,res)=>{const url=new URL(req.url,base);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 const send=(status,data,type='application/json')=>{res.writeHead(status,{'Content-Type':type+'; charset=utf-8'});res.end(type==='application/json'?JSON.stringify(data):data);};
 if(req.headers.host!=='127.0.0.1:'+port)return send(403,{error:'호스트 차단'});
 if(req.headers.origin&&req.headers.origin!==base)return send(403,{error:'요청 출처 차단'});
 if(req.headers['sec-fetch-site']==='cross-site'&&!(req.method==='GET'&&url.pathname==='/auth/chatgpt/callback'))return send(403,{error:'외부 요청 차단'});
 try{
 if(req.method==='GET'&&url.pathname==='/auth/chatgpt/callback'){
 let message,ok=false;try{const state=await chatgpt.callback(url.searchParams);message=state.canUse?'ChatGPT 구독 연결을 완료했습니다. 홈페이지로 돌아가 모델을 선택해주세요.':'로그인했지만 구독 사용 권한이 없습니다. 다시 연결하고 구독 사용을 허용해주세요.';ok=true;}catch(e){message=e.message;}
 return send(ok?200:400,'<!doctype html><html lang="ko"><meta charset="utf-8"><title>ChatGPT 연결</title><style>body{font:18px/1.8 system-ui;max-width:650px;margin:80px auto;padding:20px;color:#17385c}a{color:#2469ed}</style><h1>ChatGPT 연결</h1><p>'+esc(message)+'</p><a href="'+base+'">여정 레이더로 돌아가기</a><script>if(window.opener){window.opener.postMessage({type:"journey-chatgpt-connected",ok:'+String(ok)+'},'+JSON.stringify(base)+');}</script></html>','text/html');}
 if(req.method==='GET'&&/^\/assets\/(tokyo|japan|shanghai|osaka)\.jpg$/.test(url.pathname)){res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'public, max-age=86400'});return res.end(await fs.readFile(path.join(root,url.pathname.slice(1))));}
 if(req.method==='GET'&&['/','/login'].includes(url.pathname)){
 if(!auth.session(req)){const boot=auth.issueBoot(req,res);return send(200,(await fs.readFile(path.join(root,'login.html'),'utf8')).replace('__SETUP__',String(!auth.account())).replace('__BOOT_TOKEN__',boot),'text/html');}
 return send(200,(await fs.readFile(path.join(root,'ui.html'),'utf8')).replace('__TOKEN__',token),'text/html');}
 if(req.method==='GET'&&url.pathname==='/api/auth/status'){const session=auth.session(req);return send(200,{configured:!!auth.account(),authenticated:!!session,username:session?.username??null});}
 if(req.method==='POST'&&['/api/auth/setup','/api/auth/login'].includes(url.pathname)){const input=await body(req);if(url.pathname.endsWith('/setup'))await auth.setup(req,res,input);else await auth.login(req,res,input);return send(200,{ok:true});}
 const session=auth.session(req);if(!session)return send(401,{error:'로그인이 필요합니다.'});
 if(req.method==='GET'&&url.pathname==='/auth/chatgpt/authorize'){const target=chatgpt.authorize(url.searchParams.get('ticket'),session.username);res.writeHead(302,{Location:target});return res.end();}
 if(req.method==='GET'&&['/course-lab.js','/cloud-ui.js'].includes(url.pathname))return send(200,await fs.readFile(path.join(root,url.pathname.slice(1)),'utf8'),'text/javascript');
 if(req.method==='GET'&&url.pathname==='/ai-chat.js')return send(200,await fs.readFile(path.join(root,'ai-chat.js'),'utf8'),'text/javascript');
 if(req.method==='GET'&&url.pathname==='/demo/search')return send(200,demo(url),'text/html');
 if(req.headers['x-local-token']!==token)return send(403,{error:'로컬 접근 토큰 필요'});
 if(req.method==='GET'&&url.pathname==='/api/course/status')return send(200,{version:'2.0.0',conditions:course.conditions(),memory:course.memory(session.username),analyses:course.listAnalyses(session.username),runner:await courseCodexStatus(),observations:db.prepare('SELECT count(*) AS n FROM course_observations').get().n,cloudDeployed:(await cloudStatus(dataDir)).deployed});
 if(req.method==='GET'&&url.pathname==='/api/course/charts')return send(200,course.charts(url.searchParams.get('taskId')));
 if(req.method==='GET'&&url.pathname==='/api/course/analysis')return send(200,courseAgents.get(session.username,url.searchParams.get('id')));
 if(req.method==='GET'&&url.pathname==='/api/course/git'){try{const result=await promisify(execFile)('git',['-C',root,'log','-3','--format=%h %s'],{windowsHide:true,timeout:5000});return send(200,{available:true,log:result.stdout.trim().split('\n')});}catch{return send(200,{available:false,log:[]});}}
 if(req.method==='GET'&&url.pathname==='/api/cloud/status'){let refreshError=null;if(url.searchParams.get('refresh')==='1')try{await refreshDeployment(dataDir);}catch{refreshError='GitHub에서 최신 상태를 확인하지 못했습니다. 마지막 확인 기록입니다.';}let config;try{config=savedCloudConfig(db,[...tasks.values()],notifications.cloudSettings());}catch{}return send(200,{...await cloudStatus(dataDir,config),refreshError});}
 if(req.method==='GET'&&url.pathname==='/api/cloud/config'){
 let salt=db.prepare("SELECT value FROM ai_preferences WHERE name='cloud-notification-salt'").get()?.value;if(!salt){salt=randomBytes(32).toString('hex');db.prepare('INSERT OR REPLACE INTO ai_preferences VALUES (?,?)').run('cloud-notification-salt',salt);}
 return send(200,exportCloudConfig([...tasks.values()],notifications.cloudSettings(),salt));}
 if(req.method==='GET'&&url.pathname==='/api/ai/config')return send(200,aiStatus(session.username));
 if(req.method==='GET'&&url.pathname==='/api/ai/models')return send(200,{models:await chatgpt.models(url.searchParams.get('refresh')==='1')});
 if(req.method==='GET'&&url.pathname==='/api/ai/chat'){const job=aiChat.get(url.searchParams.get('id'));return job?send(200,job):send(404,{error:'AI 검색 결과가 없습니다.'});}
 if(req.method==='GET'&&url.pathname==='/api/comparisons'){const job=comparisons.get(url.searchParams.get('id'));return job?send(200,job):send(404,{error:'검색 결과가 없습니다.'});}
 if(req.method==='GET'&&url.pathname==='/api/notifications')return send(200,notifications.status());
 if(req.method==='GET'&&url.pathname==='/api/status')return send(200,{tasks:[...tasks.values()],events:db.prepare('SELECT body FROM events ORDER BY rowid DESC LIMIT 100').all().map(r=>JSON.parse(r.body)),history:db.prepare('SELECT body FROM history ORDER BY rowid DESC LIMIT 100').all().map(r=>JSON.parse(r.body)),providers:providers.map(({id,name,url})=>({id,name,url})),destinationCatalog,notificationSettings:notifications.status(),monitoringEngine:'local-server',intervalMinutes:10,account:{username:session.username},credentials:await browser.credentialStatus(),busy,handoff:browser.handoff,airports,ai:aiChat.client.status().configured?'GPT 채팅 검색 연결됨':'GPT 채팅 검색 · API 키 연결 필요',real:'10분 간격 공개 표시 운임 조회 · 판매처 최종 총액 어댑터 미완성',base});
 if(req.method!=='POST')return send(404,{error:'경로 없음'});const x=await body(req);
 if(url.pathname==='/api/cloud/test-email'){if(!notifications.status().mail.ready||notifications.settings().mail.provider!=='brevo')throw Error('먼저 Brevo 메일 발송 연결을 저장해주세요.');await syncCloudConfig(dataDir,savedCloudConfig(db,[...tasks.values()],notifications.cloudSettings()));return send(200,await testCloudEmail(dataDir));}
 if(url.pathname==='/api/cloud/sync')return send(200,await syncCloudConfig(dataDir,savedCloudConfig(db,[...tasks.values()],notifications.cloudSettings())));
 if(url.pathname==='/api/course/memory')return send(200,course.saveMemory(session.username,x.preferences,x.expectedVersion));
 if(url.pathname==='/api/course/mcp/check')return send(200,await inspectMcp({root,dbFile:path.join(dataDir,'local.sqlite'),owner:session.username,taskId:x.taskId}));
 if(url.pathname==='/api/course/analysis'){const status=await courseCodexStatus();if(!status.connected)throw Error('먼저 이 PC의 Codex에서 ChatGPT 계정으로 로그인해주세요. 별도 API 잔액은 자동 사용하지 않습니다.');return send(202,courseAgents.start(session.username,x));}
 if(url.pathname==='/api/course/cancel')return send(200,courseAgents.cancel(session.username,x.id));
 if(url.pathname==='/api/ai/config'){if(aiChat.running)throw Error('AI 검색을 중지한 뒤 연결 설정을 변경해주세요.');await aiSettings.save(session.username,x,apiClient);routedAI.use('api');return send(200,aiStatus(session.username));}
 if(url.pathname.startsWith('/api/ai/chatgpt/')||url.pathname==='/api/ai/provider'){
 if(aiChat.running)throw Error('진행 중인 AI 검색을 먼저 중지해주세요.');
 if(url.pathname==='/api/ai/chatgpt/welcome'){const record=chatgpt.current();if(!record)throw Error('연결된 계정 없음');await chatgpt.persist({...record,planNoticeDismissed:true});return send(200,{ok:true});}
 if(url.pathname==='/api/ai/chatgpt/start')return send(200,chatgpt.start(session.username,x));
 if(url.pathname==='/api/ai/chatgpt/select'){chatgpt.select(x.id);routedAI.use('chatgpt');return send(200,aiStatus(session.username));}
 if(url.pathname==='/api/ai/chatgpt/model'){await chatgpt.chooseModel(x.model);return send(200,aiStatus(session.username));}
 if(url.pathname==='/api/ai/chatgpt/disconnect')return send(200,await chatgpt.disconnect());
 if(url.pathname==='/api/ai/provider'){routedAI.use(x.provider);return send(200,aiStatus(session.username));}}
 if(url.pathname==='/api/ai/chat'){if(aiSettings.saving)throw Error('키 설정 저장 후 검색해주세요.');return send(202,aiChat.create(x));}
 if(url.pathname==='/api/ai/cancel')return send(200,aiChat.cancel(x.id));
 if(url.pathname==='/api/comparisons'){if(busy||browser.handoff)throw Error('다른 브라우저 작업이 진행 중입니다. 종료 후 검색해주세요.');return send(202,comparisons.create(validate({...x,mode:'real',interval:10,scenario:'below',autoPrepare:false,currency:'KRW'})));}
 if(url.pathname==='/api/comparisons/cancel')return send(200,comparisons.cancel(x.id));
 if(url.pathname==='/api/notifications/reference'){if(typeof x.enabled!=='boolean')throw Error('알림 기준을 확인해주세요.');const old=notifications.settings();const s=notifications.save({mail:{...old.mail,inputStageAlerts:x.enabled},sms:old.sms});if((await cloudStatus(dataDir)).deployed)try{await syncCloudConfig(dataDir,savedCloudConfig(db,[...tasks.values()],notifications.cloudSettings()));s.cloudSynced=true;}catch{s.cloudSynced=false;}return send(200,s);}
 if(url.pathname==='/api/notifications/connection'){const s=await mailConnection.save(x);if((await cloudStatus(dataDir)).deployed)try{await syncCloudConfig(dataDir,savedCloudConfig(db,[...tasks.values()],notifications.cloudSettings()));s.cloudSynced=true;}catch{s.cloudSynced=false;}return send(200,s);}
 if(url.pathname==='/api/notifications/email'){const old=notifications.settings();const to=String(x.to||'').trim();const s=notifications.save({mail:{...old.mail,enabled:!!to,provider:old.mail.provider==='brevo'?'brevo':'formsubmit',to},sms:old.sms});return send(200,s);}
 if(url.pathname==='/api/notifications'){return send(200,notifications.save(x));}
 if(url.pathname==='/api/notifications/test'){return send(200,await notifications.test(x.channel));}
 if(url.pathname==='/api/auth/logout'){auth.logout(req,res);return send(200,{ok:true});}
 if(url.pathname==='/api/tasks'){const input=validate(x);if(input.mode==='real'&&[...tasks.values()].filter(t=>t.mode==='real'&&t.state!=='ended').length>=5)throw Error('감시 조건은 최대 5개입니다. 기존 조건을 종료한 뒤 추가하세요.');const t={...input,id:randomUUID(),state:'paused',generation:0,next:null,last:null,latest:null};tasks.set(t.id,t);save(t);return send(201,t);}
 if(url.pathname==='/api/edit'){const t=tasks.get(x.id);if(!t||t.state!=='paused')throw Error('일시정지 상태에서만 수정 가능');const data=validate(x);if(t.mode!==data.mode)throw Error('저장 후 모드는 변경할 수 없습니다');Object.assign(t,data,{generation:t.generation+1,next:null,latest:null,last:null,lastAttempt:null,comparisonId:null,sites:{},reason:'조건 수정됨 · 변경한 조건으로 다시 검색해주세요.'});save(t);return send(200,t);}
 if(url.pathname==='/api/action'){const t=tasks.get(x.id);if(!t)throw Error('작업 없음');if(x.action==='start'){if(!['paused','action_required','needs_review','error'].includes(t.state))throw Error('시작 불가');state(t,'monitoring');t.generation++;t.next=new Date().toISOString();t.reason=t.mode==='real'?'홈페이지 서버가 10분마다 5개 출처를 조회합니다':'';save(t);void run(t);}else if(['pause','end'].includes(x.action)){t.generation++;state(t,x.action==='pause'?'paused':'ended');t.next=null;save(t);}else throw Error('동작 오류');return send(200,{ok:true});}
 if(url.pathname==='/api/observations'){
 const t=tasks.get(x.taskId);if(!t||t.mode!=='real'||t.state!=='monitoring')throw Error('실행 중인 실사용 감시 조건만 기록 가능');
 if(x.generation!==t.generation)throw Error('조건이 변경되었거나 중지된 조회 결과입니다');const observation=validateObservation(x);let verdict=null;let quote=null;
 if(x.quote){const q=x.quote;quote=Object.fromEntries(['origin','destination','departure','returnDate','trip','adults','currency','total','basis','taxIncluded','baggageIncluded','flight','fare','stops','duration','baggageText','baggageKg'].map(k=>[k,q[k]]));quote.source=observation.source;quote.observedAt=observation.observedAt;if(x.status==='observed'){if(t.baggage&&(!x.confirmedFields.includes('baggageIncluded')||!x.confirmedFields.includes('baggageKg')))throw Error('필수 수하물 확인 필요');verdict=verifyPayable(t,{displayPrice:quote.total,purchaseVerification:x.purchaseVerification});if(verdict.comparable)quote.total=verdict.confirmedTotal;if(verdict.comparable&&verdict.status==='matched')notify(t,'조건 충족 발견',providers.find(p=>p.id===x.providerId).name+' · 전체 총액 '+quote.total+' '+quote.currency+' · '+quote.flight+' · 예약/좌석 확보 아님');history(t,quote,verdict);}}
 t.sites={...(t.sites||{}),[x.providerId]:{...observation,result:verdict,total:quote?.total??null,currency:quote?.currency??null,flight:quote?.flight??null}};
 t.lastAttempt=observation.observedAt;if(x.status==='observed'&&verdict?.comparable){t.last=observation.observedAt;t.latest=quote.total;}t.next=new Date(Date.now()+10*60000).toISOString();t.reason='사이트별 확인 상태를 확인하세요';save(t);return send(200,{ok:true,result:verdict});}
 if(url.pathname==='/api/browser'){if(busy)throw Error('브라우저 작업 중');if(x.action==='release')await browser.release();else if(x.action==='close')await browser.context?.close();else if(x.action==='real')await browser.real();else await browser.focus();return send(200,{ok:true});}
 if(url.pathname==='/api/ack'){for(const row of db.prepare('SELECT id,body FROM events').all()){const e=JSON.parse(row.body);if(e.id===x.id){e.ack=true;db.prepare('UPDATE events SET body=? WHERE id=?').run(JSON.stringify(e),row.id);}}return send(200,{ok:true});}
 return send(404,{error:'경로 없음'});
 }catch(e){if(url.pathname.startsWith('/api/auth/'))return send(e instanceof AuthError?e.status:400,{error:e instanceof AuthError?e.message:'로그인 요청을 처리할 수 없습니다. 화면을 새로고침해주세요.'});return send(400,{error:e instanceof SyntaxError?'요청 형식을 확인해주세요.':e.message?.includes('browser')?'브라우저 작업 실패':e.message||'입력 오류'});}});
setInterval(()=>{for(const t of tasks.values())if(t.state==='monitoring'&&t.next&&Date.parse(t.next)<=Date.now()){void run(t);break;}},1000).unref();
server.listen(port,'127.0.0.1',()=>console.log('LOCAL_SERVER '+base));
