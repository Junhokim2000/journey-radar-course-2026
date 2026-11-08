import {test} from 'node:test';import assert from 'node:assert/strict';import {parseTripPassengerReceipt,parseTripBaggageRows,collectTripReceipt} from '../trip-receipt.mjs';import {verifyPayable} from '../pricing.mjs';
const task={origin:'ICN',destination:'KIX',departure:'2026-12-26',returnDate:'2027-01-03',trip:'roundtrip',adults:1,baggage:true,target:'700000',currency:'KRW'};
const text=`승객 정보를 입력하세요
서울 ( ICN ) 오사카 ( KIX ) 2026년 12월 26일(토) 15:20 – 17:00
오사카 ( KIX ) 서울 ( ICN ) 2027년 1월 3일(일) 08:50 – 11:00
탑승객 정보 입력
성 FAKE_PERSON 이름 FAKE_EMAIL@example.com
총금액 373,900원
요금 상세정보
항공권(성인 1명) 363,900원
운임 153,500원 × 1
세금 및 수수료 210,400원 × 1
위탁 수하물 무료
트립닷컴 발권수수료 10,000원
총 금액 373,900원`;
const opts={baggageKgByLeg:[15,15],paymentSelection:'all-methods'};
test('판매처 입력 단계 운임·세금·발권료 합계와 여정 확인, 개인정보/쿼리는 저장하지 않음',()=>{const r=parseTripPassengerReceipt(text,task,'https://kr.trip.com/flights/book/?token=FAKE_SESSION',opts);assert.equal(r.status,'receipt_observed');assert.equal(r.displayedReviewTotal,'373900');assert.equal(r.fareAmount,'153500');assert.equal(r.taxesAndFees,'210400');assert.equal(r.bookingFee,'10000');assert.equal(r.componentsTotalMatches,true);assert.equal(r.ticketComponentsMatch,true);assert.equal(r.baggageSuitable,true);assert.equal(r.baggageFree,true);assert.equal(r.itinerary.returnArrivalTime,'11:00');assert.equal(r.source,'https://kr.trip.com/flights/book/');assert.ok(!JSON.stringify(r).includes('FAKE_'));assert.equal(r.paymentFee,null);assert.equal(r.finalTotalConfirmed,false);assert.equal(verifyPayable(task,{displayPrice:'359200',bookingReview:r}).comparable,false);});
test('다른 공항·날짜·인원·시각·합계·외부 출처를 검증 성공으로 만들지 않음',()=>{for(const other of [text.replace('ICN','GMP'),text.replace('12월 26일','12월 27일'),text.replace('성인 1명','성인 2명'),text.replace('10,000원','15,000원'),text.replace('210,400원','210,500원'),text.replace('총 금액 373,900원','총 금액 473,900원')])assert.notEqual(parseTripPassengerReceipt(other,task,'https://kr.trip.com/flights/book/',opts).status,'receipt_observed');assert.notEqual(parseTripPassengerReceipt(text,{...task,returnArrivalTimeTo:'10:00'},'https://kr.trip.com/flights/book/',opts).status,'receipt_observed');assert.notEqual(parseTripPassengerReceipt(text,task,'https://kr.trip.com.evil.example/book/',opts).status,'receipt_observed');});
test('세금 세부내역이 없으면 임의로 0원 확정하지 않고 미확인으로 유지',()=>{const r=parseTripPassengerReceipt(text.replace('운임 153,500원 × 1','').replace('세금 및 수수료 210,400원 × 1',''),task,'https://kr.trip.com/flights/book/',{});assert.equal(r.status,'receipt_observed');assert.equal(r.fareAmount,null);assert.equal(r.taxesAndFees,null);assert.equal(r.ticketComponentsMatch,null);assert.equal(r.baggageSuitable,null);assert.equal(r.verified,false);});

test('출국 시각이 화면에 중복되어도 귀국 날짜 뒤 시각을 분리해 읽음',()=>{const r=parseTripPassengerReceipt(text.replace('15:20 – 17:00','15:20 – 17:00 15:20 – 17:00'),task,'https://kr.trip.com/flights/book/',opts);assert.equal(r.itinerary.returnDepartureTime,'08:50');assert.equal(r.itinerary.returnArrivalTime,'11:00');});

test('수하물 표의 승객별 마지막 열만 읽고 누락·인원 불일치는 확인 불가',()=>{const row='가는편\n서울–오사카\n탑승객 1\n1개 총 10kg\n1개 총 10kg\n1 × 15kg';assert.deepEqual(parseTripBaggageRows([row,row.replace('1 × 15kg','총 20kg')],1).map(x=>x.kgByPassenger),[[15],[20]]);assert.deepEqual(parseTripBaggageRows([row.replace('1 × 15kg','없음')],1)[0].kgByPassenger,[0]);assert.equal(parseTripBaggageRows([row],2)[0],null);assert.equal(parseTripBaggageRows([row.replace('1 × 15kg','미확인')],1)[0],null);});

test('취소된 추가 조회는 새 판매처 페이지를 열지 않음',async()=>{let opened=0;const r=await collectTripReceipt({newPage:async()=>{opened++;}},task,{},'https://kr.trip.com',()=>false);assert.equal(opened,0);assert.equal(r.status,'cancelled');});
