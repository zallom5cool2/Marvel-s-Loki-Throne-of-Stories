'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');

const PLAYER_LIMIT = 3;
const ACCESS_CODE = process.env.AEGIS_ACCESS_CODE || '2043';
const HEROES = new Set(['iron', 'cap', 'thor']);
const ROSTERS = {
  iron: [
    ['IRON MONGER', 70, 1.7, 14], ['WHIPLASH', 97, 1.1, 12],
    ['ALDRICH KILLIAN', 134, 1.25, 15], ['ULTRON', 176, 1.15, 16], ['THANOS', 238, 1.55, 20],
  ],
  cap: [
    ['RED SKULL', 75, 1.6, 13], ['WINTER SOLDIER', 97, 1.05, 14],
    ['CROSSBONES', 134, 1.2, 16], ['ARNIM ZOLA', 181, 1.05, 16], ['BARON ZEMO', 223, 1.45, 18],
  ],
  thor: [
    ['THE DESTROYER', 80, 1.8, 15], ['LOKI', 107, 1.05, 14],
    ['MALEKITH', 144, 1.2, 16], ['HELA', 186, 1.05, 18], ['GORR THE GOD BUTCHER', 233, 1.35, 20],
  ],
};
const MAX_HP = { iron: 100, cap: 125, thor: 145 };
const HIT_DAMAGE = { iron: 12, cap: 15, thor: 20 };
const ABILITY_COOLDOWN_MS = { attack: 260, special: 5000, shield: 9000 };
const rooms = new Map();

function cleanName(value) {
  return String(value || 'Avenger').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18) || 'Avenger';
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function rosterFor(room) { return ROSTERS[room.campaignHero] || ROSTERS.iron; }
function currentBoss(room) {
  const [name, maxHp, rate, damage] = rosterFor(room)[room.mission];
  return { name, hp: room.bossHp, maxHp, rate, damage, index: room.mission + 1, total: 5 };
}

function roomSnapshot(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    finished: room.finished,
    failed: room.failed,
    campaignHero: room.campaignHero,
    mission: room.mission,
    defeated: [...room.defeated],
    boss: room.started && !room.finished ? currentBoss(room) : null,
    players: [...room.players.values()].map(({ id, name, hero, ready, x, y, z, hp, maxHp, shieldUntil }) => ({
      id, name, hero, ready, x, y, z, hp, maxHp, blocking: shieldUntil > Date.now(),
    })),
  };
}

function broadcast(room, message) {
  const packet = JSON.stringify(message);
  for (const player of room.players.values()) {
    if (player.socket.readyState === WebSocket.OPEN) player.socket.send(packet);
  }
}

function publish(room) { broadcast(room, { type: 'state', state: roomSnapshot(room) }); }

function issueBossAttack(room, now) {
  if (!room.started || room.finished || !room.players.size) return;
  const boss = currentBoss(room);
  const alive = [...room.players.values()].filter(p => p.hp > 0);
  if (!alive.length) return;
  const target = alive[Math.floor(Math.random() * alive.length)];
  if (target.shieldUntil <= now) target.hp = Math.max(0, target.hp - boss.damage);
  broadcast(room, { type: 'boss_attack', targetId: target.id, damage: target.shieldUntil > now ? 0 : boss.damage, warning: boss.name });
  if (![...room.players.values()].some(p => p.hp > 0)) {
    room.failed = true;room.finished = true;
    broadcast(room, { type: 'campaign_failed', defeated: [...room.defeated] });
  }
}

