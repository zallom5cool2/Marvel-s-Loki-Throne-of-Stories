'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createAegisServer } = require('../server');

function messageOf(socket, type, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup();reject(new Error(`Timed out waiting for ${type}`)); }, timeout);
    const onMessage = raw => {
      const packet = JSON.parse(raw.toString());
      if (packet.type === type) { cleanup();resolve(packet); }
    };
    function cleanup() { clearTimeout(timer);socket.off('message', onMessage); }
    socket.on('message', onMessage);
  });
}

function stateMatching(socket, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer=setTimeout(()=>{cleanup();reject(new Error('Timed out waiting for matching room state'))},timeout);
    const onMessage=raw=>{const packet=JSON.parse(raw.toString());if(packet.type==='state'&&predicate(packet.state)){cleanup();resolve(packet.state)}};
    function cleanup(){clearTimeout(timer);socket.off('message',onMessage)}
    socket.on('message',onMessage);
  });
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.once('open', resolve);socket.once('error', reject); });
  return socket;
}

test('rooms enforce access, three-player limit, readiness, and shared movement', async t => {
  const server = await createAegisServer({ port: 0, host: '127.0.0.1' });
  const url = `ws://127.0.0.1:${server.port}`;
  const sockets=[];
  t.after(async () => { for (const socket of sockets) socket.terminate();await server.close(); });
  const bad = await connect(url);sockets.push(bad);
  bad.send(JSON.stringify({ type: 'create', pin: '0000' }));
  assert.equal((await messageOf(bad, 'error')).code, 'BAD_ACCESS_CODE');

  const host = await connect(url);sockets.push(host);
  host.send(JSON.stringify({ type: 'create', pin: '2043', name: 'Host', hero: 'iron' }));
  const created = await messageOf(host, 'room_created');
  assert.match(created.state.code, /^[A-F0-9]{6}$/);

  const guests = [];
  for (let i = 0; i < 2; i++) {
    const guest = await connect(url);guests.push(guest);sockets.push(guest);
    guest.send(JSON.stringify({ type: 'join', pin: '2043', code: created.state.code, name: `Guest ${i}`, hero: i ? 'thor' : 'cap' }));
    await messageOf(guest, 'joined');
  }
  const full = await connect(url);sockets.push(full);
  full.send(JSON.stringify({ type: 'join', pin: '2043', code: created.state.code, name: 'Extra' }));
  assert.equal((await messageOf(full, 'error')).code, 'ROOM_FULL');

  const allReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup();reject(new Error('Ready state did not synchronize')); }, 3000);
    const onMessage = raw => {const packet=JSON.parse(raw.toString());if(packet.type==='state'&&packet.state.players.length===3&&packet.state.players.every(p=>p.ready)){cleanup();resolve()}};
    function cleanup(){clearTimeout(timeout);host.off('message',onMessage)}
    host.on('message',onMessage);
  });
  for (const socket of [host, ...guests]) socket.send(JSON.stringify({ type: 'ready', ready: true }));
  await allReady;
  const start = messageOf(host, 'mission_start');
  host.send(JSON.stringify({ type: 'start' }));
  const mission = await start;
  assert.equal(mission.boss.name, 'IRON MONGER');
  guests[0].send(JSON.stringify({ type: 'move', x: 14, y: 26 }));
  const synced = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup();reject(new Error('Movement did not synchronize')); }, 3000);
    const onMessage = raw => {
      const packet = JSON.parse(raw.toString());
      const player = packet.type === 'state' && packet.state.players.find(p => p.name === 'Guest 0');
      if (player && player.x === 14 && player.y === 26) { cleanup();resolve(player); }
    };
    function cleanup() { clearTimeout(timeout);host.off('message', onMessage); }
    host.on('message', onMessage);
  });
  assert.deepEqual(await synced.then(({ x, y }) => [x, y]), [14, 26]);
  const nextMission=messageOf(host,'mission_complete');
  for(const socket of [host,...guests])socket.send(JSON.stringify({type:'attack',ability:'attack'}));
  await new Promise(resolve=>setTimeout(resolve,320));
  for(const socket of [host,...guests])socket.send(JSON.stringify({type:'attack',ability:'attack'}));
  const completed=await nextMission;
  assert.equal(completed.defeated,'IRON MONGER');
  const nextState=await stateMatching(host,s=>s.boss?.name==='WHIPLASH');
  assert.deepEqual(nextState.defeated,['IRON MONGER']);
  await new Promise(resolve=>setTimeout(resolve,300));
  let acceptedHits=0;const countHit=raw=>{if(JSON.parse(raw.toString()).type==='hit')acceptedHits++};host.on('message',countHit);
  guests[0].send(JSON.stringify({type:'attack',ability:'attack'}));
  guests[0].send(JSON.stringify({type:'attack',ability:'attack'}));
  await new Promise(resolve=>setTimeout(resolve,100));host.off('message',countHit);
  assert.equal(acceptedHits,1,'the server should reject a duplicate attack inside the cooldown window');
});
