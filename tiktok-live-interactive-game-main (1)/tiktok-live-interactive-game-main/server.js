'use strict';

const TIKTOK_USERNAME = (process.env.TIKTOK_USERNAME || 'stream_account').trim();
const TIKTOK_ROOM_ID = (process.env.TIKTOK_ROOM_ID || '').trim();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admindev';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');

const PORT = process.env.PORT || 3000;

const DAMAGE_PER_DIAMOND = 1;
const POWER_FILL_PER_LIKE = 0.08;
const POWER_FILL_SMALL_GIFT = 4;
const POWER_THRESHOLD = 100;
const POWER_DURATION_MS = 60_000;
const MATCH_DURATION_MS = 5 * 60_000;
const POST_GAME_WAIT_MS = 15_000;
const GIFT_MIN_INTERVAL_MS = 120;
const LIKE_BATCH_MS = 40;
const MAX_LIKES_PER_BATCH = 400;
const GIFT_BATCH_MS = 500;

const BONUS_POOL_RATE = 0.01;
const CRIT_CHANCE = 0.05;
const COMBO_CHAIN_THRESHOLD = 5;
const COMBO_DAMAGE_BONUS = 1.2;
const SUDDEN_DEATH_DAMAGE_MULT = 5;
const VIP_SESSION_DIAMONDS = 4000;
const VIP_FOLLOWER_MIN = 50000;
const AUTO_JOIN_SOLDIER_ENABLED = true;

const KILL_FEED_MIN_DAMAGE = 1200;
const KILL_FEED_MIN_MULT = 25;

const LEADERBOARD_FILE = path.join(__dirname, 'data', 'leaderboard.json');

let gameState = {
  red: { hp: 10000, maxHp: 10000, captain: null },
  blue: { hp: 10000, maxHp: 10000, captain: null },
  running: true,
  winner: null,
  gameStartedAt: Date.now(),
};

let matchDurationMs = MATCH_DURATION_MS;
let bonusPool = 0;
let suddenDeath = false;
let suddenDeathAnnounced = false;
let lastGiftTeam = null;
let comboCount = 0;

const userTeams = new Map();
const teamSpend = { red: new Map(), blue: new Map() };
const teamMatchDamage = { red: new Map(), blue: new Map() };
const lastGiftAt = new Map();
const userLifetimeGifts = new Map();
let lastHitOnTower = { red: null, blue: null };
let lastLikeCount = 0;
let powerBoost = { progress: 0, activeUntil: 0 };
let doubleMultiplierUntil = 0;
let postGameTimer = null;
let tiktokConn = null;
let reconnectTimer = null;
let likeBatchTimer = null;
let pendingLikes = 0;
let last60Announced = false;
const lastWelcomeAt = new Map();
const WELCOME_COOLDOWN_MS = 90_000;
const SPIKER_INTERVAL_MS = 45_000;
const BONUS_DROP_BUCKETS = [1, 2, 5, 10, 50, 100];

const giftBatchQueue = [];
let giftBatchTimer = null;

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function readLeaderboard() {
  try {
    const d = fs.readFileSync(LEADERBOARD_FILE, 'utf8');
    return JSON.parse(d);
  } catch (_) {
    return { dayKey: dayKey(), entries: {} };
  }
}

function writeLeaderboard(lb) {
  fs.mkdirSync(path.dirname(LEADERBOARD_FILE), { recursive: true });
  fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(lb, null, 2), 'utf8');
}

function recordDamage(uid, nickname, avatar, dmg) {
  if (!uid || dmg <= 0) return;
  let lb = readLeaderboard();
  if (lb.dayKey !== dayKey()) {
    lb = { dayKey: dayKey(), entries: {} };
  }
  const e = lb.entries[uid] || { nickname: nickname || 'Player', avatar: avatar || '', damage: 0 };
  e.damage += dmg;
  e.nickname = nickname || e.nickname;
  e.avatar = avatar || e.avatar;
  lb.entries[uid] = e;
  writeLeaderboard(lb);
}

function topLeaderboard(n) {
  const lb = readLeaderboard();
  if (lb.dayKey !== dayKey()) return [];
  return Object.entries(lb.entries)
    .map(([uid, v]) => ({ uid, nickname: v.nickname, damage: v.damage, avatar: v.avatar }))
    .sort((a, b) => b.damage - a.damage)
    .slice(0, n);
}

