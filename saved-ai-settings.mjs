import {spawn} from 'node:child_process';
import path from 'node:path';
import {OpenAIFlights} from './ai-chat.mjs';

// DPAPI binds the ciphertext to the current Windows user. Secrets travel through stdin,
// never command arguments, shell interpolation, console output, or plaintext files.
const script=`$ErrorActionPreference='Stop'; try {
 Add-Type -AssemblyName System.Security
 $x=([Console]::In.ReadToEnd() | ConvertFrom-Json)
 $entropy=[Text.Encoding]::UTF8.GetBytes('journey-radar-openai-v1:'+[string]$x.owner)
 if($x.operation -eq 'protect') {
  $bytes=[Text.Encoding]::UTF8.GetBytes([string]$x.value)
  $protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($protected))
 } elseif($x.operation -eq 'unprotect') {
  $bytes=[Convert]::FromBase64String([string]$x.value)
  $plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
 } else { exit 2 }
} catch { [Console]::Error.Write('DPAPI_FAILED'); exit 1 }`;
export async function windowsProtect(operation,owner,value){
 if(process.platform!=='win32')throw Error('키 영구 저장은 현재 Windows에서만 지원합니다.');
 return new Promise((resolve,reject)=>{
  const exe=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const child=spawn(exe,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let out='',done=false;const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);if(error)reject(Error('Windows 키 보호 저장소를 사용할 수 없습니다. 키를 다시 연결해주세요.'));else resolve(result);};
  const timer=setTimeout(()=>{child.kill();finish(true);},15000);
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{out+=chunk;if(out.length>131072){child.kill();finish(true);}});
  child.stderr.resume();child.on('error',()=>finish(true));child.stdin.on('error',()=>finish(true));child.on('close',code=>finish(code!==0||!out,out));
  child.stdin.end(JSON.stringify({operation,owner,value}));
 });
}
export class SavedAISettings{
 constructor(db,{crypt=windowsProtect}={}){this.db=db;this.crypt=crypt;this.saving=false;this.restoreError=null;db.exec('CREATE TABLE IF NOT EXISTS ai_credentials(owner TEXT PRIMARY KEY, sealed TEXT NOT NULL, updated_at TEXT NOT NULL)');}
 status(client,owner){const saved=!!owner&&!!this.db.prepare('SELECT owner FROM ai_credentials WHERE owner=?').get(owner);return {...client.status(),keyStorage:saved?'windows-dpapi':'server-memory',savedForAccount:saved,restoreError:this.restoreError,note:saved?'이 로그인 계정의 키를 Windows 보호 방식으로 저장했습니다. 같은 PC·Windows 사용자에서 서버를 다시 시작해도 사용할 수 있습니다.':'키를 연결 설정 저장으로 등록하면 이 로그인 계정에 암호화해 저장합니다.'};}
 async restore(owner,client){if(!owner)return false;const row=this.db.prepare('SELECT sealed FROM ai_credentials WHERE owner=?').get(owner);if(!row)return false;try{const x=JSON.parse(await this.crypt('unprotect',owner,row.sealed));client.configure(x);this.restoreError=null;return true;}catch{client.key='';client.costConsent=false;this.restoreError='저장한 키를 복원하지 못했습니다. 같은 Windows 사용자로 실행하거나 키를 다시 연결해주세요.';return false;}}
 async save(owner,x,client){if(!owner)throw Error('로그인이 필요합니다.');if(this.saving)throw Error('연결 설정을 저장하고 있습니다. 잠시 기다려주세요.');this.saving=true;try{
  const staged=new OpenAIFlights({key:client.key,model:client.model});staged.configure(x);
  if(x.clearKey){this.db.prepare('DELETE FROM ai_credentials WHERE owner=?').run(owner);client.configure(x);this.restoreError=null;return this.status(client,owner);}
  const record={apiKey:staged.key,model:staged.model,costConsent:staged.costConsent};
  const sealed=await this.crypt('protect',owner,JSON.stringify(record));
  this.db.prepare('INSERT OR REPLACE INTO ai_credentials VALUES (?,?,?)').run(owner,sealed,new Date().toISOString());
  client.configure(record);this.restoreError=null;return this.status(client,owner);
 }finally{this.saving=false;}}
}
