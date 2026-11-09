import {Notifications} from './notifications.mjs';
export class MemberNotifications extends Notifications{
 constructor(db,shared){super(db);this.shared=shared;}
 personalSettings(){return super.settings();}
 settings(){const personal=super.settings();if(!this.shared)return personal;const backend=this.shared.settings();return {mail:{...backend.mail,to:personal.mail.to||'',enabled:personal.mail.enabled===true&&backend.mail.enabled===true,inputStageAlerts:personal.mail.inputStageAlerts===true},sms:{enabled:false,from:'',to:'',costConsent:false}};}
 save(x){const backend=this.shared.settings();return super.save({mail:{...x.mail,provider:backend.mail.provider,user:backend.mail.user},sms:{enabled:false}});}
 status(){if(this.shared)this.secrets=this.shared.secrets;return super.status();}
 async send(channel,event){this.secrets=this.shared.secrets;return super.send(channel,event);}
}