function addMatchDamage(teamKey, uid, damage, nickname, avatar) {
  if (!uid || damage <= 0) return;
  const m = teamMatchDamage[teamKey];
  const cur = m.get(uid) || { userId: uid, nickname, avatar, damage: 0 };
  cur.damage += damage;
  cur.nickname = nickname || cur.nickname;
  cur.avatar = avatar || cur.avatar;
  m.set(uid, cur);
}

function sumTeamMatchDamage(teamKey) {
  let s = 0;
  for (const [, v] of teamMatchDamage[teamKey]) {
    s += v.damage || 0;
  }
  return Math.floor(s);
}

function teamMatchTotals() {
  return {
    red: sumTeamMatchDamage('red'),
    blue: sumTeamMatchDamage('blue'),
  };
}

function topTeamContributors(teamKey, n) {
  const m = teamMatchDamage[teamKey];
  return [...m.values()]
    .sort((a, b) => b.damage - a.damage)
    .slice(0, n)
    .map((u) => ({
      nickname: u.nickname || 'Player',
      avatar: u.avatar || '',
      damage: Math.floor(u.damage || 0),
    }));
}

function hashTeam(uid) {
  let h = 0;
  const s = String(uid || 'anon');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 2 === 0 ? 'red' : 'blue';
}

function getTeam(uid) {
  if (!userTeams.has(uid)) userTeams.set(uid, hashTeam(uid));
  return userTeams.get(uid);
}

function assignTeamFromChat(uid, text) {
  const t = String(text || '').trim().toLowerCase();
  if (t === '1' || t === 'red') {
    userTeams.set(uid, 'red');
    return true;
  }
  if (t === '2' || t === 'blue') {
    userTeams.set(uid, 'blue');
    return true;
  }
  return false;
}

function pickCaptain(teamKey) {
  const m = teamSpend[teamKey];
  let best = null;
  for (const [, v] of m) {
    if (!best || v.coins > best.coins) best = { ...v };
  }
  return best;
}

function updateCaptains() {
  gameState.red.captain = pickCaptain('red');
  gameState.blue.captain = pickCaptain('blue');
}

function addTeamSpend(teamKey, uid, coins, nickname, avatar) {
  const m = teamSpend[teamKey];
  const cur = m.get(uid) || { userId: uid, nickname, avatar, coins: 0 };
  cur.coins += coins;
  cur.nickname = nickname || cur.nickname;
  cur.avatar = avatar || cur.avatar;
  m.set(uid, cur);
  updateCaptains();
}

function weightedMultiplier(giftDiamondTotal) {
  const w = Math.min(1, giftDiamondTotal / 500);
  const roll = Math.random();
  const biasHigh = 0.15 + w * 0.55;
  if (roll < 0.1 - w * 0.05) return 1;
  if (roll < 0.28) return 2;
  if (roll < 0.48 - w * 0.08) return 5;
  if (roll < 0.72 - w * 0.1) return 10;
  if (roll < 0.92 - w * 0.05 + biasHigh * 0.02) return 50;
  return 100;
}

function shouldNearMiss(giftDiamondTotal) {
  return giftDiamondTotal >= 40 && Math.random() < 0.38;
}

function rollSpin(giftDiamondTotal) {
  const near = shouldNearMiss(giftDiamondTotal);
  let finalM = weightedMultiplier(giftDiamondTotal);
  if (near) {
    const decoys = [100, 100, 50];
    if (finalM >= 50) finalM = [5, 10][Math.floor(Math.random() * 2)];
    return { finalMultiplier: finalM, nearMiss: true, decoys };
  }
  return { finalMultiplier: finalM, nearMiss: false, decoys: [] };
}

function rollSpinTiered(giftDiamondTotal) {
  const spin1 = rollSpin(giftDiamondTotal);
  let m1 = spin1.finalMultiplier;
  let wheelType = 'standard';
  if (giftDiamondTotal <= 1) {
    wheelType = 'rose';
  } else if (giftDiamondTotal >= 100) {
    wheelType = 'wand';
    m1 = Math.max(5, m1);
  }
  return { ...spin1, finalMultiplier: m1, wheelType };
}

function rollSecondSpin(giftDiamondTotal) {
  return weightedMultiplier(giftDiamondTotal * 0.85);
}

