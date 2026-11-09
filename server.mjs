import {serverNetwork} from './network.mjs';
import {combinedSavedCloudConfig} from './cloud/member-config.mjs';
import {createWorkspace} from './workspaces.mjs';
import {SavedMailConnection} from './saved-mail-connection.mjs';
import {refreshDeployment} from './cloud/refresh.mjs';
import {cloudStatus,savedCloudConfig,syncCloudConfig,testCloudEmail} from './cloud/status.mjs';
import {CourseStore} from './course/store.mjs';
import {CourseAgents,CodexRoleRunner,codexStatus} from './course/agents.mjs';
import {inspectMcp} from './mcp/inspect.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import http from 'node:http';
import {cloudConfig,exportCloudConfig} from './cloud/config.mjs';
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
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {validate,evaluate,canTransition,demoQuote,airports,destinationCatalog} from './core.mjs';
import {Browser} from './browser.mjs';
import {checkSites} from './monitor.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));const dataDir=process.env.DATA_DIR||path.join(root,'runtime');await fs.mkdir(dataDir,{recursive:true});
const port=Number(process.env.PORT||8765),base='http://127.0.0.1:'+port,token=randomBytes(32).toString('hex');const network=await serverNetwork(port,dataDir);
const db=new DatabaseSync(path.join(dataDir,'local.sqlite'));db.exec('CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, body TEXT); CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, body TEXT); CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY, body TEXT)');
const auth=new Auth(db),workspaces=new Map();
function readyWorkspaces(){return [...workspaces.values()].filter(w=>w?.tasks);}
function anyBrowserBusy(){return readyWorkspaces().some(w=>w.busy||w.comparisons.busy||w.browser.handoff);}
function anyAIRunning(){return readyWorkspaces().some(w=>w.aiChat.running||w.courseAgents.running);}
const rootWorkspace=await createWorkspace({db,auth,root,dataDir,base,canUseBrowser:anyWorkspaceBrowserAvailable});workspaces.set(Symbol.for('root-admin-workspace'),rootWorkspace);
function anyWorkspaceBrowserAvailable(){return !anyBrowserBusy();}
async function workspaceFor(session){if(session.role==='admin')return rootWorkspace;let w=workspaces.get(session.username);if(w)return await w;const creation=(async()=>{const dir=path.join(dataDir,'members',createHash('sha256').update(session.username).digest('hex'));await fs.mkdir(dir,{recursive:true});const memberDb=new DatabaseSync(path.join(dir,'local.sqlite'));memberDb.exec('CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,body TEXT);CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,body TEXT);CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY,body TEXT)');return createWorkspace({db:memberDb,auth,root,dataDir:dir,base,username:session.username,sharedAI:rootWorkspace.aiChat.client,sharedNotifications:rootWorkspace.notifications,canUseBrowser:anyWorkspaceBrowserAvailable});})();workspaces.set(session.username,creation);try{w=await creation;workspaces.set(session.username,w);return w;}catch(e){workspaces.delete(session.username);throw e;}}
const {chatgpt}=rootWorkspace;

