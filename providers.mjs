// 검색 출처 수와 실제 판매처 수는 별도로 집계합니다.
export const providers=[
{id:'trip',name:'트립닷컴',kind:'seller',url:'https://kr.trip.com/flights/',hosts:['kr.trip.com','www.trip.com']},
{id:'google',name:'구글 항공편',kind:'metasearch',url:'https://www.google.com/travel/flights',hosts:['www.google.com','flights.google.com']},
{id:'skyscanner',name:'스카이스캐너',kind:'metasearch',url:'https://www.skyscanner.co.kr/',hosts:['www.skyscanner.co.kr','www.skyscanner.com','www.skyscanner.net']},
{id:'kayak',name:'카약',kind:'metasearch',url:'https://www.kayak.co.kr/',hosts:['www.kayak.co.kr','www.kayak.com']},
{id:'hana',name:'하나투어',kind:'seller',url:'https://www.hanatour.com/v2/airline',hosts:['www.hanatour.com']}
];
export function validateObservation(x){
 const p=providers.find(p=>p.id===x.providerId);if(!p)throw Error('지원하지 않는 사이트');
 if(!['observed','blocked','failed','needs_review'].includes(x.status))throw Error('조회 상태 오류');
 const time=Date.parse(x.observedAt);if(!Number.isFinite(time)||Math.abs(Date.now()-time)>15*60000)throw Error('최근 15분 이내의 실제 조회 시각이 필요합니다');
 let source;try{source=new URL(x.source);}catch{throw Error('공식 출처 URL 필요');}
 if(source.protocol!=='https:'||!p.hosts.includes(source.hostname)||source.username||source.password)throw Error('공식 사이트 출처만 허용');
 if(x.status==='observed'){
  if(!x.quote||!Array.isArray(x.confirmedFields))throw Error('페이지에서 확인한 항목 필요');
  for(const k of ['origin','destination','departure','trip','adults','currency','total','basis','taxIncluded'])if(!x.confirmedFields.includes(k))throw Error('노선·날짜·인원·총액의 화면 확인 필요');
  if(x.quote.trip==='roundtrip'&&!x.confirmedFields.includes('returnDate'))throw Error('왕복 전체 날짜 확인 필요');
  if(typeof x.quote.total!=='string'||!x.quote.flight||typeof x.quote.flight!=='string'||x.quote.flight.length>120)throw Error('표시 금액 및 항공편 확인 필요');
 }
 const reason={blocked:'접근 차단 또는 추가 인증 · 우회하지 않음',failed:'페이지 조회 실패',needs_review:'필수 조건 또는 최종 총액 확인 필요',observed:'공개 검색 결과 확인'}[x.status];
 return {providerId:p.id,status:x.status,observedAt:new Date(time).toISOString(),source:source.origin+source.pathname,reason};
}
