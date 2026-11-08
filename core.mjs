import {normalizeTimeWindows,matchFlightTimes} from './time-windows.mjs';
import catalog from './data/destinations.json' with {type:'json'};
export const destinationCatalog=catalog;
const destinationIndex=new Map(catalog.airports.map(a=>[a.code,a]));
export const airports={ICN:'인천',GMP:'김포',PUS:'부산',...Object.fromEntries(catalog.airports.map(a=>[a.code,a.label])),JP_ALL:'일본 전체',CN_ALL:'중국 전체'};
export function destinationCountry(code){return code==='JP_ALL'?'JP':code==='CN_ALL'?'CN':destinationIndex.get(code)?.country;}
export function destinationMatches(selection,code){if(!destinationIndex.has(code))return false;return selection.endsWith('_ALL')?destinationCountry(selection)===destinationCountry(code):selection===code;}
export function money(value,currency='KRW') {
 if(!['KRW','USD','JPY','EUR'].includes(currency)) throw Error('지원하지 않는 통화');
 const s=String(value).trim().replace(/^(KRW|USD|JPY|EUR|₩|\$|¥|€)\s*/, '').replace(/,/g,'').trim();
 if(!/^\d+(\.\d{1,2})?$/.test(s)) throw Error('가격 형식 확인 필요');
 const [whole,fraction='']=s.split('.'); if(['KRW','JPY'].includes(currency)&&Number(fraction)!==0) throw Error('최소 통화 단위 오류');
 const n=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0')); if(n>9000000000000000n) throw Error('가격 범위 초과'); return n;
}
export function validate(x){
 if(!['ICN','GMP','PUS'].includes(x.origin)||!destinationCountry(x.destination)||x.origin===x.destination) throw Error('지원 공항 또는 일본·중국 도착지를 선택하세요');
 if(x.destinationCountry&&x.destinationCountry!==destinationCountry(x.destination))throw Error('도착 국가와 공항이 일치하지 않습니다');
 const validDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')&&!isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
 if(!validDate(x.departure)||!['oneway','roundtrip'].includes(x.trip)) throw Error('날짜 또는 여정 오류');
 if(x.trip==='roundtrip'&&(!validDate(x.returnDate)||x.returnDate<x.departure)) throw Error('귀국 날짜 오류');
 if(!Number.isInteger(x.adults)||x.adults<1||x.adults>6) throw Error('성인 1~6명');
 if(!Number.isInteger(x.interval)||x.interval<10||x.interval>1440) throw Error('조회 간격 10~1440분');
 if(money(x.target,x.currency)<=0n) throw Error('목표 총액 오류');
 if(!['demo','real'].includes(x.mode)||!['below','equal','above','baggage','rise','unknown','session'].includes(x.scenario)) throw Error('모드 오류');
 if(x.mode==='real'&&x.interval!==10)throw Error('실사용 감시는 10분 간격입니다');
 if(x.mode==='real'&&x.autoPrepare) throw Error('실제 예약 준비는 검증 전 비활성화');
 if(x.allowOrder) throw Error('미결제 주문 기능은 검증 전 비활성화');
 if(x.priceOperator&&!['lt','lte'].includes(x.priceOperator))throw Error('가격 비교 기준 오류');
 return {...normalizeTimeWindows(x),...Object.fromEntries(['origin','destination','departure','returnDate','trip','adults','interval','target','currency','mode','scenario','autoPrepare','baggage'].map(k=>[k,x[k]])),paymentMethod:x.paymentMethod||'card_no_promo',priceOperator:x.priceOperator||'lte',destinationCountry:destinationCountry(x.destination),destinationScope:x.destination.endsWith('_ALL')?'country':'airport'};
}
export function evaluate(task,quote){
 const timeCheck=matchFlightTimes(task,quote);if(timeCheck.status!=='matched')return {status:timeCheck.status==='outside'?'rejected':'needs_review',reason:timeCheck.reason};
 for(const k of ['origin','departure','trip','adults','currency']) if(quote[k]!==task[k]) return {status:'rejected',reason:k+' 불일치'};
 if(!destinationMatches(task.destination,quote.destination))return {status:'rejected',reason:'도착 국가·허용 공항 불일치 또는 실제 도착 공항 미확인'};
 if(task.trip==='roundtrip'&&quote.returnDate!==task.returnDate) return {status:'rejected',reason:'귀국 날짜 불일치'};
 if(quote.basis!=='all-adults'||quote.taxIncluded!==true||quote.total==null||(task.baggage&&(quote.baggageIncluded!==true||!(Number(quote.baggageKg)>=15)))) return {status:'needs_review',reason:'전체 총액·필수 비용·수하물 확인 필요'};
 return money(quote.total,quote.currency)<=money(task.target,task.currency)?{status:'matched',reason:'전체 인원 총액이 목표 이하'}:{status:'over_budget',reason:'목표 총액 초과'};
}
export function demoQuote(t){
 const base={below:'285000',equal:'300000',above:'315000',baggage:'320000',rise:'285000',unknown:'285000',session:'285000'}[t.scenario];
 return {...t,destination:t.destination==='JP_ALL'?'KIX':t.destination==='CN_ALL'?'PEK':t.destination,total:base,basis:'all-adults',taxIncluded:t.scenario!=='unknown',baggageIncluded:t.scenario!=='unknown',flight:'DEMO101',fare:'가상 일반석',stops:0,duration:'1시간 50분',baggageKg:15,baggageText:'가상 위탁수하물 15kg',displayFare:t.scenario==='baggage'?'280000':base,observedAt:new Date().toISOString(),source:'local-demo'};
}
export const transitions={paused:['monitoring','ended'],monitoring:['searching','paused','ended'],searching:['monitoring','candidate','needs_review','action_required','paused','ended','error'],candidate:['preparing','monitoring','paused','ended'],preparing:['prepayment','action_required','paused','ended','error'],prepayment:['paused','ended'],needs_review:['monitoring','paused','ended'],action_required:['monitoring','paused','ended'],error:['monitoring','paused','ended'],ended:[]};
export function canTransition(a,b){return transitions[a]?.includes(b)===true;}
export function deadline(observed,seconds){return seconds==null?{status:'unconfirmed'}:{status:'estimated_from_display',observedAt:observed,remainingSeconds:seconds,estimatedExpiry:new Date(Date.parse(observed)+seconds*1000).toISOString()};}