async function combinedCloudConfig(){return combinedSavedCloudConfig(db,dataDir,[...rootWorkspace.tasks.values()],rootWorkspace.notifications.cloudSettings());}
let cloudSyncChain=Promise.resolve();
async function syncAllCloud(){const work=cloudSyncChain.catch(()=>{}).then(async()=>{if(!(await cloudStatus(dataDir)).deployed)return {cloudSynced:false,notDeployed:true};await syncCloudConfig(dataDir,await combinedCloudConfig());return {cloudSynced:true};});cloudSyncChain=work;return work;}
async function syncMemberChange(session,result){if(session.role==='admin')return result;try{Object.assign(result,await syncAllCloud());}catch{result.cloudSynced=false;result.cloudSyncError='조건은 저장됐지만 클라우드 반영에 실패했습니다. 서버 전체 클라우드 한도는 5개이며 관리자에게 확인해주세요.';}return result;}
function publicNotifications(n){const s=n.status();return {mail:{enabled:s.mail.enabled,to:s.mail.to,inputStageAlerts:s.mail.inputStageAlerts===true,provider:'admin-managed',ready:s.mail.ready,service:'관리자 발송 연결'},sms:{enabled:false,ready:false},deliveries:s.deliveries};}
function sharedAIStatus(){const s=rootWorkspace.aiChat.client.status();return {configured:s.configured,provider:s.provider||'chatgpt',model:s.model||'',apiModel:s.model||'',searchGroups:s.searchGroups||[],chatgpt:{connected:!!s.configured,canUse:false,accounts:[]},adminManaged:true};}

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function demo(url){let t;try{t=validate(JSON.parse(url.searchParams.get('data')));}catch{return '<h1>잘못된 데모 조건</h1>';}
 const q=demoQuote(t),encoded=esc(JSON.stringify(q));
 return '<!doctype html><meta charset="utf-8"><title>가상 항공권 데모 · 실제 예약 아님</title><style>body{font:20px sans-serif;max-width:850px;margin:60px auto;background:#eef4fa}button,input{padding:15px;margin:10px}section{padding:30px;background:white;border-radius:20px}</style><h1>DEMO · 가상 항공권</h1><p>실제 항공권·주문·결제 없음</p><section id="screen"><h2>'+esc(t.origin)+' → '+esc(t.destination)+'</h2><p>'+esc(t.departure)+' / '+esc(t.trip==='roundtrip'?t.returnDate:'편도')+' / 성인 '+t.adults+'명</p><button id="search">검색 실행</button></section><script>const q=JSON.parse('+JSON.stringify(JSON.stringify(q))+');document.querySelector("#search").onclick=()=>{document.querySelector("#screen").innerHTML="<h2>DEMO101 · 가상 운임</h2><p>표시 운임 "+q.displayFare+" / 필수 비용 포함 전체 총액 "+q.total+" "+q.currency+"</p><p>"+q.baggageText+"</p><pre id=quote hidden></pre><button id=select>가상 운임 선택</button>";document.querySelector("#quote").textContent=JSON.stringify(q);document.querySelector("#select").onclick=()=>{document.querySelector("#screen").innerHTML="<h2>가상 탑승객 정보</h2><label>가상 탑승객 이름 <input></label><button id=prepare>가상 입력 완료 · 주문 생성 없음</button>";document.querySelector("#prepare").onclick=()=>{const final={...q,total:q.scenario==="rise"?"350000":q.total};document.querySelector("#screen").innerHTML="<h2>데모 결제 전 확인</h2><p>최종 전체 총액 "+final.total+" "+q.currency+"</p><p>입력 완료 · 미결제 주문 없음 · 결제 기한 미확인 · 좌석 확보 아님</p><pre id=final hidden></pre>";document.querySelector("#final").textContent=JSON.stringify(final);};};};</script>';}
