import {findReferenceCandidate,referenceMessage,referenceIdentity} from '../reference-alerts.mjs';
import {captureDiagnostic,sealDiagnostic} from './diagnostics.mjs';
import {createHmac,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Browser} from '../browser.mjs';
import {providers} from '../providers.mjs';
import {airportBatch} from '../comparison.mjs';
import {rankPayable} from '../pricing.mjs';
import {submitConfiguredEmail,koreanMail} from '../notifications.mjs';
import {cloudConfig} from './config.mjs';
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date());
export function safeDiagnostics(x){if(!x||typeof x!=='object')return null;const out={};if(typeof x.language==='string'&&/^[a-zA-Z-]{2,16}$/.test(x.language))out.language=x.language;for(const k of ['candidateNodes','pricedNodes'])if(Number.isInteger(x[k])&&x[k]>=0&&x[k]<1000000)out[k]=x[k];for(const k of ['bodyHasWon','bodyHasTimes'])if(typeof x[k]==='boolean')out[k]=x[k];if(['timeout','navigation_failed'].includes(x.navigationError))out.navigationError=x.navigationError;return out;}
export const notificationKey=(config,task,offer)=>createHmac('sha256',config.notificationSalt).update(JSON.stringify({task,source:offer.pricing.source,total:offer.pricing.confirmedTotal,flight:offer.flight||'',date:today()})).digest('hex');
export function emptyState(){return {version:1,mailProvider:'formsubmit',notified:{},daily:{},activationRequestedAt:null};}
export function cleanState(value){const state=emptyState();if(value?.version!==1)return state;if(['formsubmit','brevo'].includes(value.mailProvider))state.mailProvider=value.mailProvider;for(const[k,v]of Object.entries(value.notified||{}))if(/^[a-f0-9]{64}$/.test(k)&&Number.isFinite(v)&&Date.now()-v<7*86400000)state.notified[k]=v;for(const[k,v]of Object.entries(value.daily||{}))if(/^\d{4}-\d{2}-\d{2}$/.test(k)&&Number.isInteger(v)&&v>=0&&k===today())state.daily[k]=v;if(Number.isFinite(value.activationRequestedAt))state.activationRequestedAt=value.activationRequestedAt;return state;}
export async function inspectCloudTask(task,{root,deadline,profileDir,diagnostic=null,browserFactory=(...args)=>new Browser(...args)}){
 const browser=browserFactory(root,'http://127.0.0.1:8765',{headless:process.env.HEADLESS!=='0',profileDir,...(diagnostic?{onEmptyResult:(page,p,r)=>captureDiagnostic(page,p.id,diagnostic,{stage:'search',status:r.status}),onReceiptDiagnostic:(page,p,r,error)=>captureDiagnostic(page,p.id,diagnostic,{stage:'receipt',status:r.status,reason:r.reason,error})}:{})});const alive=()=>Date.now()<deadline;
 try{await browser.open();const timer=setTimeout(()=>browser.context?.close().catch(()=>{}),Math.max(1,deadline-Date.now()));
 try{const sites=[];for(const provider of providers){if(!alive()){sites.push({providerId:provider.id,status:'failed',offers:[]});continue;}const offers=[];let status='needs_review',diagnostics=null;for(const destination of airportBatch(task)){if(!alive())break;const result=await browser.compareSite(provider,{...task,destination},alive);if(result?.offers?.length)offers.push(...result.offers);status=result?.status||'failed';diagnostics=result?.diagnostics||null;if(status==='blocked')break;}sites.push({providerId:provider.id,status,offers,diagnostics});}return sites;}finally{clearTimeout(timer);}
 }finally{await browser.context?.close().catch(()=>{});}
}
export async function runCloud(configValue,{state:oldState,inspect=inspectCloudTask,send=submitConfiguredEmail,root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),budgetMs=450000,testEmail=false,diagnosticDir=null}={}){
 const config=cloudConfig(configValue),state=cleanState(oldState),deadline=Date.now()+budgetMs;
 if(state.mailProvider!==config.mailService.provider){state.daily={};state.activationRequestedAt=null;state.mailProvider=config.mailService.provider;}
 const summary={executionType:testEmail?'email-test':'monitor',mailProvider:config.mailService.provider,alertPolicy:config.alertPolicy,conditions:config.tasks.length,checked:0,expired:0,failed:0,blockedSources:0,failedSources:0,sources:[],unverifiedOffers:0,receiptsObserved:0,referenceMatches:0,verifiedMatches:0,emailStatus:'not_needed',note:config.alertPolicy==='input-stage-reference'?'사용자가 선택한 입력 단계 참고 가격 이메일 사용 중 · 최종 결제 총액 확인과 구분합니다.':'최종 총액이 검증되지 않은 표시가는 목표가 알림에 사용하지 않습니다.'};const hits=[];
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'flight-cloud-'));
 try{for(let i=0;!testEmail&&i<config.tasks.length;i+=2){await Promise.all(config.tasks.slice(i,i+2).map(async task=>{
 if(task.departure<today()){summary.expired++;return;}if(Date.now()>=deadline){summary.failed++;return;}
 try{const sites=await inspect(task,{root,deadline,profileDir:path.join(tmp,randomUUID()),...(diagnosticDir?{diagnostic:{dir:diagnosticDir,key:config.notificationSalt}}:{})});summary.checked++;for(const site of sites){summary.sources.push({providerId:site.providerId,status:site.status,offers:(site.offers||[]).length,diagnostics:safeDiagnostics(site.diagnostics)});if(site.status==='blocked')summary.blockedSources++;else if(site.status==='failed')summary.failedSources++;}const ranked=rankPayable(task,sites);summary.unverifiedOffers+=ranked.unverified.length;summary.receiptsObserved+=sites.flatMap(s=>s.offers||[]).filter(o=>o.bookingReview?.status==='receipt_observed').length;const best=ranked.ranked.find(o=>o.pricing.status==='matched');if(best){summary.verifiedMatches++;const key=notificationKey(config,task,best);if(!state.notified[key])hits.push({task,offer:best,key});}else if(config.alertPolicy==='input-stage-reference'){const match=findReferenceCandidate(task,sites);if(match){summary.referenceMatches++;const key=createHmac('sha256',config.notificationSalt).update(referenceIdentity(task,match)).digest('hex');if(!state.notified[key])hits.push({task,offer:match.offer,key,reference:match,sites});}}}catch{summary.failed++;}
 }));}
 if(!config.emailEnabled){summary.emailStatus='disabled';return {summary,state};}const day=today();if((state.daily[day]||0)>=config.maxEmailsPerDay){summary.emailStatus='daily_limit';return {summary,state};}
 if(config.mailService.provider==='formsubmit'&&state.activationRequestedAt&&Date.now()-state.activationRequestedAt<86400000&&!testEmail){summary.emailStatus='activation_wait';return {summary,state};}
 if(!hits.length&&!testEmail)return {summary,state};
 const event=testEmail?{stage:'연결 테스트',message:'클라우드 감시의 이메일 연결 테스트입니다.'}:{stage:hits.some(h=>h.reference)?'참고 가격 확인':'조건 충족 발견',message:hits.map(({task,offer,reference,sites})=>reference?referenceMessage(task,reference,sites):task.origin+' → '+offer.purchaseVerification.itinerary.destination+' / '+task.departure+(task.trip==='roundtrip'?' ~ '+task.returnDate:' 편도')+' / 성인 '+task.adults+'명\n필수 비용 포함 전체 총액: '+Number(offer.pricing.confirmedTotal).toLocaleString('ko-KR')+'원\n판매처: '+offer.pricing.seller+'\n확인 링크: '+offer.pricing.source).join('\n\n')};
 const mail=koreanMail(event);let delivery;try{delivery=await send(config.email,{...mail.fields,_subject:mail.subject,_template:'table',_captcha:'false'},{base:config.notificationOrigin,service:config.mailService,...(diagnosticDir?{onDiagnostic:async data=>{await fs.mkdir(diagnosticDir,{recursive:true});await fs.writeFile(path.join(diagnosticDir,'mail-'+randomUUID()+'.enc'),sealDiagnostic(data,config.notificationSalt),{mode:0o600});}}:{})});}catch{delivery={status:'unknown'};}
 summary.emailStatus=delivery.status;if(Number.isInteger(delivery.httpStatus))summary.emailHTTPStatus=delivery.httpStatus;state.daily[day]=(state.daily[day]||0)+1;
 if(delivery.status==='accepted'){for(const hit of hits)state.notified[hit.key]=Date.now();state.activationRequestedAt=null;}
 else if(delivery.status==='activation_required')state.activationRequestedAt=Date.now();
 else if(delivery.status==='unknown'){for(const hit of hits)state.notified[hit.key]=Date.now();}
 return {summary,state};
 }finally{const real=await fs.realpath(tmp),tempRoot=await fs.realpath(os.tmpdir());if(!real.startsWith(tempRoot+path.sep)||!path.basename(real).startsWith('flight-cloud-'))throw Error('임시 폴더 경계 확인 실패');await fs.rm(real,{recursive:true,force:true});}
}
async function main(){
 let config;try{config=cloudConfig(JSON.parse(process.env.FLIGHT_MONITOR_CONFIG||''));}catch{console.error('클라우드 비공개 설정이 없거나 올바르지 않습니다. FLIGHT_MONITOR_CONFIG를 확인해주세요.');process.exitCode=1;return;}
 const file=path.resolve(process.env.MONITOR_STATE_FILE||'runtime/cloud-state.json');let state;try{state=JSON.parse(await fs.readFile(file,'utf8'));}catch{}
 const {summary,state:next}=await runCloud(config,{state,testEmail:process.env.MONITOR_TEST_EMAIL==='true',diagnosticDir:process.env.MONITOR_DEBUG_DIAGNOSTICS==='true'?path.resolve('runtime/cloud-diagnostics'):null});
 await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(next),{mode:0o600});
 // Never print destinations, fares, email addresses, search URLs, or the private config.
 console.log(JSON.stringify(summary));if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,'## 항공권 클라우드 감시\n\n확인 조건: '+summary.checked+' / '+summary.conditions+'\n\n차단된 사이트: '+summary.blockedSources+' / 조회 실패 사이트: '+summary.failedSources+'\n\n검증된 목표가 발견: '+summary.verifiedMatches+'\n\n최종 총액 미확인 표시가: '+summary.unverifiedOffers+'건\n\n이메일 요청 상태: '+summary.emailStatus+'\n\n'+summary.note+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(()=>{console.error('클라우드 감시 실행을 완료하지 못했습니다. 개인정보를 제외한 설정과 사이트 상태를 확인해주세요.');process.exitCode=1;});
