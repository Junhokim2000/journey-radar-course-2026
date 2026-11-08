import {windowsProtect} from './saved-ai-settings.mjs';
import {mailService} from './brevo-mail.mjs';
export class SavedMailConnection{
 constructor(db,notifications,{crypt=windowsProtect}={}){this.db=db;this.notifications=notifications;this.crypt=crypt;this.saving=false;db.exec('CREATE TABLE IF NOT EXISTS mail_credentials(id INTEGER PRIMARY KEY CHECK(id=1),sealed TEXT NOT NULL)');}
 async restore(){const row=this.db.prepare('SELECT sealed FROM mail_credentials WHERE id=1').get();if(!row)return false;try{const c=mailService(JSON.parse(await this.crypt('unprotect','mail-notifications-v1',row.sealed)));this.notifications.secrets.brevoKey=c.apiKey;return true;}catch{this.notifications.secrets.brevoKey='';return false;}}
 async save(input){if(this.saving)throw Error('메일 연결을 저장 중입니다.');this.saving=true;try{
 const old=this.notifications.settings();const c=mailService({provider:'brevo',from:input.from,apiKey:input.apiKey||this.notifications.secrets.brevoKey});
 const to=String(input.to||old.mail.to||'').trim();if(!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(to))throw Error('받을 이메일 주소를 확인해주세요.');
 const sealed=await this.crypt('protect','mail-notifications-v1',JSON.stringify(c));
 const result=this.notifications.save({mail:{...old.mail,enabled:true,provider:'brevo',user:c.from,to},sms:old.sms,secrets:{brevoKey:c.apiKey}});
 this.db.prepare('INSERT OR REPLACE INTO mail_credentials VALUES (1,?)').run(sealed);return result;
 }finally{this.saving=false;}}
}
