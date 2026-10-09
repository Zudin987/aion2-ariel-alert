import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { parseStatus, runMonitor, STATE_KEY } from '../src/index.mjs';

const now = Date.UTC(2026, 9, 8, 9, 20, 0);
function page({blocked=true, online='Online', name='Ariel', faction='Elyos', favorites=false, legend=true}={}) {
  const heads = (favorites ? '<th>Favorites</th>' : '') +
    '<th>Status</th><th>Server</th><th>Faction</th><th>Region</th><th>Population</th>';
  const icon = blocked ? '<svg aria-label="Character creation blocked"></svg>' : '';
  return '<html><div title="Oct 8, 2026, 09:19:14 AM UTC">Updated 55 seconds ago</div>' +
    (legend ? '<div>Character creation blocked legend</div>' : '') +
    '<table><thead><tr>' + heads + '</tr></thead><tbody><tr>' +
    (favorites ? '<td>☆</td>' : '') + '<td>' + online +
    '</td><td><span class="font-medium text-slate-100">' + name + '</span>' + icon +
    '</td><td>' + faction + '</td><td>Asia</td><td>51%</td></tr></tbody></table></html>';
}
function mock(initial=null, html=page()) {
  let state=initial;
  let sourceCalls=0;
  const sent=[];
  const env={
    STATE:{
      async get(key) { assert.equal(key,STATE_KEY); return state; },
      async put(key,body) { assert.equal(key,STATE_KEY); state=JSON.parse(body); }
    },
    DISCORD_WEBHOOK_URL:'https://discord.com/api/webhooks/123456789012345678/token'
  };
  async function fetchImpl(url,init) {
    if (String(url).includes('discord.com/api/webhooks')) {
      sent.push(JSON.parse(init.body));
      return {ok:true,status:204};
    }
    sourceCalls++;
    return {ok:true,status:200,headers:new Headers({'content-type':'text/html'}),text:async()=>html};
  }
  return {env,fetchImpl,sent,getState:()=>state,getSourceCalls:()=>sourceCalls};
}

test('blocked and open in both old and Favorites-column layouts',()=>{
  for(const favorites of [false,true]) for(const blocked of [false,true]) {
    assert.equal(parseStatus(page({favorites,blocked}),now).creation,blocked?'blocked':'open');
  }
});
test('page legend does not make unlocked Ariel seem blocked',()=>{
  assert.equal(parseStatus(page({blocked:false}),now).creation,'open');
});
test('offline cannot mean unlocked',()=>{
  assert.equal(parseStatus(page({blocked:false,online:'Maintenance'}),now).creation,'unavailable');
});
test('wrong target server or faction is rejected',()=>{
  assert.throws(()=>parseStatus(page({name:'Siel'}),now),/Expected exactly one/);
  assert.throws(()=>parseStatus(page({faction:'Asmodian'}),now),/Expected exactly one/);
});
test('stale or incompatible markup fails closed',()=>{
  assert.throws(()=>parseStatus(page(),now+35*60_000),/stale/);
  assert.throws(()=>parseStatus(page().replace('<th>Region</th>','<th>Area</th>'),now),/Expected exactly one/);
  assert.throws(()=>parseStatus(page({blocked:false,legend:false}),now),/Missing known/);
});
test('repeated blocked check records health but sends nothing',async()=>{
  const m=mock({creation:'blocked'});
  await runMonitor(m.env,{fetchImpl:m.fetchImpl,now});
  assert.equal(m.sent.length,0);
  assert.equal(m.getState().creation,'blocked');
  assert.ok(m.getState().lastCheckedAt);
});
test('open status requires confirmation and only alerts once',async()=>{
  const m=mock(null,page({blocked:false,favorites:true}));
  await runMonitor(m.env,{fetchImpl:m.fetchImpl,now});
  assert.equal(m.getSourceCalls(),2);
  assert.equal(m.sent.length,1);
  assert.deepEqual(m.sent[0].allowed_mentions.parse,[]);
  await runMonitor(m.env,{fetchImpl:m.fetchImpl,now:now+5*60_000});
  assert.equal(m.sent.length,1);
  assert.equal(m.getState().creation,'open');
});
test('blocked-to-open transition sends one alert',async()=>{
  const m=mock({creation:'blocked'},page({blocked:false}));
  await runMonitor(m.env,{fetchImpl:m.fetchImpl,now});
  assert.equal(m.sent.length,1);
});
test('missing Discord secret does not advance old blocked state',async()=>{
  const m=mock({creation:'blocked'},page({blocked:false}));
  m.env.DISCORD_WEBHOOK_URL='';
  await assert.rejects(runMonitor(m.env,{fetchImpl:m.fetchImpl,now}),/DISCORD_WEBHOOK_URL/);
  assert.equal(m.getState().creation,'blocked');
  assert.equal(m.sent.length,0);
  assert.match(m.getState().lastError,/DISCORD_WEBHOOK_URL/);
});
test('broken source does not send false alert',async()=>{
  const m=mock({creation:'blocked'},'<html>Down</html>');
  await assert.rejects(runMonitor(m.env,{fetchImpl:m.fetchImpl,now}));
  assert.equal(m.getState().creation,'blocked');
  assert.equal(m.sent.length,0);
});
test('maintenance preserves prior creation state',async()=>{
  const m=mock({creation:'blocked'},page({blocked:false,online:'Maintenance'}));
  await runMonitor(m.env,{fetchImpl:m.fetchImpl,now});
  assert.equal(m.getState().creation,'blocked');
  assert.equal(m.getState().lastObservation.creation,'unavailable');
});
test('public health endpoint reads KV only',async()=>{
  const m=mock({creation:'blocked',lastCheckedAt:'2026-10-08T09:20:00.000Z'});
  const response=await worker.fetch(new Request('https://example.com/health'),m.env);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.savedCreationStatus,'blocked');
  assert.equal(body.lastCheckedAt,'2026-10-08T09:20:00.000Z');
  assert.equal(m.getSourceCalls(),0);
  assert.equal(m.sent.length,0);
});
