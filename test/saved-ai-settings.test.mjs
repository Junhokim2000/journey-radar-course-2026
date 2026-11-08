import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {OpenAIFlights} from '../ai-chat.mjs';
import {SavedAISettings,windowsProtect} from '../saved-ai-settings.mjs';
const key='sk-TEST_ONLY_PERSISTENCE_123456789';
test('실제 Windows DPAPI 암호화 저장·계정별 복원·삭제',async()=>{
 const db=new DatabaseSync(':memory:');const store=new SavedAISettings(db);const client=new OpenAIFlights({key:''});
 const result=await store.save('test-owner',{apiKey:key,model:'gpt-5.4-mini',costConsent:true},client);
 assert.equal(result.savedForAccount,true);assert.ok(!JSON.stringify(db.prepare('SELECT * FROM ai_credentials').all()).includes(key));
 const restored=new OpenAIFlights({key:''});const newStore=new SavedAISettings(db);assert.equal(await newStore.restore('test-owner',restored),true);assert.equal(restored.key,key);assert.equal(restored.model,'gpt-5.4-mini');
 assert.equal(await newStore.restore('other-owner',new OpenAIFlights({key:''})),false);
 const sealed=db.prepare('SELECT sealed FROM ai_credentials').get().sealed;await assert.rejects(()=>windowsProtect('unprotect','other-owner',sealed),/보호 저장소/);
 await newStore.save('test-owner',{clearKey:true},restored);assert.equal(restored.status().configured,false);assert.equal(newStore.status(restored,'test-owner').savedForAccount,false);assert.equal(await newStore.restore('test-owner',new OpenAIFlights({key:''})),false);db.close();
});
test('암호화 실패는 기존 키와 저장값을 덮어쓰지 않음',async()=>{const db=new DatabaseSync(':memory:');const store=new SavedAISettings(db,{crypt:async()=>{throw Error('TEST ONLY encryption failure');}});const client=new OpenAIFlights({key});await assert.rejects(()=>store.save('test-owner',{apiKey:'sk-TEST_ONLY_NEW_VALUE_987654321',costConsent:true},client));assert.equal(client.key,key);assert.equal(db.prepare('SELECT count(*) AS n FROM ai_credentials').get().n,0);db.close();});
test('복원 실패 시 평문 저장으로 우회하거나 서버를 종료하지 않음',async()=>{const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE ai_credentials(owner TEXT PRIMARY KEY,sealed TEXT NOT NULL,updated_at TEXT NOT NULL)');db.prepare('INSERT INTO ai_credentials VALUES (?,?,?)').run('test-owner','CORRUPTED','TEST ONLY');const store=new SavedAISettings(db);const c=new OpenAIFlights({key:''});assert.equal(await store.restore('test-owner',c),false);assert.equal(c.status().configured,false);assert.ok(store.status(c,'test-owner').restoreError);db.close();});
for(const [code,type,expected] of [['insufficient_quota','insufficient_quota',/API 잔액/],['credit_balance_exhausted','insufficient_quota',/API 잔액/],['rate_limit_exceeded','rate_limit_error',/일시적인.*5초/],['project_spend_limit_exceeded','insufficient_quota',/프로젝트 사용 한도/]]){
 test('429 구분: '+code,async()=>{const c=new OpenAIFlights({key,fetchImpl:async()=>Response.json({error:{code,type,message:'TEST ONLY DO NOT DISPLAY RAW SECRET'}},{status:429,headers:{'Retry-After':'5'}})});try{await c.plan([]);assert.fail('must reject');}catch(e){assert.match(e.message,expected);assert.ok(!e.message.includes('RAW SECRET'));assert.equal(e.diagnostic.code,code);}});
}