async function body(req){let s='';for await(const chunk of req){s+=chunk;if(s.length>12000)throw Error('요청 크기 초과');}return s?JSON.parse(s):{};}
const server=http.createServer(async(req,res)=>{const url=new URL(req.url,base);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 const send=(status,data,type='application/json')=>{res.writeHead(status,{'Content-Type':type+'; charset=utf-8'});res.end(type==='application/json'?JSON.stringify(data):data);};
 if(!network.allowsHost(req.headers.host))return send(403,{error:'호스트 차단'});
 if(req.headers.origin&&req.headers.origin!==network.origin(req))return send(403,{error:'요청 출처 차단'});
 if(req.headers['sec-fetch-site']==='cross-site'&&!(req.method==='GET'&&url.pathname==='/auth/chatgpt/callback'))return send(403,{error:'외부 요청 차단'});
 try{
 if(req.method==='GET'&&url.pathname==='/auth/chatgpt/callback'){
 let message,ok=false;try{const state=await rootWorkspace.chatgpt.callback(url.searchParams);message=state.canUse?'ChatGPT 구독 연결을 완료했습니다. 홈페이지로 돌아가 모델을 선택해주세요.':'로그인했지만 구독 사용 권한이 없습니다. 다시 연결하고 구독 사용을 허용해주세요.';ok=true;}catch(e){message=e.message;}
 return send(ok?200:400,'<!doctype html><html lang="ko"><meta charset="utf-8"><title>ChatGPT 연결</title><style>body{font:18px/1.8 system-ui;max-width:650px;margin:80px auto;padding:20px;color:#17385c}a{color:#2469ed}</style><h1>ChatGPT 연결</h1><p>'+esc(message)+'</p><a href="'+base+'">여정 레이더로 돌아가기</a><script>if(window.opener){window.opener.postMessage({type:"journey-chatgpt-connected",ok:'+String(ok)+'},'+JSON.stringify(base)+');}</script></html>','text/html');}
 if(req.method==='GET'&&/^\/assets\/(tokyo|japan|shanghai|osaka)\.jpg$/.test(url.pathname)){res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'public, max-age=86400'});return res.end(await fs.readFile(path.join(root,url.pathname.slice(1))));}
 if(req.method==='GET'&&['/','/login'].includes(url.pathname)){
 if(!auth.session(req)){const boot=auth.issueBoot(req,res);return send(200,(await fs.readFile(path.join(root,'login.html'),'utf8')).replace('__SETUP__',String(!auth.account())).replace('__BOOT_TOKEN__',boot),'text/html');}
 return send(200,(await fs.readFile(path.join(root,'ui.html'),'utf8')).replace('__TOKEN__',token).replace('__IS_ADMIN__',String(auth.session(req).role==='admin')).replaceAll('__USERNAME__',esc(auth.session(req).username)),'text/html');}
 if(req.method==='GET'&&url.pathname==='/api/auth/status'){const session=auth.session(req);return send(200,{configured:!!auth.account(),authenticated:!!session,username:session?.username??null,role:session?.role??null,registrationOpen:!!auth.account()});}
 if(req.method==='POST'&&['/api/auth/setup','/api/auth/login','/api/auth/register'].includes(url.pathname)){const input=await body(req);if(url.pathname.endsWith('/setup'))await auth.setup(req,res,input);else if(url.pathname.endsWith('/register'))await auth.register(req,res,input);else await auth.login(req,res,input);return send(200,{ok:true});}
 const session=auth.session(req);if(!session)return send(401,{error:'로그인이 필요합니다.'});
 const w=await workspaceFor(session);const {db,tasks,notifications,mailConnection,browser,comparisons,aiChat,aiSettings,apiClient,chatgpt,routedAI,course,courseAgents,aiStatus,courseCodexStatus,save,state,notify,history,run,busy}=w;
 if(req.method==='GET'&&url.pathname==='/auth/chatgpt/authorize'){if(session.role!=='admin')return send(403,{error:'관리자만 연결을 변경할 수 있습니다.'});const target=chatgpt.authorize(url.searchParams.get('ticket'),session.username);res.writeHead(302,{Location:target});return res.end();}
 if(req.method==='GET'&&['/course-lab.js','/cloud-ui.js','/members-ui.js'].includes(url.pathname))return send(200,await fs.readFile(path.join(root,url.pathname.slice(1)),'utf8'),'text/javascript');
 if(req.method==='GET'&&url.pathname==='/ai-chat.js')return send(200,await fs.readFile(path.join(root,'ai-chat.js'),'utf8'),'text/javascript');
 if(req.method==='GET'&&url.pathname==='/demo/search')return send(200,demo(url),'text/html');
 if(req.headers['x-local-token']!==token)return send(403,{error:'로컬 접근 토큰 필요'});
 const admin=session.role==='admin';const adminPaths=['/api/cloud/config','/api/cloud/sync','/api/cloud/test-email','/api/notifications/connection','/api/ai/models','/api/ai/provider','/api/browser','/api/observations','/api/course/git','/api/course/mcp/check','/api/admin/users','/api/admin/users/status','/api/sharing'];if(!admin&&((req.method==='POST'&&['/api/notifications','/api/ai/config'].includes(url.pathname))||adminPaths.includes(url.pathname)||url.pathname.startsWith('/api/ai/chatgpt/')))return send(403,{error:'관리자만 변경하거나 확인할 수 있는 운영 설정입니다.'});
 if(req.method==='GET'&&url.pathname==='/api/sharing')return send(200,{lanEnabled:network.lan,urls:network.urls,localURL:base+'/'});
 if(req.method==='GET'&&url.pathname==='/api/admin/users')return send(200,{users:auth.users()});
 if(req.method==='GET'&&url.pathname==='/api/course/status')return send(200,{version:'2.0.0',conditions:course.conditions(),memory:course.memory(session.username),analyses:course.listAnalyses(session.username),runner:admin?await courseCodexStatus():{connected:(await courseCodexStatus()).connected},observations:db.prepare('SELECT count(*) AS n FROM course_observations').get().n,cloudDeployed:(await cloudStatus(dataDir)).deployed});
 if(req.method==='GET'&&url.pathname==='/api/course/charts')return send(200,course.charts(url.searchParams.get('taskId')));
 if(req.method==='GET'&&url.pathname==='/api/course/analysis')return send(200,courseAgents.get(session.username,url.searchParams.get('id')));
 if(req.method==='GET'&&url.pathname==='/api/course/git'){try{const result=await promisify(execFile)('git',['-C',root,'log','-3','--format=%h %s'],{windowsHide:true,timeout:5000});return send(200,{available:true,log:result.stdout.trim().split('\n')});}catch{return send(200,{available:false,log:[]});}}
 if(req.method==='GET'&&url.pathname==='/api/cloud/status'){let refreshError=null;if(url.searchParams.get('refresh')==='1')try{await refreshDeployment(dataDir);}catch{refreshError='GitHub에서 최신 상태를 확인하지 못했습니다. 마지막 확인 기록입니다.';}if(!admin)return send(200,{deployed:(await cloudStatus(dataDir)).deployed,scheduleEnabled:(await cloudStatus(dataDir)).scheduleEnabled,ownConditions:[...tasks.values()].filter(t=>t.mode==='real'&&t.state!=='ended').length,receiverConfigured:!!notifications.settings().mail.to,adminManaged:true,summary:{},sources:[]});let config;try{config=await combinedCloudConfig();}catch{}return send(200,{...await cloudStatus(dataDir,config),refreshError});}
 if(req.method==='GET'&&url.pathname==='/api/cloud/config')return send(200,await combinedCloudConfig());
 if(req.method==='GET'&&url.pathname==='/api/ai/config')return send(200,admin?aiStatus(session.username):sharedAIStatus());
 if(req.method==='GET'&&url.pathname==='/api/ai/models')return send(200,{models:await chatgpt.models(url.searchParams.get('refresh')==='1')});
 if(req.method==='GET'&&url.pathname==='/api/ai/chat'){const job=aiChat.get(url.searchParams.get('id'));return job?send(200,job):send(404,{error:'AI 검색 결과가 없습니다.'});}
 if(req.method==='GET'&&url.pathname==='/api/comparisons'){const job=comparisons.get(url.searchParams.get('id'));return job?send(200,job):send(404,{error:'검색 결과가 없습니다.'});}
 if(req.method==='GET'&&url.pathname==='/api/notifications')return send(200,admin?notifications.status():publicNotifications(notifications));
 if(req.method==='GET'&&url.pathname==='/api/status')return send(200,{tasks:[...tasks.values()],events:db.prepare('SELECT body FROM events ORDER BY rowid DESC LIMIT 100').all().map(r=>JSON.parse(r.body)),history:db.prepare('SELECT body FROM history ORDER BY rowid DESC LIMIT 100').all().map(r=>JSON.parse(r.body)),providers:providers.map(({id,name,url})=>({id,name,url})),destinationCatalog,notificationSettings:admin?notifications.status():publicNotifications(notifications),monitoringEngine:'local-server',intervalMinutes:10,account:{username:session.username,role:session.role},credentials:admin?await browser.credentialStatus():{},busy,handoff:browser.handoff,airports,ai:aiChat.client.status().configured?'GPT 채팅 검색 연결됨':'GPT 채팅 검색 · API 키 연결 필요',real:'10분 간격 공개 표시 운임 조회 · 판매처 최종 총액 어댑터 미완성',base});
 if(req.method!=='POST')return send(404,{error:'경로 없음'});const x=await body(req);
 if(url.pathname==='/api/admin/users/status'){const result=auth.setEnabled(x.username,x.enabled);const member=workspaces.get(auth.account(x.username)?.username);if(x.enabled===false&&member?.tasks){for(const t of member.tasks.values())if(t.state!=='ended'){t.generation++;t.state='paused';t.next=null;member.save(t);}if(member.aiChat.running)member.aiChat.cancel(member.aiChat.running);if(member.courseAgents.running)member.courseAgents.cancel(member.username,member.courseAgents.running);}try{await syncAllCloud();}catch{}return send(200,result);}
 if(url.pathname==='/api/cloud/test-email'){if(!notifications.status().mail.ready||notifications.settings().mail.provider!=='brevo')throw Error('먼저 Brevo 메일 발송 연결을 저장해주세요.');await syncAllCloud();return send(200,await testCloudEmail(dataDir));}
 if(url.pathname==='/api/cloud/sync')return send(200,{ok:true,...await syncAllCloud(),note:'계정별 조건·수신 이메일을 비공개 클라우드 설정에 반영했습니다.'});
 if(url.pathname==='/api/course/memory')return send(200,course.saveMemory(session.username,x.preferences,x.expectedVersion));
 if(url.pathname==='/api/course/mcp/check')return send(200,await inspectMcp({root,dbFile:path.join(w.dataDir,'local.sqlite'),owner:session.username,taskId:x.taskId}));
 if(url.pathname==='/api/course/analysis'){if(anyAIRunning())throw Error('다른 AI 작업이 진행 중입니다. 잠시 후 시도해주세요.');const status=await courseCodexStatus();if(!status.connected)throw Error('먼저 이 PC의 Codex에서 ChatGPT 계정으로 로그인해주세요. 별도 API 잔액은 자동 사용하지 않습니다.');return send(202,courseAgents.start(session.username,x));}
 if(url.pathname==='/api/course/cancel')return send(200,courseAgents.cancel(session.username,x.id));
 if(url.pathname==='/api/ai/config'){if(anyAIRunning())throw Error('AI 검색을 중지한 뒤 연결 설정을 변경해주세요.');await aiSettings.save(session.username,x,apiClient);routedAI.use('api');return send(200,aiStatus(session.username));}
 if(url.pathname.startsWith('/api/ai/chatgpt/')||url.pathname==='/api/ai/provider'){
 if(anyAIRunning())throw Error('진행 중인 AI 검색을 먼저 중지해주세요.');
 if(url.pathname==='/api/ai/chatgpt/welcome'){const record=chatgpt.current();if(!record)throw Error('연결된 계정 없음');await chatgpt.persist({...record,planNoticeDismissed:true});return send(200,{ok:true});}
 if(url.pathname==='/api/ai/chatgpt/start')return send(200,chatgpt.start(session.username,x));
 if(url.pathname==='/api/ai/chatgpt/select'){chatgpt.select(x.id);routedAI.use('chatgpt');return send(200,aiStatus(session.username));}
 if(url.pathname==='/api/ai/chatgpt/model'){await chatgpt.chooseModel(x.model);return send(200,aiStatus(session.username));}
 if(url.pathname==='/api/ai/chatgpt/disconnect')return send(200,await chatgpt.disconnect());
 if(url.pathname==='/api/ai/provider'){routedAI.use(x.provider);return send(200,aiStatus(session.username));}}
 if(url.pathname==='/api/ai/chat'){if(anyAIRunning())throw Error('다른 AI 작업이 진행 중입니다. 잠시 후 시도해주세요.');if(aiSettings.saving)throw Error('키 설정 저장 후 검색해주세요.');return send(202,aiChat.create(x));}
 if(url.pathname==='/api/ai/cancel')return send(200,aiChat.cancel(x.id));
 if(url.pathname==='/api/comparisons'){if(anyBrowserBusy())throw Error('다른 브라우저 작업이 진행 중입니다. 종료 후 검색해주세요.');return send(202,comparisons.create(validate({...x,mode:'real',interval:10,scenario:'below',autoPrepare:false,currency:'KRW'})));}
 if(url.pathname==='/api/comparisons/cancel')return send(200,comparisons.cancel(x.id));
 if(url.pathname==='/api/notifications/reference'){if(typeof x.enabled!=='boolean')throw Error('알림 기준을 확인해주세요.');const old=notifications.personalSettings?.()||notifications.settings();notifications.save({mail:{...old.mail,inputStageAlerts:x.enabled},sms:old.sms});const result=admin?notifications.status():publicNotifications(notifications);try{Object.assign(result,await syncAllCloud());}catch{result.cloudSynced=false;}return send(200,result);}
 if(url.pathname==='/api/notifications/connection'){const s=await mailConnection.save(x);try{Object.assign(s,await syncAllCloud());}catch{s.cloudSynced=false;}return send(200,s);}
 if(url.pathname==='/api/notifications/email'){const old=notifications.personalSettings?.()||notifications.settings();const to=String(x.to||'').trim();const s=notifications.save({mail:{...old.mail,enabled:!!to,provider:old.mail.provider==='brevo'?'brevo':'formsubmit',to},sms:old.sms});return send(200,await syncMemberChange(session,admin?s:publicNotifications(notifications)));}
 if(url.pathname==='/api/notifications'){return send(200,notifications.save(x));}
 if(url.pathname==='/api/notifications/test'){if(!admin&&x.channel!=='mail')return send(403,{error:'관리자만 문자 발송을 설정할 수 있습니다.'});return send(200,await notifications.test(x.channel));}
 if(url.pathname==='/api/auth/logout'){auth.logout(req,res);return send(200,{ok:true});}
 if(url.pathname==='/api/tasks'){const input=validate(x);if(input.mode==='real'&&[...tasks.values()].filter(t=>t.mode==='real'&&t.state!=='ended').length>=5)throw Error('감시 조건은 최대 5개입니다. 기존 조건을 종료한 뒤 추가하세요.');const t={...input,id:randomUUID(),state:'paused',generation:0,next:null,last:null,latest:null};tasks.set(t.id,t);save(t);return send(201,await syncMemberChange(session,{...t}));}
 if(url.pathname==='/api/edit'){const t=tasks.get(x.id);if(!t)throw new AuthError('조건을 찾을 수 없습니다.',404);if(t.state!=='paused')throw Error('일시정지 상태에서만 수정 가능');const data=validate(x);if(t.mode!==data.mode)throw Error('저장 후 모드는 변경할 수 없습니다');Object.assign(t,data,{generation:t.generation+1,next:null,latest:null,last:null,lastAttempt:null,comparisonId:null,sites:{},reason:'조건 수정됨 · 변경한 조건으로 다시 검색해주세요.'});save(t);return send(200,await syncMemberChange(session,{...t}));}
 if(url.pathname==='/api/action'){const t=tasks.get(x.id);if(!t)throw new AuthError('조건을 찾을 수 없습니다.',404);if(x.action==='start'){if(!['paused','action_required','needs_review','error'].includes(t.state))throw Error('시작 불가');state(t,'monitoring');t.generation++;t.next=new Date().toISOString();t.reason=t.mode==='real'?'홈페이지 서버가 10분마다 5개 출처를 조회합니다':'';save(t);void run(t);}else if(['pause','end'].includes(x.action)){t.generation++;state(t,x.action==='pause'?'paused':'ended');t.next=null;save(t);}else throw Error('동작 오류');return send(200,await syncMemberChange(session,{ok:true}));}
 if(url.pathname==='/api/observations'){
 const t=tasks.get(x.taskId);if(!t||t.mode!=='real'||t.state!=='monitoring')throw Error('실행 중인 실사용 감시 조건만 기록 가능');
 if(x.generation!==t.generation)throw Error('조건이 변경되었거나 중지된 조회 결과입니다');const observation=validateObservation(x);let verdict=null;let quote=null;
 if(x.quote){const q=x.quote;quote=Object.fromEntries(['origin','destination','departure','returnDate','trip','adults','currency','total','basis','taxIncluded','baggageIncluded','flight','fare','stops','duration','baggageText','baggageKg'].map(k=>[k,q[k]]));quote.source=observation.source;quote.observedAt=observation.observedAt;if(x.status==='observed'){if(t.baggage&&(!x.confirmedFields.includes('baggageIncluded')||!x.confirmedFields.includes('baggageKg')))throw Error('필수 수하물 확인 필요');verdict=verifyPayable(t,{displayPrice:quote.total,purchaseVerification:x.purchaseVerification});if(verdict.comparable)quote.total=verdict.confirmedTotal;if(verdict.comparable&&verdict.status==='matched')notify(t,'조건 충족 발견',providers.find(p=>p.id===x.providerId).name+' · 전체 총액 '+quote.total+' '+quote.currency+' · '+quote.flight+' · 예약/좌석 확보 아님');history(t,quote,verdict);}}
 t.sites={...(t.sites||{}),[x.providerId]:{...observation,result:verdict,total:quote?.total??null,currency:quote?.currency??null,flight:quote?.flight??null}};
 t.lastAttempt=observation.observedAt;if(x.status==='observed'&&verdict?.comparable){t.last=observation.observedAt;t.latest=quote.total;}t.next=new Date(Date.now()+10*60000).toISOString();t.reason='사이트별 확인 상태를 확인하세요';save(t);return send(200,{ok:true,result:verdict});}
 if(url.pathname==='/api/browser'){if(busy)throw Error('브라우저 작업 중');if(x.action==='release')await browser.release();else if(x.action==='close')await browser.context?.close();else if(x.action==='real')await browser.real();else await browser.focus();return send(200,{ok:true});}
 if(url.pathname==='/api/ack'){for(const row of db.prepare('SELECT id,body FROM events').all()){const e=JSON.parse(row.body);if(e.id===x.id){e.ack=true;db.prepare('UPDATE events SET body=? WHERE id=?').run(JSON.stringify(e),row.id);}}return send(200,{ok:true});}
 return send(404,{error:'경로 없음'});
 }catch(e){if(url.pathname.startsWith('/api/auth/'))return send(e instanceof AuthError?e.status:400,{error:e instanceof AuthError?e.message:'로그인 요청을 처리할 수 없습니다. 화면을 새로고침해주세요.'});return send(e instanceof AuthError?e.status:400,{error:e instanceof SyntaxError?'요청 형식을 확인해주세요.':e.message?.includes('browser')?'브라우저 작업 실패':e.message||'입력 오류'});}});
setInterval(()=>{if(anyBrowserBusy())return;for(const w of readyWorkspaces()){if(w.username&&auth.account(w.username)?.enabled!==1)continue;for(const t of w.tasks.values())if(t.state==='monitoring'&&t.next&&Date.parse(t.next)<=Date.now()){void w.run(t);return;}}},1000).unref();
server.listen(port,network.bindHost,()=>console.log('LOCAL_SERVER '+base));