function handleMessage(room, player, packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return;
  const now = Date.now();
  switch (packet.type) {
    case 'select': {
      if (!HEROES.has(packet.hero)) return send(player.socket, { type: 'error', code: 'BAD_CHARACTER', message: 'Choose Iron Man, Captain America, or Thor.' });
      if (room.started) return send(player.socket, { type: 'error', code: 'ALREADY_STARTED', message: 'Character selection is locked after the mission starts.' });
      player.hero = packet.hero;
      player.maxHp = MAX_HP[player.hero];
      player.hp = player.maxHp;
      player.ready = false;
      publish(room);
      break;
    }
    case 'ready':
      if (room.started) return;
      player.ready = Boolean(packet.ready);
      publish(room);
      break;
    case 'start': {
      if (player.id !== room.hostId) return send(player.socket, { type: 'error', code: 'HOST_ONLY', message: 'Only the room host can start the mission.' });
      if (room.started) return;
      const members = [...room.players.values()];
      if (!members.length || members.some(p => !p.ready)) return send(player.socket, { type: 'error', code: 'NOT_READY', message: 'Every connected player must be ready.' });
      room.campaignHero = player.hero;
      room.started = true;
      room.mission = 0;
      room.failed = false;
      room.bossHp = rosterFor(room)[0][1];
      room.nextBossAttack = now + Math.max(1200, rosterFor(room)[0][2] * 1000);
      room.nextBossWarning = room.nextBossAttack - 650;
      for (const member of members) member.hp = member.maxHp;
      publish(room);
      broadcast(room, { type: 'mission_start', mission: 1, boss: currentBoss(room) });
      break;
    }
    case 'move': {
      if (!Number.isFinite(packet.x) || !Number.isFinite(packet.y)) return;
      player.x = Math.max(-22, Math.min(22, packet.x));
      player.y = Math.max(3, Math.min(48, packet.y));
      if (Number.isFinite(packet.z)) player.z = Math.max(-10_000_000, Math.min(0, packet.z));
      break;
    }
    case 'attack': {
      if (!room.started || room.finished || player.hp <= 0) return;
      const ability = ['attack', 'special', 'shield', 'heal'].includes(packet.ability) ? packet.ability : 'attack';
      if (ability === 'heal') {
        const cooldown = 12000;
        if (now - (player.cooldowns.heal || 0) < cooldown || player.hp >= player.maxHp) return;
        player.cooldowns.heal = now;player.hp = Math.min(player.maxHp, player.hp + 30);
        broadcast(room, { type: 'healed', playerId: player.id, amount: 30 });publish(room);return;
      }
      const cooldown = ABILITY_COOLDOWN_MS[ability];
      if (now - (player.cooldowns[ability] || 0) < cooldown) return;
      player.cooldowns[ability] = now;
      if (ability === 'shield') {
        if (player.hero === 'cap' || player.hero === 'thor') player.shieldUntil = now + (player.hero === 'cap' ? 3200 : 2200);
        else return send(player.socket, { type: 'error', code: 'ABILITY_UNAVAILABLE', message: 'This character does not have a shield guard.' });
        broadcast(room, { type: 'shield', playerId: player.id, duration: player.shieldUntil - now });
      } else {
        const damage = HIT_DAMAGE[player.hero] * (ability === 'special' ? 3 : 1);
        room.bossHp = Math.max(0, room.bossHp - damage);
        broadcast(room, { type: 'hit', playerId: player.id, damage, bossHp: room.bossHp });
        if (room.bossHp === 0) {
          const defeated = currentBoss(room).name;
          room.defeated.push(defeated);
          room.mission += 1;
          for (const member of room.players.values()) member.hp = Math.min(member.maxHp, member.hp + 30);
          if (room.mission >= rosterFor(room).length) {
            room.finished = true;
            broadcast(room, { type: 'campaign_complete', defeated: [...room.defeated] });
          } else {
            room.bossHp = rosterFor(room)[room.mission][1];
            room.nextBossAttack = now + Math.max(1200, rosterFor(room)[room.mission][2] * 1000);
            room.nextBossWarning = room.nextBossAttack - 650;
            broadcast(room, { type: 'mission_complete', defeated, nextMission: room.mission + 1 });
          }
        }
      }
      publish(room);
      break;
    }
    case 'end_room':
      if (player.id !== room.hostId) return send(player.socket, { type: 'error', code: 'HOST_ONLY', message: 'Only the host can end the room.' });
      for (const member of room.players.values()) send(member.socket, { type: 'room_closed', message: 'The host ended this room.' });
      for (const member of room.players.values()) member.socket.close(1000, 'Host ended room');
      rooms.delete(room.code);
      break;
    default:
      break;
  }
}

function makePlayer(socket, name, hero) {
  const selectedHero = HEROES.has(hero) ? hero : 'iron';
  return { id: crypto.randomUUID(), socket, name: cleanName(name), hero: selectedHero, ready: false,
    x: 0, y: 18, z: 0, maxHp: MAX_HP[selectedHero], hp: MAX_HP[selectedHero], shieldUntil: 0, cooldowns: Object.create(null) };
}