function nowPowerMult() {
  return Date.now() < powerBoost.activeUntil ? 2 : 1;
}

function isDoubleMultiplierRound() {
  const t = Date.now();
  if (t < doubleMultiplierUntil) return true;
  const elapsed = t - gameState.gameStartedAt;
  return elapsed >= matchDurationMs - 60_000;
}

function applyDamage(targetTower, damage, attacker) {
  const key = targetTower === 'red' ? 'red' : 'blue';
  const prev = gameState[key].hp;
  const next = Math.max(0, prev - damage);
  gameState[key].hp = next;
  lastHitOnTower[key] = attacker;
  return { prev, next, destroyed: prev > 0 && next <= 0 };
}

function flushLikes(io) {
  if (pendingLikes <= 0) return;
  const n = Math.min(pendingLikes, MAX_LIKES_PER_BATCH);
  pendingLikes -= n;
  powerBoost.progress = Math.min(POWER_THRESHOLD, powerBoost.progress + n * POWER_FILL_PER_LIKE);
  io.emit('likeBurst', { count: n, powerProgress: powerBoost.progress });
  maybeStartPowerMode(io);
}

function maybeStartPowerMode(io) {
  if (powerBoost.progress < POWER_THRESHOLD) return;
  if (Date.now() < powerBoost.activeUntil) return;
  powerBoost.progress = 0;
  powerBoost.activeUntil = Date.now() + POWER_DURATION_MS;
  io.emit('powerMode', {
    active: true,
    until: powerBoost.activeUntil,
    powerProgress: 0,
  });
}

function forcePowerMode(io, durationMs) {
  const d = durationMs || POWER_DURATION_MS;
  powerBoost.progress = 0;
  powerBoost.activeUntil = Date.now() + d;
  io.emit('powerMode', {
    active: true,
    until: powerBoost.activeUntil,
    powerProgress: 0,
  });
}

function scheduleGameReset(io) {
  if (postGameTimer) clearTimeout(postGameTimer);
  postGameTimer = setTimeout(() => {
    resetMatch(io);
  }, POST_GAME_WAIT_MS);
}

function resetMatch(io) {
  if (postGameTimer) {
    clearTimeout(postGameTimer);
    postGameTimer = null;
  }
  last60Announced = false;
  suddenDeath = false;
  suddenDeathAnnounced = false;
  lastGiftTeam = null;
  comboCount = 0;
  gameState = {
    red: { hp: 10000, maxHp: 10000, captain: null },
    blue: { hp: 10000, maxHp: 10000, captain: null },
    running: true,
    winner: null,
    gameStartedAt: Date.now(),
  };
  lastHitOnTower = { red: null, blue: null };
  teamSpend.red.clear();
  teamSpend.blue.clear();
  teamMatchDamage.red.clear();
  teamMatchDamage.blue.clear();
  powerBoost = { progress: 0, activeUntil: 0 };
  doubleMultiplierUntil = 0;
  io.emit('gameReset', {
    gameState,
    powerBoost,
    bonusPool,
    suddenDeath,
    matchDurationMs,
    comboCount,
    leaderboardTop: topLeaderboard(5),
    gameStartedAt: gameState.gameStartedAt,
    teamTop: {
      red: topTeamContributors('red', 3),
      blue: topTeamContributors('blue', 3),
    },
    teamTotals: teamMatchTotals(),
  });
}

function broadcastState(io) {
  io.emit('state', {
    gameState,
    powerBoost,
    bonusPool,
    suddenDeath,
    comboCount,
    matchDurationMs,
    teamTop: {
      red: topTeamContributors('red', 3),
      blue: topTeamContributors('blue', 3),
    },
    teamTotals: teamMatchTotals(),
  });
}

function extractUser(g) {
  const u = g.user || g;
  return {
    userId: String(u.userId || u.user_id || u.uniqueId || ''),
    uniqueId: String(u.uniqueId || u.unique_id || ''),
    nickname: String(u.nickname || u.NickName || 'Player'),
    avatar:
      u.profilePictureUrl ||
      u.profilePicture?.url?.[0] ||
      u.profilePicture?.url ||
      '',
  };
}

