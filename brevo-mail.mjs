const validEmail=s=>typeof s==='string'&&s.length<=254&&/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(s);
export function mailService(input){
 if(!input||input.provider==='formsubmit')return {provider:'formsubmit'};
 if(input.provider!=='brevo')throw Error('지원하는 메일 발송 서비스를 선택해주세요.');
 const from=String(input.from||'').trim(),apiKey=String(input.apiKey||'');
 if(!validEmail(from))throw Error('Brevo에서 인증한 보내는 이메일을 입력해주세요.');
 if(apiKey.length<20||apiKey.length>500||/[\r\n\s]/.test(apiKey))throw Error('Brevo API 키를 입력해주세요.');
 return {provider:'brevo',from,apiKey};
}
export async function submitBrevoEmail(to,payload,service,{fetchImpl=fetch}={}){
 const c=mailService(service);if(!validEmail(to))throw Error('받을 이메일 주소를 확인해주세요.');
 const text=Object.entries(payload).filter(([k])=>!k.startsWith('_')).map(([k,v])=>k+': '+String(v)).join('\n\n');
 let response;try{response=await fetchImpl('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':c.apiKey,Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({sender:{name:'여정 레이더',email:c.from},to:[{email:to}],subject:String(payload._subject||'[여정 레이더] 항공권 알림'),textContent:text}),signal:AbortSignal.timeout(25000)});}catch{return {status:'unknown',note:'발송 응답을 확인하지 못했습니다. Brevo 발송 내역을 확인해주세요. 중복 방지를 위해 자동 재전송하지 않습니다.'};}
 let data;try{data=await response.json();}catch{return {status:response.ok?'unknown':'rejected',httpStatus:response.status,note:'메일 서비스 응답을 확인하지 못했습니다. Brevo 발송 내역을 확인해주세요.'};}
 if(response.status===201&&typeof data.messageId==='string'&&data.messageId)return {status:'accepted',httpStatus:201,note:'Brevo가 메일을 접수했습니다. 실제 도착은 받은편지함·스팸함에서 확인해주세요.'};
 const code=String(data?.code||'');let note='Brevo가 발송을 거절했습니다. 계정 승인과 보내는 주소 인증 상태를 확인해주세요.';
 if(/unrecogni[sz]ed IP|unauthori[sz]ed IP|IP address.*(?:block|authori[sz])/i.test(String(data?.message||'')))note='Brevo가 등록되지 않은 접속 주소(IP)를 차단했습니다. Brevo 보안 설정의 승인된 IP와 보안 알림을 확인해주세요. 키를 다시 발급하기 전에 접속 승인을 확인하세요.';
 else if(response.status===401||code==='unauthorized')note='Brevo API 키가 유효하지 않습니다. 홈페이지에서 새 키를 연결해주세요.';
 else if(response.status===402||code==='not_enough_credits')note='Brevo 무료 발송 한도 또는 잔액을 확인해주세요. 유료 발송으로 자동 전환하지 않습니다.';
 else if(response.status===429)note='Brevo 요청 한도에 도달했습니다. 잠시 후 발송 내역을 확인해주세요.';
 return {status:'rejected',httpStatus:response.status,note};
}
