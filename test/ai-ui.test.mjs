import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
import {startTestServer,bootstrapTestOwner,testOwner} from './helpers.mjs';

test('AI API 인증·키 비노출·재시작 후 로그인 복원',async()=>{
 const fixture=await startTestServer(8787,'ai-api-');try{
 const unauth=await fetch(fixture.base+'/api/ai/config');assert.equal(unauth.status,401);
 const access=await bootstrapTestOwner(fixture.base);const headers={'Content-Type':'application/json','X-Local-Token':access.token};const req=async(u,data)=>{const r=await access.fetch(fixture.base+u,{method:data?'POST':'GET',headers,body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json()};};
 assert.equal((await access.fetch(fixture.base+'/api/ai/config')).status,403);
 assert.equal((await req('/api/ai/chat',{message:'TEST ONLY'})).status,400);
 const key='sk-TEST_ONLY_NEVER_SEND_TO_OPENAI_123456';const connected=await req('/api/ai/config',{apiKey:key,model:'gpt-5.4-mini',costConsent:true});assert.equal(connected.status,200);assert.equal(connected.data.configured,true);assert.ok(!JSON.stringify(connected).includes(key));
 const status=await req('/api/status');assert.equal(status.data.tasks.length,0);assert.equal(status.data.providers.length,5);
 await fixture.restart();
 async function loginAgain(){const first=await fetch(fixture.base),html=await first.text();const boot=first.headers.getSetCookie().find(s=>s.startsWith('flight_boot=')).split(';')[0],csrf=html.match(/csrf='([^']+)'/)[1];const login=await fetch(fixture.base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Token':csrf,Cookie:boot},body:JSON.stringify(testOwner)});assert.equal(login.status,200);const cookie=login.headers.getSetCookie().find(s=>s.startsWith('flight_session=')).split(';')[0];const home=await(await fetch(fixture.base,{headers:{Cookie:cookie}})).text();const token=home.match(/const token='([^']+)'/)[1];return {'Content-Type':'application/json','X-Local-Token':token,Cookie:cookie};}
 const restoredHeaders=await loginAgain();const restored=await(await fetch(fixture.base+'/api/ai/config',{headers:restoredHeaders})).json();assert.equal(restored.configured,true);assert.equal(restored.savedForAccount,true);assert.equal(restored.keyStorage,'windows-dpapi');assert.ok(!JSON.stringify(restored).includes(key));
 const cleared=await fetch(fixture.base+'/api/ai/config',{method:'POST',headers:restoredHeaders,body:JSON.stringify({clearKey:true})});assert.equal(cleared.status,200);await fixture.restart();const finalHeaders=await loginAgain();const finalState=await(await fetch(fixture.base+'/api/ai/config',{headers:finalHeaders})).json();assert.equal(finalState.configured,false);assert.equal(finalState.savedForAccount,false);
 }finally{await fixture.close();}
});