function extractFollowerCount(raw) {
  const u = raw.user || raw;
  const n =
    u.followerCount ??
    u.follower_count ??
    raw.followerCount ??
    raw.viewerCount ??
    raw.memberCount;
  if (n == null) return null;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

function extractGiftMoney(g) {
  if (g._mergedDiamonds != null) {
    return Math.max(1, Math.floor(Number(g._mergedDiamonds)));
  }
  const repeat = Math.max(1, parseInt(g.repeatCount, 10) || 1);
  let per = 1;
  if (g.extendedGiftInfo && g.extendedGiftInfo.diamond_count != null) {
    per = Number(g.extendedGiftInfo.diamond_count) || 1;
  } else if (g.giftDetails && g.giftDetails.diamondCount != null) {
    per = Number(g.giftDetails.diamondCount) || 1;
  } else if (g.diamondCount != null) {
    per = Number(g.diamondCount) || 1;
  } else if (g.gift && g.gift.diamond_count != null) {
    per = Number(g.gift.diamond_count) || 1;
  }
  return Math.max(1, Math.floor(per * repeat));
}

function queueGiftForBatch(raw, io) {
  if (!gameState.running) return;
  if (raw.repeatEnd === false) return;
  giftBatchQueue.push(raw);
  if (!giftBatchTimer) {
    giftBatchTimer = setTimeout(() => {
      giftBatchTimer = null;
      flushGiftBatch(io);
    }, GIFT_BATCH_MS);
  }
}

function flushGiftBatch(io) {
  if (giftBatchQueue.length === 0) return;
  const batch = giftBatchQueue.splice(0, giftBatchQueue.length);
  const byUser = new Map();
  for (let i = 0; i < batch.length; i++) {
    const raw = batch[i];
    const user = extractUser(raw);
    const uid = user.uniqueId || user.userId;
    if (!uid) continue;
    const diamonds = extractGiftMoney(raw);
    if (!byUser.has(uid)) {
      byUser.set(uid, { last: raw, sum: 0 });
    }
    const e = byUser.get(uid);
    e.sum += diamonds;
    e.last = raw;
    e.user = user;
  }
  for (const [, v] of byUser) {
    const merged = { ...v.last, _mergedDiamonds: v.sum };
    processGiftInternal(merged, io);
  }
}

function processGiftInternal(raw, io) {
  if (!gameState.running) return;

  const user = extractUser(raw);
  const uid = user.uniqueId || user.userId;
  if (!uid) return;

  const now = Date.now();
  const last = lastGiftAt.get(uid) || 0;
  if (now - last < GIFT_MIN_INTERVAL_MS) return;
  lastGiftAt.set(uid, now);

  const giftDiamondTotal = extractGiftMoney(raw);
  const team = getTeam(uid);
  const targetTower = team === 'red' ? 'blue' : 'red';

  if (lastGiftTeam === team) {
    comboCount += 1;
  } else {
    comboCount = 1;
    lastGiftTeam = team;
  }
  const comboActive = comboCount >= COMBO_CHAIN_THRESHOLD;
  const comboMult = comboActive ? COMBO_DAMAGE_BONUS : 1;

  userLifetimeGifts.set(uid, (userLifetimeGifts.get(uid) || 0) + giftDiamondTotal);

  bonusPool += Math.floor(giftDiamondTotal * BONUS_POOL_RATE);

  const spin1 = rollSpinTiered(giftDiamondTotal);
  let m1 = spin1.finalMultiplier;
  let m2 = 1;
  const doubleBonus = isDoubleMultiplierRound();
  if (doubleBonus) {
    m2 = rollSecondSpin(giftDiamondTotal);
  }

  const powerMult = nowPowerMult();
  const sdMult = suddenDeath ? SUDDEN_DEATH_DAMAGE_MULT : 1;
  const base = giftDiamondTotal * DAMAGE_PER_DIAMOND;
  let damage = Math.floor(base * m1 * m2 * powerMult * sdMult * comboMult);

  const isCrit = Math.random() < CRIT_CHANCE;
  if (isCrit) {
    damage = Math.floor(damage * 2);
  }
  if (damage < 1) damage = 1;

  const { destroyed } = applyDamage(targetTower, damage, {
    ...user,
    team,
    targetTower,
    multiplier: m1 * m2,
  });

  addTeamSpend(team, uid, giftDiamondTotal * (m1 * m2), user.nickname, user.avatar);
  addMatchDamage(team, uid, damage, user.nickname, user.avatar);
  recordDamage(uid, user.nickname, user.avatar, damage);

  powerBoost.progress = Math.min(
    POWER_THRESHOLD,
    powerBoost.progress + Math.min(25, giftDiamondTotal * 0.05 + POWER_FILL_SMALL_GIFT)
  );
  maybeStartPowerMode(io);

  const totalMult = m1 * m2;
  const targetLabel = targetTower === 'red' ? 'RED' : 'BLUE';
  const showKillFeed =
    damage >= KILL_FEED_MIN_DAMAGE ||
    totalMult >= KILL_FEED_MIN_MULT ||
    (!!isCrit && damage >= 500);

  const strikePayload = {
    user,
    team,
    targetTower,
    giftDiamondTotal,
    multiplier1: m1,
    multiplier2: m2,
    totalMultiplier: totalMult,
    nearMiss: spin1.nearMiss,
    nearMissDecoys: spin1.decoys,
    bonusDropBuckets: BONUS_DROP_BUCKETS,
    damage,
    powerModeActive: Date.now() < powerBoost.activeUntil,
    doubleBonus,
    powerMult,
    suddenDeath,
    suddenDeathMult: sdMult,
    comboCount,
    comboActive,
    comboMult,
    isCrit,
    wheelType: spin1.wheelType,
    bonusPool,
    gameState: JSON.parse(JSON.stringify(gameState)),
    caption: `${user.nickname} - thanks, your support has been recorded`,
    teamTop: {
      red: topTeamContributors('red', 3),
      blue: topTeamContributors('blue', 3),
    },
    teamTotals: teamMatchTotals(),
  };
  if (showKillFeed) {
    strikePayload.killFeed = {
      nickname: user.nickname || 'Player',
      targetTower,
      targetLabel,
      damage,
      mult: totalMult,
      isCrit,
    };
  }
  io.emit('giftStrike', strikePayload);

  io.emit('soldier', {
    team,
    user: { ...user, team, nickname: user.nickname },
    fromGift: true,
  });

  if (totalMult >= 50) {
    io.emit('spiker', {
      lines: [
        `${user.nickname} - thank you, that was strong support.`,
      ],
      shake: true,
    });
  }

  broadcastState(io);

  if (destroyed) {
    const winTeam = targetTower === 'blue' ? 'red' : 'blue';
    const mvp = lastHitOnTower[targetTower];
    gameState.running = false;
    gameState.winner = winTeam;

    const jpAmount = Math.floor(bonusPool);
    bonusPool = 0;
    io.emit('bonusPoolWin', {
      amount: jpAmount,
      winner: mvp,
      mvp,
      winTeam,
    });

    io.emit('gameOver', {
      winner: winTeam,
      destroyedTower: targetTower,
      mvp,
      gameState: JSON.parse(JSON.stringify(gameState)),
      bonusPoolAmount: jpAmount,
    });
    scheduleGameReset(io);
  }
}

function handleMemberJoin(raw, io) {
  const user = extractUser(raw);
  const uid = user.uniqueId || user.userId;
  if (!uid) return;
  const now = Date.now();
  const prev = lastWelcomeAt.get(uid) || 0;
  if (now - prev < WELCOME_COOLDOWN_MS) return;
  lastWelcomeAt.set(uid, now);

  const followers = extractFollowerCount(raw);
  const sessionD = userLifetimeGifts.get(uid) || 0;
  const isVip =
    sessionD >= VIP_SESSION_DIAMONDS ||
    (followers != null && followers >= VIP_FOLLOWER_MIN);
  const team = getTeam(uid);

  io.emit('viewerJoin', {
    user,
    team,
    vip: isVip,
    followers,
    sessionDiamonds: sessionD,
  });
  io.emit('viewerJoinEffect', {
    uniqueId: uid,
    nickname: user.nickname,
    profilePictureUrl: user.avatar || '',
    vip: isVip,
  });

  io.emit('teamPick', { user, team });
  if (AUTO_JOIN_SOLDIER_ENABLED) {
    io.emit('soldier', {
      team,
      user: { ...user, team, nickname: user.nickname },
      autoJoin: true,
    });
  }
}

function handleRoomUserSeq(raw, io) {
  const n = raw.viewerCount ?? raw.totalUser ?? raw.total;
  if (n != null && Number.isFinite(Number(n))) {
    io.emit('viewerCount', { count: Number(n) });
  }
}

function handleChat(raw, io) {
  const user = extractUser(raw);
  const uid = user.uniqueId || user.userId;
  if (!uid) return;
  const comment = String(raw.comment || raw.text || '').trim();
  assignTeamFromChat(uid, comment);

  const t = comment.toLowerCase();
  if (t === '1' || t === '2' || t === 'red' || t === 'blue') {
    io.emit('teamPick', { user, team: getTeam(uid) });
  }

  const spawn =
    t === '1' ||
    t === 'red';
  const spawnB = t === '2' || t === 'blue';

  if (spawn) {
    io.emit('soldier', {
      team: 'red',
      user: { ...user, team: 'red', nickname: user.nickname },
    });
  } else if (spawnB) {
    io.emit('soldier', {
      team: 'blue',
      user: { ...user, team: 'blue', nickname: user.nickname },
    });
  }
}

function connectTikTok(io) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (tiktokConn) {
    try {
      tiktokConn.disconnect();
    } catch (_) {}
    tiktokConn = null;
  }

  if (!TIKTOK_USERNAME) {
    const msg =
      'TIKTOK_USERNAME is empty. Check the environment variable or the default username in server.js.';
    console.error('[TikTok]', msg);
    io.emit('tiktokStatus', { ok: false, msg });
    return;
  }

  const conn = new WebcastPushConnection(TIKTOK_USERNAME, {
    enableExtendedGiftInfo: true,
    enableWebsocketUpgrade: true,
    requestPollingIntervalMs: 1000,
  });

  const roomArg = TIKTOK_ROOM_ID ? TIKTOK_ROOM_ID : undefined;

  conn
    .connect(roomArg)
    .then(() => {
      io.emit('tiktokStatus', { ok: true, msg: 'TikTok live connection is ready.' });
    })
    .catch((err) => {
      const text = String(err && err.message ? err.message : err);
      const hint =
        /user_not_found|19881007/i.test(text)
          ? ' Check the username (without @) and make sure the livestream is active. If needed, try TIKTOK_ROOM_ID.'
          : '';
      io.emit('tiktokStatus', {
        ok: false,
        msg: text + hint,
      });
      const delay = /user_not_found|19881007|YOUR_TIKTOK/i.test(text) ? 60_000 : 5000;
      reconnectTimer = setTimeout(() => connectTikTok(io), delay);
    });

  conn.on('gift', (p) => queueGiftForBatch(p, io));

  conn.on('chat', (p) => handleChat(p, io));

  conn.on('member', (p) => handleMemberJoin(p, io));

  conn.on('roomUser', (p) => handleRoomUserSeq(p, io));

  conn.on('like', (p) => {
    const total = p.totalLikeCount != null ? Number(p.totalLikeCount) : null;
    if (total == null || !Number.isFinite(total)) {
      pendingLikes += 1;
    } else {
      const delta = Math.max(0, total - lastLikeCount);
      lastLikeCount = total;
      pendingLikes += Math.max(1, delta);
    }
    if (!likeBatchTimer) {
      likeBatchTimer = setTimeout(() => {
        likeBatchTimer = null;
        flushLikes(io);
      }, LIKE_BATCH_MS);
    }
  });

  conn.on('streamEnd', () => {
    io.emit('tiktokStatus', { ok: false, msg: 'Stream ended. Reconnecting...' });
    reconnectTimer = setTimeout(() => connectTikTok(io), 8000);
  });

  conn.on('error', (err) => {
    io.emit('tiktokStatus', {
      ok: false,
      msg: `Error: ${String(err && err.message ? err.message : err)}`,
    });
  });

  tiktokConn = conn;
}

