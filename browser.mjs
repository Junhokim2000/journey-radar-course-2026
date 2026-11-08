import {collectTripReceipt} from './trip-receipt.mjs';
import {filterOffersByTime} from './time-windows.mjs';
import {readPublicFares} from './public-fares.mjs';
import {chromium} from 'playwright';
import {publicSearchURL,classifyPublicPage,parseFlightBlocks} from './comparison.mjs';
import fs from 'node:fs/promises';
import {parseTripFareCards} from './merchant-fares.mjs';
import {sellerOffers} from './seller-offers.mjs';
import path from 'node:path';
export class Browser {
 constructor(root,base,options={}){this.options=options;this.root=root;this.base=base;this.context=null;this.page=null;this.handoff=false;}
 async open(){if(!this.context){const exe=this.options.executablePath||process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined);const headless=this.options.headless??(process.env.HEADLESS==='1'||process.platform!=='win32');this.context=await chromium.launchPersistentContext(this.options.profileDir||path.join(this.root,'runtime/app-browser-profile'),{...(exe?{executablePath:exe}:{}),headless,locale:this.options.locale||'ko-KR',timezoneId:'Asia/Seoul'});this.context.on('close',()=>{this.context=null;this.page=null;this.handoff=false;});} return this.context;}
 async compareSite(provider,task,alive){
 if(!alive())return null;if(this.handoff)throw Error('HANDOFF');await this.open();if(!this.comparePages)this.comparePages=new Map();let p=this.comparePages.get(provider.id);if(!p||p.isClosed()){p=await this.context.newPage();this.comparePages.set(provider.id,p);}this.page=p;const source=publicSearchURL(provider,task);
 try{await p.bringToFront();await p.goto(source,{waitUntil:'domcontentloaded',timeout:35000});if(!alive())return null;if(!provider.hosts.includes(new URL(p.url()).hostname))return {status:'needs_review',reason:'공식 사이트 이외의 페이지로 이동했습니다.',source,offers:[]};
 const scanTask=provider.id==='trip'?{...task,returnDepartureTimeFrom:null,returnDepartureTimeTo:null,returnArrivalTimeFrom:null,returnArrivalTimeTo:null}:task;const result=await readPublicFares(p,provider,scanTask,alive);
 if(provider.id==='trip'&&result.offers.length&&this.options.receiptDetails!==false){result.offers[0].bookingReview=await collectTripReceipt(this.context,task,result.offers[0],source,alive,{onFailure:async(page,review,error)=>this.options.onReceiptDiagnostic?.(page,provider,review,error)});}
 if(provider.id==='trip'){const filtered=filterOffersByTime(task,result.offers);result.offers=filtered.offers;result.timeFilter=filtered.timeFilter;if(!result.offers.length&&filtered.timeFilter.applied&&filtered.timeFilter.total){result.status='filtered';result.reason='출국·귀국 시간 조건을 모두 확인한 항공편이 없습니다.';}}
 if(provider.id==='kayak'&&result.offers.length&&this.options.sellerDetails!==false){await this.kayakSellers(p,result.offers,task,alive);}
 if(!result.offers.length)try{await this.options.onEmptyResult?.(p,provider,result);}catch{}return result;
 }catch(error){try{await this.options.onEmptyResult?.(p,provider,{status:'failed'});}catch{}this.options.onDiagnostic?.({provider:provider.id,error:error.message.slice(0,500)});return {status:'failed',reason:'사이트 연결 또는 항공편 카드 조회를 완료하지 못했습니다.',source,offers:[],diagnostics:{navigationError:error.name==='TimeoutError'?'timeout':'navigation_failed'}};}
 }
 async kayakSellers(p,offers,task,alive){
  const consent=p.getByRole('button',{name:'동의합니다',exact:true});if(await consent.isVisible().catch(()=>false))await consent.click({timeout:3000}).catch(()=>{});
  const rows=p.locator('[class~=nrc6-inner]');const texts=await rows.allInnerTexts();for(const offer of offers.slice(0,3)){if(!alive())return;const index=texts.findIndex(t=>t.trim().slice(0,800)===offer.summary);if(index<0)continue;
   try{await rows.nth(index).getByText('선택',{exact:true}).click({timeout:5000});const dialog=p.getByRole('dialog').filter({hasText:'2단계: 예약 사이트 선택'});await dialog.locator('[class~=RBZl-row-wrapper]:visible').first().waitFor({timeout:12000});if(!alive())return;
   const detail=await dialog.innerText();const data=await dialog.locator('[class~=RBZl-row-wrapper]:visible').evaluateAll(xs=>xs.filter(x=>x.getClientRects().length).map(x=>({text:x.innerText,href:x.querySelector('a[href]')?.href})));
   offer.sellerOffers=sellerOffers(data,{source:p.url(),adults:task.adults,paymentNote:detail.split('\n').find(l=>l.includes('선택한 결제 수단'))});offer.sellerListCheckedAt=new Date().toISOString();
   }catch(error){try{await this.options.onEmptyResult?.(p,{id:'kayak'},{status:'failed'});}catch{}this.options.onDiagnostic?.({provider:'kayak',error:error.message.slice(0,1600)});offer.sellerListReason='판매처 가격 패널을 확인하지 못했습니다.';}finally{const panel=p.getByRole('dialog').filter({hasText:'2단계: 예약 사이트 선택'});const back=panel.locator('[class~=zQS2-btn-container]:visible').first();if(await back.isVisible().catch(()=>false))await back.click({timeout:3000}).catch(()=>{});else await p.keyboard.press('Escape').catch(()=>{});await panel.waitFor({state:'hidden',timeout:3000}).catch(()=>{});}
   if(await p.locator('[class~=zQS2-btn-container]:visible').count())break;
  }
 }
 async tripFareReview(candidate,task,alive){
 if(!alive())return null;const p=await this.context.newPage();try{await p.goto(candidate.bookingLink,{waitUntil:'domcontentloaded',timeout:25000});await p.waitForURL(u=>u.hostname==='kr.trip.com',{timeout:25000}).catch(()=>{});if(!alive())return null;let text=await p.locator('body').innerText();if(classifyPublicPage(text))return {status:'blocked',reason:'판매처 추가 인증 또는 접근 제한',fareOptions:[]};if(new URL(p.url()).hostname!=='kr.trip.com')return {status:'needs_review',reason:'트립닷컴 판매처 이동을 확인하지 못했습니다.',fareOptions:[]};
 await p.locator('[class~=J_brandedFarePolicy]:visible').first().waitFor({timeout:20000});if(!alive())return null;text=await p.locator('body').innerText();if(classifyPublicPage(text))return {status:'blocked',reason:'판매처 추가 인증 또는 접근 제한',fareOptions:[]};const cards=await p.locator('[class~=J_brandedFarePolicy]:visible').allInnerTexts();return parseTripFareCards(cards,task,p.url());
 }catch{return {status:'needs_review',reason:'판매처 운임 옵션 확인 시간 초과',fareOptions:[]};}finally{await p.close().catch(()=>{});}
 }
 async inspectSite(provider,alive){
  if(!alive())return null;if(this.handoff)throw Error('HANDOFF');await this.open();if(!this.monitorPages)this.monitorPages=new Map();
  let p=this.monitorPages.get(provider.id);if(!p||p.isClosed()){p=await this.context.newPage();this.monitorPages.set(provider.id,p);}this.page=p;
  try{await p.goto(provider.url,{waitUntil:'domcontentloaded',timeout:15000});if(!alive())return null;const url=new URL(p.url());if(!provider.hosts.includes(url.hostname))return {status:'blocked',reason:'공식 사이트 이외로 이동하여 중단',source:provider.url};
  const text=(await p.locator('body').innerText({timeout:5000})).slice(0,25000);if(/captcha|verify you are human|unusual traffic|access denied|보안 확인|사람인지 확인/i.test(text))return {status:'blocked',reason:'접근 차단 또는 추가 인증 · 사용자 조치 필요',source:provider.url};
  return {status:'needs_review',reason:'공식 사이트 접속 확인 · 여행 조건 검색과 가격 추출 연결은 아직 미완성',source:provider.url};
  }catch{return {status:'failed',reason:'사이트 접속 또는 페이지 확인 시간 초과',source:provider.url};}
 }
 async focus(){await this.open();if(this.page&&!this.page.isClosed()) await this.page.bringToFront();}
 async real(){await this.open();if(this.handoff)throw Error('HANDOFF');this.page=await this.context.newPage();await this.page.goto('https://kr.trip.com/flights/',{waitUntil:'domcontentloaded',timeout:30000});return {status:'action_required',reason:'실제 검색 결과 추출 및 예약 준비 미검증. 열린 공식 페이지에서 직접 확인하세요.'};}
 async demo(task,alive,onCandidate){
  if(this.handoff)throw Error('HANDOFF');await this.open();await this.options.authorizeContext?.(this.context);this.page=await this.context.newPage();const p=this.page;
  const params=new URLSearchParams({data:JSON.stringify(task)});await p.goto(this.base+'/demo/search?'+params);
  if(!alive())return null;
  await p.getByRole('button',{name:'검색 실행'}).click();
  const quote=JSON.parse(await p.locator('#quote').textContent());if(!alive())return null;
  await onCandidate(quote);
  return {quote,page:p};
 }
 async prepare(task,alive){const p=this.page;if(!alive())return null;
  if(task.scenario==='session') return {status:'action_required',reason:'데모 세션 만료: 사용자 확인 필요'};
  await p.getByRole('button',{name:'가상 운임 선택'}).click();if(!alive())return null;
  await p.getByLabel('가상 탑승객 이름').fill('DEMO TRAVELER');if(!alive())return null;
  await p.getByRole('button',{name:'가상 입력 완료 · 주문 생성 없음'}).click();
  const final=JSON.parse(await p.locator('#final').textContent());if(!alive())return null;
  return final;
 }
 async hold(){this.handoff=true;await this.focus();}
 async release(){this.handoff=false;}
 async credentialStatus(){try{const x=JSON.parse(await fs.readFile(path.join(this.root,'private/credentials.local.json'),'utf8'));return {exists:true,valid:x.site_origin==='https://kr.trip.com'&&x.login_method==='password'&&typeof x.username==='string'&&typeof x.password==='string',message:'내용 미표시 · 실제 자동 로그인은 미검증으로 비활성화'};}catch(e){return {exists:e.code!=='ENOENT',valid:false,message:'파일 없음 또는 형식 오류 · 실제 값은 로컬 편집기로만 입력'};}}
}
