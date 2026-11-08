import {randomBytes} from 'node:crypto';
import {validate} from '../core.mjs';
const validEmail=s=>typeof s==='string'&&s.length<=254&&/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(s);
export function cloudConfig(input,{allowEmpty=false}={}){
 if(!input||input.version!==1)throw Error('클라우드 설정 형식을 확인해주세요.');
 if(input.emailEnabled!==false&&!validEmail(input.email))throw Error('받을 이메일 주소가 필요합니다.');
 if(typeof input.notificationSalt!=='string'||!/^[a-f0-9]{64}$/.test(input.notificationSalt))throw Error('알림 중복 방지 설정을 다시 내보내주세요.');
 if(!Array.isArray(input.tasks)||input.tasks.length>5||(!allowEmpty&&!input.tasks.length))throw Error('감시 조건을 1~5개 등록해주세요.');
 const tasks=input.tasks.map((x,index)=>({...validate({...x,mode:'real',interval:10,scenario:'below',autoPrepare:false,currency:'KRW'}),id:typeof x.id==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(x.id)?x.id:'condition-'+(index+1)}));
 if(input.alertPolicy&&!['verified-only','input-stage-reference'].includes(input.alertPolicy))throw Error('알림 기준을 확인해주세요.');return {version:1,email:String(input.email||'').trim(),emailEnabled:input.emailEnabled!==false,alertPolicy:input.alertPolicy||'verified-only',notificationSalt:input.notificationSalt,notificationOrigin:'http://127.0.0.1:8765',tasks,maxEmailsPerDay:5};
}
export function exportCloudConfig(tasks,settings,salt=randomBytes(32).toString('hex')){
 return cloudConfig({version:1,email:settings?.mail?.to||'',emailEnabled:settings?.mail?.enabled!==false,alertPolicy:settings?.mail?.inputStageAlerts===true?'input-stage-reference':'verified-only',notificationSalt:salt,tasks:tasks.filter(t=>t.mode==='real'&&t.state!=='ended')});
}
