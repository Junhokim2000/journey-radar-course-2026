import nodemailer from 'nodemailer';import {SolapiMessageService} from 'solapi';import {randomUUID} from 'node:crypto';
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('TIMEOUT')),30000);})]);}finally{clearTimeout(timer);}}
const email=s=>typeof s==='string'&&s.length<=254&&/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(s);
const phone=s=>typeof s==='string'&&/^0\d{9,10}$/.test(s);
export function koreanMail(event){
 const isTest=event.stage==='연결 테스트';
 const subject=isTest?'[여정 레이더] 이메일 알림 연결 확인':'[여정 레이더] '+event.stage;
 const content=isTest?'안녕하세요. 여정 레이더의 이메일 알림 연결 확인 메일입니다.\n\n이 메일이 도착했다면 이메일 발송과 수신 연결이 정상적으로 작동한 것입니다.\n이 메일은 테스트용이며, 목표 금액의 항공권을 발견했다는 알림은 아닙니다.':String(event.message||'');
 const at=new Date().toLocaleString('ko-KR',{timeZone:'Asia/Seoul'});
 const notice=isTest?'실제 항공권 발견 알림은 저장한 목표 조건과 검증된 총액이 일치할 때 발송됩니다.':'항공권 가격과 좌석은 변동될 수 있습니다. 예약하거나 좌석을 확보한 상태가 아니므로 판매처에서 최종 조건을 확인해주세요.';
 return {subject,text:content+'\n\n확인 시각: '+at+' (한국 시간)\n'+notice,fields:{'서비스':'여정 레이더','알림 종류':isTest?'이메일 연결 테스트':event.stage,'알림 내용':content,'확인 시각':at+' (한국 시간)','안내':notice}};
}
export function classifySimpleEmail(data,{ok=true,status=200}={}){
 const message=String(data?.message||'');
 if(ok&&(data?.success===true||data?.success==='true'))return {status:'accepted',note:'FormSubmit이 메일 요청을 접수했습니다. 실제 도착 여부는 수신함에서 확인해주세요.'};
 if(ok&&/needs activation|activation required|activate form/i.test(message))return {status:'activation_required',note:'메일 서비스가 인증 메일을 보냈다고 응답했습니다. 수신함이나 스팸함에서 FormSubmit을 검색하고 Activate Form 링크를 눌러주세요. 인증이 끝나면 테스트 메일을 다시 요청해주세요.'};
 if(/open this page through a web server|HTML files/i.test(message))return {status:'configuration_error',note:'메일 전달 서비스가 홈페이지 주소를 확인하지 못해 요청을 거절했습니다. 홈페이지를 새로고침하고 다시 요청해주세요.'};
 return {status:'rejected',note:'메일 전달 서비스가 요청을 거절했습니다'+(!ok?' (HTTP '+Number(status)+')':'')+'. 잠시 후 다시 확인해주세요. 메일이 접수된 상태는 아닙니다.'};
}
export async function submitSimpleEmail(to,payload,{base='http://127.0.0.1:8765',fetchImpl=fetch}={}){
 const origin=new URL(base).origin;
 const response=await fetchImpl('https://formsubmit.co/ajax/'+encodeURIComponent(to),{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json',Referer:origin+'/',Origin:origin},body:JSON.stringify({...payload,_url:origin+'/'}),signal:AbortSignal.timeout(25000)});
 let data;try{data=await response.json();}catch{return {status:'rejected',note:'메일 전달 서비스가 정상 응답을 반환하지 않았습니다. 잠시 후 다시 확인해주세요.'};}
 return classifySimpleEmail(data,{ok:response.ok,status:response.status});
}
export class Notifications{
 constructor(db,adapters={}){this.db=db;this.adapters=adapters;this.base=adapters.base||'http://127.0.0.1:'+(process.env.PORT||8765);this.secrets={mailPassword:process.env.FLIGHT_SMTP_PASSWORD||'',smsKey:process.env.FLIGHT_SOLAPI_KEY||'',smsSecret:process.env.FLIGHT_SOLAPI_SECRET||''};this.chain=Promise.resolve();db.exec('CREATE TABLE IF NOT EXISTS notification_settings(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT);CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,event_id TEXT,channel TEXT,status TEXT,created_at TEXT,note TEXT,UNIQUE(event_id,channel))');db.prepare("UPDATE deliveries SET status='unknown',note='재시작 전 요청 결과 불명확 · 중복 방지를 위해 자동 재전송하지 않음' WHERE status='sending'").run();}
 settings(){return JSON.parse(this.db.prepare('SELECT body FROM notification_settings WHERE id=1').get()?.body||'null')||{mail:{enabled:false,provider:'formsubmit',user:'',to:''},sms:{enabled:false,from:'',to:'',costConsent:false}};}
 status(){const s=this.settings();return {...s,mail:{...s.mail,passwordSet:!!this.secrets.mailPassword,ready:!!(s.mail.enabled&&email(s.mail.to)&&(s.mail.provider==='formsubmit'||(email(s.mail.user)&&this.secrets.mailPassword))),activationRequired:s.mail.provider==='formsubmit',service:s.mail.provider==='formsubmit'?'FormSubmit':s.mail.provider},sms:{...s.sms,keySet:!!this.secrets.smsKey,secretSet:!!this.secrets.smsSecret,ready:!!(s.sms.enabled&&s.sms.costConsent&&phone(s.sms.from)&&phone(s.sms.to)&&this.secrets.smsKey&&this.secrets.smsSecret)},deliveries:this.db.prepare('SELECT channel,status,created_at,note FROM deliveries ORDER BY rowid DESC LIMIT 30').all()};}
 save(x){const m=x.mail||{},s=x.sms||{};const next={mail:{enabled:m.enabled===true,provider:m.provider||'gmail',user:String(m.user||'').trim(),to:String(m.to||'').trim()},sms:{enabled:s.enabled===true,from:String(s.from||'').replace(/[- ]/g,''),to:String(s.to||'').replace(/[- ]/g,''),costConsent:s.costConsent===true}};
 if(!['gmail','naver','formsubmit'].includes(next.mail.provider))throw Error('Gmail 또는 네이버 메일을 선택해주세요.');if((next.mail.user&&!email(next.mail.user))||(next.mail.to&&!email(next.mail.to)))throw Error('메일 주소 형식을 확인해주세요.');if((next.sms.from&&!phone(next.sms.from))||(next.sms.to&&!phone(next.sms.to)))throw Error('국내 전화번호 형식을 확인해주세요.');
 if(next.mail.enabled&&((next.mail.provider!=='formsubmit'&&!email(next.mail.user))||!email(next.mail.to)))throw Error('보내는 메일과 받는 메일을 입력해주세요.');if(next.sms.enabled&&(!next.sms.costConsent||!phone(next.sms.from)||!phone(next.sms.to)))throw Error('문자 번호와 유료 발송 동의를 확인해주세요.');
 for(const[k,v]of Object.entries(x.secrets||{})){if(!Object.hasOwn(this.secrets,k))continue;if(typeof v!=='string'||v.length>500||/[\r\n]/.test(v))throw Error('연결 정보 형식을 확인해주세요.');if(v)this.secrets[k]=v;}
 if(x.clearSecrets===true)this.secrets={mailPassword:'',smsKey:'',smsSecret:''};this.db.prepare('INSERT OR REPLACE INTO notification_settings VALUES (1,?)').run(JSON.stringify(next));return this.status();}
 async send(channel,event){const s=this.status(),c=s[channel];if(!c?.ready)return {status:'not_ready',note:'연결 정보를 저장하고 해당 알림을 켜주세요.'};if(this.db.prepare('SELECT id FROM deliveries WHERE event_id=? AND channel=?').get(event.id,channel))return {status:'duplicate',note:'이미 처리된 알림'};
 const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Seoul'});const dayRows=this.db.prepare('SELECT created_at FROM deliveries WHERE channel=?').all(channel).filter(r=>new Date(r.created_at).toLocaleDateString('en-CA',{timeZone:'Asia/Seoul'})===today);if(dayRows.length>=(channel==='sms'?5:50))return {status:'limited',note:'하루 한도 도달 (이메일 50건 / 문자 5건)'};
 const id=randomUUID(),at=new Date().toISOString();this.db.prepare('INSERT INTO deliveries VALUES (?,?,?,?,?,?)').run(id,event.id,channel,'sending',at,'발송 요청 중');let status,note,mailOutcome;
 try{if(channel==='mail'&&c.provider==='formsubmit'){const mail=koreanMail(event);const payload={...mail.fields,_subject:mail.subject,_template:'table',_captcha:'false'};mailOutcome=this.adapters.formsubmit?classifySimpleEmail(await this.adapters.formsubmit(c.to,payload)):await submitSimpleEmail(c.to,payload,{base:this.base});}
 else if(channel==='mail'){const opts={host:c.provider==='gmail'?'smtp.gmail.com':'smtp.naver.com',port:465,secure:true,auth:{user:c.user,pass:this.secrets.mailPassword},logger:false,debug:false,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:20000,disableFileAccess:true,disableUrlAccess:true};const mail=koreanMail(event);const message={from:c.user,to:c.to,subject:mail.subject,text:mail.text};const result=this.adapters.mail?await this.adapters.mail(opts,message):await bounded(nodemailer.createTransport(opts).sendMail(message));if(!result.accepted?.length)throw Error('NOT_ACCEPTED');}
 else{const payload={from:c.from,to:c.to,text:'[여정 레이더] '+event.stage+'\n'+event.message,type:'LMS'};const result=this.adapters.sms?await this.adapters.sms(payload):await bounded(new SolapiMessageService(this.secrets.smsKey,this.secrets.smsSecret).send(payload));if(!(result.groupInfo?.count?.registeredSuccess>0))throw Error('NOT_ACCEPTED');}
 status=mailOutcome?.status||'accepted';note=mailOutcome?.note||'발송 서비스 접수 완료 · 실제 수신 여부는 메일함/휴대폰에서 확인해주세요.';
 }catch{status='unknown';note='접속·인증·접수 오류 또는 결과 불명확. 연결 설정과 서비스 발송내역을 확인하세요. 중복 방지를 위해 자동 재전송하지 않습니다.';}
 this.db.prepare('UPDATE deliveries SET status=?,note=? WHERE id=?').run(status,note,id);return {status,note};}
 queue(event){if(event.mode!=='real'||event.stage!=='조건 충족 발견')return;this.chain=this.chain.then(async()=>{for(const channel of ['mail','sms'])await this.send(channel,event);}).catch(()=>{});}
 test(channel){if(!['mail','sms'].includes(channel))throw Error('알림 종류 오류');const last=this.db.prepare('SELECT created_at FROM deliveries WHERE channel=? ORDER BY rowid DESC LIMIT 1').get(channel);if(last&&Date.now()-Date.parse(last.created_at)<60000)throw Error('1분 뒤 다시 테스트해주세요.');const event={id:randomUUID(),stage:'연결 테스트',message:'이메일 또는 문자 연결 테스트입니다. 실제 항공권 발견 알림이 아닙니다.'};const result=this.chain.then(()=>this.send(channel,event));this.chain=result.catch(()=>{});return result;}
}
