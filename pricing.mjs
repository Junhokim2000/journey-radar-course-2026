import {matchFlightTimes} from './time-windows.mjs';
import {summarizeSellerListings} from './seller-offers.mjs';
import {money,destinationMatches} from './core.mjs';
const required=['fare','taxes','bookingFee','paymentFee','requiredBaggage'];
const fail=(reason,missing=[])=>({comparable:false,status:'unverified',reason,missing,confirmedTotal:null});
export function verifyPayable(task,offer,now=Date.now()){
 const v=offer.purchaseVerification;if(!v)return offer.bookingReview?.status==='receipt_observed'?fail('입력 단계 항목 합계 확인 · 결제 단계의 추가 비용과 최종 총액 미확인',['paymentFee','finalCheckout']):fail('판매 사이트의 최종 전체 금액 미확인',required);
 if(!['checkout-review','fare-review'].includes(v.stage))return fail('검색·가격비교 화면 가격은 결제 총액이 아닙니다');
 if(!v.seller||!v.source||!v.observedAt)return fail('실제 판매처와 조회 근거 미확인');let url;try{url=new URL(v.source);}catch{return fail('판매처 출처 오류');}if(url.protocol!=='https:'||url.username||url.password||url.hostname!==v.seller)return fail('판매처 출처 불일치');
 const time=Date.parse(v.observedAt);if(!Number.isFinite(time)||Math.abs(now-time)>15*60000)return fail('최종 금액 확인 후 15분 경과 또는 조회 시각 오류');
 const i=v.itinerary;if(!i||i.origin!==task.origin||!destinationMatches(task.destination,i.destination)||i.departure!==task.departure||i.trip!==task.trip||i.adults!==task.adults||(task.trip==='roundtrip'&&i.returnDate!==task.returnDate))return fail('실제 예약 여정·날짜·인원 불일치');
 const timeCheck=matchFlightTimes(task,i);if(timeCheck.status!=='matched')return fail(timeCheck.reason);
 if(v.currency!==task.currency||v.basis!=='all-passengers-entire-trip')return fail('통화 또는 전체 인원·전체 여정 금액 기준 미확인');
 if(v.itineraryConfirmed!==true||v.paymentMethodConfirmed!==true||v.optionalExtrasExcluded!==true)return fail('여정·결제수단 수수료·불필요한 유료 옵션 확인 필요');
 if(task.paymentMethod&&v.paymentMethod!==task.paymentMethod)return fail('선택한 결제 조건과 판매처 수수료 기준 불일치');
 if(!Array.isArray(v.components))return fail('필수 비용 내역 미확인',required);
 const missing=required.filter(k=>!v.components.some(c=>c.kind===k&&c.confirmed===true&&typeof c.amount==='string'));
 if(missing.length)return fail('일부 필수 비용 미확인',missing);
 if(required.some(k=>v.components.filter(c=>c.kind===k).length!==1))return fail('중복 비용 또는 모호한 금액 내역');
 if(task.baggage){const legs=task.trip==='roundtrip'?2:1;if(!Array.isArray(v.baggageByLeg)||v.baggageByLeg.length!==legs||v.baggageByLeg.some(b=>b.confirmed!==true||b.kg<15||b.passengers!==task.adults))return fail('모든 구간·모든 인원의 필수 수하물 확인 필요');}
 let sum,final;try{sum=required.reduce((n,k)=>n+money(v.components.find(c=>c.kind===k).amount,v.currency),0n);final=money(v.finalTotal,v.currency);}catch{return fail('금액 형식 오류');}
 if(sum!==final)return fail('필수 비용 합계와 판매처 표시 최종 총액 불일치');
 let delta=null;try{delta=((final-money(offer.displayPrice,v.currency))/100n).toString();}catch{}
 const target=money(task.target,task.currency);const matched=task.priceOperator==='lt'?final<target:final<=target;
 return {comparable:true,status:matched?'matched':'over_budget',reason:'판매처에서 확인한 필수 비용 포함 전체 금액',confirmedTotal:v.finalTotal,currency:v.currency,seller:v.seller,source:v.source,observedAt:v.observedAt,priceChange:delta,minimumUnitTotal:final.toString(),evidenceStage:v.stage};
}
export function rankPayable(task,sites,now=Date.now()){
 const checked=sites.flatMap(s=>(s.offers||[]).map(o=>({...o,providerId:s.providerId,pricing:verifyPayable(task,o,now)})));
 const comparable=checked.filter(o=>o.pricing.comparable).sort((a,b)=>{const x=BigInt(a.pricing.minimumUnitTotal),y=BigInt(b.pricing.minimumUnitTotal);return x<y?-1:x>y?1:0;});
 const unique=[];const seen=new Set();for(const o of comparable){const i=o.purchaseVerification.itinerary;const key=[o.pricing.seller,i.origin,i.destination,i.departure,i.returnDate,o.pricing.confirmedTotal,o.purchaseVerification.fareId||''].join('|');if(!seen.has(key)){seen.add(key);unique.push(o);}}
 return {listedSellers:summarizeSellerListings(sites),ranked:unique.map((o,index)=>({...o,rank:index+1})),unverified:checked.filter(o=>!o.pricing.comparable),verifiedSellerCount:new Set(unique.map(o=>o.pricing.seller)).size,coverageComplete:false,scope:'확인된 조건·판매처 내 최저가 · 전체 시장 최저가 보장 아님'};
}