function spikerTick(io) {
  const r = gameState.red.hp / gameState.red.maxHp;
  const b = gameState.blue.hp / gameState.blue.maxHp;
  const msgs = [];

  if (r < 0.5 && b > r) {
    msgs.push('Red team is behind, blue is ahead.');
  } else if (b < 0.5 && r > b) {
    msgs.push('Blue team is behind, red is ahead.');
  }

  if (b < 0.1) {
    msgs.push('Blue tower is weak - send team support.');
  }
  if (r < 0.1) {
    msgs.push('Red tower is weak - send team support.');
  }

  if (msgs.length === 0) {
    const pool = [
      'Red and blue interactive show - join your team.',
      'When the chain fills, your team gets extra power.',
      'Power bar is filling - support with likes.',
    ];
    msgs.push(pool[Math.floor(Math.random() * pool.length)]);
  }

  io.emit('spiker', {
    lines: msgs,
    shake: true,
    doubleMultiplierUntil,
  });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/leaderboard', (req, res) => {
  res.json({ ok: true, top: topLeaderboard(10), dayKey: dayKey() });
});

function adminAuth(req) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : req.body?.token;
  return tok === ADMIN_TOKEN;
}

app.post('/admin/api', (req, res) => {
  if (!adminAuth(req)) {
    return res.status(403).json({ ok: false, error: 'Unauthorized' });
  }
  const action = req.body && req.body.action;
  try {
    if (action === 'extendMatch') {
      const ms = Number(req.body.ms) || 60_000;
      matchDurationMs = Math.max(60_000, matchDurationMs + ms);
      io.emit('matchConfig', { matchDurationMs });
      return res.json({ ok: true, matchDurationMs });
    }
    if (action === 'spawnBot') {
      const team = req.body.team === 'blue' ? 'blue' : 'red';
      const nickname = String(req.body.name || 'Support Bot').slice(0, 24);
      io.emit('soldier', {
        team,
        user: {
          nickname,
          uniqueId: 'bot_' + Date.now(),
          avatar: '',
          team,
        },
        fromGift: false,
        bot: true,
      });
      return res.json({ ok: true });
    }
    if (action === 'powerMode') {
      const ms = Number(req.body.ms) || POWER_DURATION_MS;
      forcePowerMode(io, ms);
      return res.json({ ok: true, until: powerBoost.activeUntil });
    }
    if (action === 'suddenDeath') {
      suddenDeath = true;
      io.emit('suddenDeath', { active: true, damageMult: SUDDEN_DEATH_DAMAGE_MULT });
      return res.json({ ok: true });
    }
    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

io.on('connection', (socket) => {
  socket.emit('init', {
    gameState: JSON.parse(JSON.stringify(gameState)),
    powerBoost,
    doubleMultiplierUntil,
    matchDurationMs,
    gameStartedAt: gameState.gameStartedAt,
    bonusPool,
    suddenDeath,
    comboCount,
    leaderboardTop: topLeaderboard(5),
    teamTop: {
      red: topTeamContributors('red', 3),
      blue: topTeamContributors('blue', 3),
    },
    teamTotals: teamMatchTotals(),
  });

  socket.emit('tiktokStatus', {
    ok: tiktokConn != null,
    msg: tiktokConn ? 'Connected.' : 'Connecting...',
  });
});

setInterval(() => spikerTick(io), SPIKER_INTERVAL_MS);

setInterval(() => flushLikes(io), 200);

setInterval(() => {
  if (!gameState.running) return;
  const left = matchDurationMs - (Date.now() - gameState.gameStartedAt);
  if (left <= 60_000 && left > 0 && !last60Announced) {
    last60Announced = true;
    doubleMultiplierUntil = Date.now() + 60_000;
    io.emit('spiker', {
      lines: ['Final 60 seconds - support applies in two steps.'],
      shake: true,
      doubleMultiplierUntil,
    });
  }
}, 2000);

setInterval(() => {
  if (!gameState.running || suddenDeath) return;
  const elapsed = Date.now() - gameState.gameStartedAt;
  if (elapsed < matchDurationMs) return;
  if (gameState.red.hp <= 0 || gameState.blue.hp <= 0) return;
  if (suddenDeathAnnounced) return;
  suddenDeath = true;
  suddenDeathAnnounced = true;
  io.emit('suddenDeath', { active: true, damageMult: SUDDEN_DEATH_DAMAGE_MULT });
  io.emit('spiker', {
    lines: ['Time is up - final round, game pace increased.'],
    shake: true,
  });
  broadcastState(io);
}, 2000);

server.listen(PORT, () => {
  console.log(`Tower battle server running at http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin (token: ADMIN_TOKEN from env or admindev)`);
  if (TIKTOK_USERNAME) {
    console.log(
      `[TikTok] Account to connect: @${TIKTOK_USERNAME}` +
        (TIKTOK_ROOM_ID ? ` (sabit room_id: ${TIKTOK_ROOM_ID.slice(0, 10)}…)` : '')
    );
  }
  connectTikTok(io);
});