test('AI 채팅 PC·모바일: 연결 설정·질문·후속 검색·출처·HTML 안전 렌더링',async()=>{
 const fixture=await startTestServer(8788,'ai-ui-');let browser;try{
 const access=await bootstrapTestOwner(fixture.base);browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});await access.install(context);const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const conversationId='12345678-1234-1234-1234-123456789012';let current=null,count=0,followup;
 await page.route('**/api/ai/chat*',async route=>{if(route.request().method()==='POST'){
  const body=route.request().postDataJSON();count++;if(count===2)followup=body;
  current=count===1?{id:'TEST_ONLY_1',conversationId,state:'needs_details',userMessage:body.message,message:'출발 날짜와 귀국 날짜는 언제인가요?',web:[]}:{id:'TEST_ONLY_2',conversationId,state:'completed',userMessage:body.message,message:'TEST ONLY · 화면 검증용 가상 데이터입니다. 실제 검색·GPT 응답이 아닙니다.',task:{origin:'ICN',destination:'KIX',departure:'2026-12-08',returnDate:'2026-12-11',trip:'roundtrip',adults:1,cabin:'economy',baggageKg:null,maxStops:null,extraConstraints:''},web:[{name:'항공사 공식 사이트',status:'completed',text:'TEST ONLY <img src=x onerror=alert(1)>',sources:[{url:'https://www.koreanair.com/',title:'TEST ONLY · 출처 링크'}]}],comparison:{state:'completed',sites:[{name:'카약',status:'partial',reason:'TEST ONLY',source:'https://www.kayak.co.kr/',offers:[]}],pricing:{listedSellers:[{sellerName:'TEST ONLY 가상 판매처',displayPrice:'250000',origin:'ICN',airport:'KIX',source:'https://www.kayak.co.kr/',bookingLink:'https://www.kayak.co.kr/',baggageEvidence:'TEST ONLY 수하물 미확인'}]}}};
  return route.fulfill({status:202,contentType:'application/json',body:JSON.stringify(current)});
 }return route.fulfill({contentType:'application/json',body:JSON.stringify(current)});});
 await page.goto(fixture.base);await page.getByRole('button',{name:'✦ AI 채팅 검색',exact:true}).click();await page.getByText('ChatGPT 연결 필요',{exact:true}).waitFor();await page.locator('#api-advanced summary').click();assert.equal(await page.locator('#ai-send').isDisabled(),true);
 await page.getByLabel('OpenAI API 키',{exact:true}).fill('sk-TEST_ONLY_NEVER_SEND_TO_OPENAI_123456');await page.locator('#ai-consent').check();await page.getByRole('button',{name:'연결 설정 저장',exact:true}).click();await page.getByText('계정에 키 저장됨',{exact:true}).waitFor();assert.equal(await page.locator('#ai-key').inputValue(),'');
 await page.getByRole('button',{name:'예시 여정 입력',exact:true}).click();assert.ok((await page.locator('#ai-prompt').inputValue()).includes('ICN'));await page.locator('#ai-prompt').fill('오사카 간사이 왕복 성인 1명');await page.getByRole('button',{name:'✦ 검색 보내기',exact:true}).click();await page.getByText('출발 날짜와 귀국 날짜는 언제인가요?',{exact:true}).waitFor();
 await page.locator('#ai-prompt').fill('12월 8일부터 11일까지');await page.getByRole('button',{name:'✦ 검색 보내기',exact:true}).click();await page.getByText('TEST ONLY 가상 판매처',{exact:true}).waitFor();assert.equal(followup.conversationId,conversationId);assert.equal(await page.locator('.ai-answer img').count(),0);assert.ok((await page.locator('#ai-messages').innerText()).includes('250,000원 / 1인'));
 await page.locator('.ai-answer details').last().locator('summary').click();await page.getByRole('link',{name:'TEST ONLY · 출처 링크',exact:true}).waitFor();assert.equal(errors.length,0);await page.screenshot({path:'docs/ai-chat-desktop-test.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await page.screenshot({path:'docs/ai-chat-mobile-test.png',fullPage:true});
 // Existing condition entry remains functional and chat does not create monitors.
 await page.getByRole('button',{name:'조건 추가',exact:true}).first().click();await page.getByLabel('도착 지역 / 공항',{exact:true}).selectOption('KIX');await page.getByLabel('출발 날짜',{exact:true}).fill('2026-12-08');await page.getByLabel('귀국 날짜',{exact:true}).fill('2026-12-11');await page.getByLabel('전체 인원 목표 금액 (원)',{exact:true}).fill('300000');await page.getByRole('button',{name:'조건 저장',exact:true}).click();await page.getByRole('heading',{name:'인천 → 오사카 간사이',exact:true}).waitFor();assert.equal(errors.length,0);
 await fs.writeFile('docs/ai-ui-validation.json',JSON.stringify({at:new Date().toISOString(),mode:'mock-api-and-mock-search-data',actualGPTCall:false,actualLiveFareSearch:false,desktop:true,mobileWidth:390,mobileOverflow:false,pageErrors:errors,followupConversation:true,conditionsStillWork:true},null,2));
 }finally{await browser?.close();await fixture.close();}
});