function createAegisServer({ port = Number(process.env.PORT) || 8787, host = process.env.HOST || '0.0.0.0' } = {}) {
  const httpServer = http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('ok\n');
      return;
    }
    if (pathname !== '/' && pathname !== '/index.html') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  });
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 4096, perMessageDeflate: false });
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.started && !room.finished && now >= room.nextBossAttack) {
        issueBossAttack(room, now);
        room.nextBossAttack = now + Math.max(1200, currentBoss(room).rate * 1000);
        room.nextBossWarning = room.nextBossAttack - 650;
      }
      if (room.started && !room.finished && now >= room.nextBossWarning) {
        broadcast(room, { type: 'boss_warning', boss: currentBoss(room).name, in: 650 });
        room.nextBossWarning = Infinity;
      }
      if (room.started) publish(room);
    }
  }, 50);
  heartbeat.unref();

  wss.on('connection', socket => {
    let currentRoom = null;
    let currentPlayer = null;
    socket.on('message', raw => {
      let packet;
      try { packet = JSON.parse(raw.toString()); }
      catch { return send(socket, { type: 'error', code: 'BAD_JSON', message: 'That message was not valid JSON.' }); }
      if (!currentRoom) {
        const name = cleanName(packet.name);
        const hero = HEROES.has(packet.hero) ? packet.hero : 'iron';
        if (packet.type === 'create') {
          if (String(packet.pin || '') !== ACCESS_CODE) return send(socket, { type: 'error', code: 'BAD_ACCESS_CODE', message: 'Incorrect four-digit access code.' });
          let code;
          do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
          const player = makePlayer(socket, name, hero);
          const room = { code, hostId: player.id, players: new Map([[player.id, player]]), campaignHero: hero,
            started: false, finished: false, failed: false, mission: 0, bossHp: 0, defeated: [], nextBossAttack: 0, nextBossWarning: 0 };
          rooms.set(code, room);currentRoom=room;currentPlayer=player;
          send(socket, { type: 'room_created', playerId: player.id, state: roomSnapshot(room) });
          return;
        }
        if (packet.type === 'join') {
          if (String(packet.pin || '') !== ACCESS_CODE) return send(socket, { type: 'error', code: 'BAD_ACCESS_CODE', message: 'Incorrect four-digit access code.' });
          const code = String(packet.code || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
          const room = rooms.get(code);
          if (!room) return send(socket, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'No room matches that code.' });
          if (room.players.size >= PLAYER_LIMIT) return send(socket, { type: 'error', code: 'ROOM_FULL', message: 'This room already has three players.' });
          if (room.started || room.finished) return send(socket, { type: 'error', code: 'ROOM_STARTED', message: 'This room has already started.' });
          const player = makePlayer(socket, name, hero);
          room.players.set(player.id, player);currentRoom=room;currentPlayer=player;
          send(socket, { type: 'joined', playerId: player.id, state: roomSnapshot(room) });
          publish(room);
          return;
        }
        return send(socket, { type: 'error', code: 'ROOM_ACTION_REQUIRED', message: 'Create a room or join with a room code first.' });
      }
      handleMessage(currentRoom, currentPlayer, packet);
    });
    socket.on('close', () => {
      if (!currentRoom || !currentPlayer) return;
      const room = currentRoom;
      room.players.delete(currentPlayer.id);
      if (currentPlayer.id === room.hostId) {
        for (const player of room.players.values()) {
          send(player.socket, { type: 'host_left', message: 'The host disconnected. This room is closed.' });
          player.socket.close(1012, 'Host disconnected');
        }
        rooms.delete(room.code);
      } else {
        broadcast(room, { type: 'player_left', playerId: currentPlayer.id, name: currentPlayer.name });
        publish(room);
      }
    });
  });
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      resolve({ httpServer, wss, port: httpServer.address().port, close: () => new Promise(done => {
        clearInterval(heartbeat);for (const room of rooms.values()) for (const p of room.players.values()) p.socket.terminate();
        rooms.clear();wss.close(()=>httpServer.close(done));
      }) });
    });
  });
}

if (require.main === module) {
  createAegisServer().then(({ port }) => console.log(`Avengers Protocol server listening on ${port}`))
    .catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { createAegisServer, rooms, ROSTERS, PLAYER_LIMIT };
