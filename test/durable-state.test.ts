import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { DurableState, StateRpcError, acquireStateGate, seal, unseal, type StateRow } from "../src/durable-state.ts";
import { Store, store, withStoreTask, type StoreData } from "../src/store.ts";
import { createServer } from "node:http";
import { recoverGrants, type Bootstrap } from "../src/state-migration.ts";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const empty = (): StoreData => ({ version: 1, accounts: {}, sessions: {}, watches: {}, pending_auth: {}, oauth: { clients: {}, codes: {}, tokens: {} } });
const key = randomBytes(32);
test("authenticated encryption detects tampering and wrong keys without exposing data", () => {
  const envelope = seal({ private: "sensitive value" }, key);
  assert.ok(!envelope.includes("sensitive value"));
  assert.deepEqual(unseal(envelope,key),{private:"sensitive value"});
  assert.throws(()=>unseal(envelope,randomBytes(32)),/authentication/);
  const raw=Buffer.from(envelope,"base64");raw[35]^=1;
  assert.throws(()=>unseal(raw.toString("base64"),key),/authentication/);
});
test("process restart restores durable state, with no plaintext local cache", () => {
  let row: StateRow={revision:1,envelope:seal(empty(),key),operation_id:randomUUID()};
  const backend={read:()=>({...row}),commit:(expected:number,envelope:string,operation:string)=>{
    assert.equal(expected,row.revision);row={revision:expected+1,envelope,operation_id:operation};return {...row};
  }};
  const path=join(mkdtempSync(join(tmpdir(),"bank-durable-")),"bank.json");
  const a=new Store(path);a.durable=new DurableState(backend,key,row);a.data=a.durable.data();
  a.addPendingAuth({state:"pending",bank:{name:"Test Bank",country:"DK"},started:new Date().toISOString()});
  assert.equal(existsSync(path),false);
  const b=new DurableState(backend,key,backend.read());
  assert.ok(b.data().pending_auth.pending);
});
test("lost commit response is resolved by operation id without writing twice", () => {
  let row:StateRow={revision:1,envelope:seal(empty(),key),operation_id:randomUUID()},writes=0;
  const backend={read:(op?:string)=>({...row,matched_operation:op===row.operation_id}),commit:(r:number,e:string,op:string)=>{
    writes++;row={revision:r+1,envelope:e,operation_id:op};throw new Error("response lost");
  }};
  const d=new DurableState(backend,key,row),candidate=d.data();candidate.pending_auth.a={state:"a",bank:{name:"Test",country:"DK"},started:new Date().toISOString()};
  d.save(candidate);assert.equal(writes,1);assert.equal(d.revision,2);
});
test("unconfirmed write fails closed and does not accept more writes",()=>{
  const row={revision:1,envelope:seal(empty(),key),operation_id:randomUUID()};let writes=0;
  const d=new DurableState({read:()=>row,commit:()=>{writes++;throw new Error("unknown");}},key,row),candidate=d.data();
  candidate.pending_auth.a={state:"a",bank:{name:"Test",country:"DK"},started:new Date().toISOString()};
  assert.throws(()=>d.save(candidate),/unconfirmed/);assert.throws(()=>d.save(candidate),/resolution/);assert.equal(writes,1);
});
test("two instances reject a stale CAS without poisoning the losing instance",()=>{
  let row:StateRow={revision:1,envelope:seal(empty(),key),operation_id:randomUUID()};
  const backend={read:()=>({...row}),commit:(r:number,e:string,op:string)=>{
    if(r!==row.revision)throw new StateRpcError(409);row={revision:r+1,envelope:e,operation_id:op};return {...row};
  }};
  const a=new DurableState(backend,key,row),b=new DurableState(backend,key,row);
  const candidate=a.data();candidate.pending_auth.a={state:"a",bank:{name:"Test",country:"DK"},started:new Date().toISOString()};a.save(candidate);
  const stale=b.data();stale.pending_auth.b={state:"b",bank:{name:"Test",country:"DK"},started:new Date().toISOString()};
  assert.throws(()=>b.save(stale),/conflict/);assert.ok(b.refresh().pending_auth.a);assert.equal(b.data().pending_auth.b,undefined);
});
test("operation gate remains held until provider work settles, independent of client disconnect",async()=>{
  let unblock!:()=>void;const providerWait=new Promise<void>(r=>{unblock=r;});
  const events:string[]=[];
  const first=(async()=>{const release=await acquireStateGate();try{events.push("first-start");await providerWait;events.push("first-commit");}finally{release();}})();
  await Promise.resolve();await Promise.resolve();
  events.push("socket-closed");
  const second=(async()=>{const release=await acquireStateGate();try{events.push("second-commit");}finally{release();}})();
  await Promise.resolve();assert.ok(!events.includes("second-commit"));
  unblock();await Promise.all([first,second]);assert.ok(events.indexOf("first-commit")<events.indexOf("second-commit"));
});
test("an aborted HTTP client cannot release a pending state operation or lose a later mutation",async()=>{
  let row:StateRow={revision:1,envelope:seal(empty(),key),operation_id:randomUUID()};
  const backend={read:()=>({...row}),commit:(r:number,e:string,op:string)=>{assert.equal(r,row.revision);row={revision:r+1,envelope:e,operation_id:op};return {...row};}};
  const shared=store(),originalData=shared.data,originalDurable=shared.durable;
  shared.durable=new DurableState(backend,key,row);shared.data=shared.durable.data();
  let unblock!:()=>void,entered!:()=>void,secondReceived!:()=>void;
  const providerWait=new Promise<void>(r=>{unblock=r;}),firstEntered=new Promise<void>(r=>{entered=r;}),received=new Promise<void>(r=>{secondReceived=r;});
  const events:string[]=[];
  const server=createServer((req,res)=>{
    if(req.url==="/second")secondReceived();
    void withStoreTask(async()=>{
      if(req.url==="/first"){entered();await providerWait;events.push("first");}else events.push("second");
      shared.update(d=>{const id=req.url==="/first"?"first":"second";d.pending_auth[id]={state:id,bank:{name:"Test",country:"DK"},started:new Date().toISOString()};});
      res.end("ok");
    }).catch(()=>res.end("failed"));
  });
  try{
    await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
    const port=(server.address() as import("node:net").AddressInfo).port,controller=new AbortController();
    const first=fetch(`http://127.0.0.1:${port}/first`,{signal:controller.signal}).catch(()=>undefined);
    await firstEntered;controller.abort();await first;
    const second=fetch(`http://127.0.0.1:${port}/second`);await received;assert.deepEqual(events,[]);
    unblock();await (await second).text();assert.deepEqual(events,["first","second"]);
    assert.ok(shared.data.pending_auth.first);assert.ok(shared.data.pending_auth.second);
  }finally{unblock();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));shared.data=originalData;shared.durable=originalDurable;}
});
const seed:Bootstrap={kind:"bankmcp-existing-grants-v1",sessions:[{id:"session",bank:"Test Bank (DK)",accounts:1}],accounts:[{uid:"account",bank:"Test Bank (DK)",currency:"DKK",label:"Saved label"}],watches:[]};
const provider={getSession:async()=>({status:"AUTHORIZED",accounts:["account"],accounts_data:[{uid:"account",identification_hash:"provider-hash"}],aspsp:{name:"Test Bank",country:"DK"},psu_type:"personal",created:"2026-01-01T00:00:00Z",access:{valid_until:"2099-01-01T00:00:00Z"}}),getAccountDetails:async()=>({uid:"account",currency:"DKK",identification_hash:"provider-hash",account_id:{iban:"TEST-ACCOUNT"}})};
test("migration preserves provider session, uid, identity hash, consent expiry and labels",async()=>{
  const state=await recoverGrants(seed,provider);
  assert.equal(state.accounts.account.session_id,"session");assert.equal(state.accounts.account.identification_hash,"provider-hash");
  assert.equal(state.accounts.account.label,"Saved label");assert.equal(state.sessions.session.valid_until,"2099-01-01T00:00:00Z");
});
test("migration refuses missing identity evidence or an incomplete account set",async()=>{
  await assert.rejects(recoverGrants(seed,{...provider,getSession:async()=>({...await provider.getSession(),accounts_data:[]})}),/identit/);
  await assert.rejects(recoverGrants({...seed,accounts:[...seed.accounts,{uid:"missing",bank:"Test Bank (DK)",currency:"DKK"}]},provider),/lose an account/);
  await assert.rejects(recoverGrants(seed,{...provider,getAccountDetails:async()=>({...await provider.getAccountDetails(),identification_hash:"different"})}),/mismatch/);
  await assert.rejects(recoverGrants(seed,{...provider,getSession:async()=>({...await provider.getSession(),accounts_data:[{uid:"account",identification_hash:"provider-hash"},{uid:"account",identification_hash:"conflict"}]})}),/Ambiguous/);
  await assert.rejects(recoverGrants({...seed,watches:[{id:"w",account:"account",rule:{type:"balance_below",amount:1},created:"2026-01-01",active:true,seen:[]}]},provider),/watches require/);
});

