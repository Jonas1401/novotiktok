'use strict';

const TIKTOK_USERNAME = (process.env.TIKTOK_USERNAME || '').trim();
const TIKTOK_ROOM_ID = (process.env.TIKTOK_ROOM_ID || '').trim();

const DEFAULT_ADMIN_TOKEN = 'admindev';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || DEFAULT_ADMIN_TOKEN;
const IS_DEFAULT_ADMIN_TOKEN = ADMIN_TOKEN === DEFAULT_ADMIN_TOKEN;

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

// tiktok-live-connector 2.x is the maintained release. Its `/legacy` entry point exports the
// same `WebcastPushConnection` class as 1.x, so the rest of this file works unchanged.
// 1.x (which this project used to pin) stopped tracking TikTok's protocol in mid-2024.
// 2.x is ESM-only, and `require()` of an ESM module fails before Node 20.19 / 22.12, so we
// load it with a dynamic import() and fall back to "no TikTok" mode if anything goes wrong.
let WebcastPushConnection = null;
let connectorLoadError = null;
const connectorReady = (async () => {
  try {
    const mod = await import('tiktok-live-connector/legacy');
    WebcastPushConnection = mod.WebcastPushConnection || null;
  } catch (legacyErr) {
    if (legacyErr && legacyErr.code !== 'ERR_MODULE_NOT_FOUND') connectorLoadError = legacyErr;
  }
  if (!WebcastPushConnection) {
    try {
      const mod = await import('tiktok-live-connector');
      WebcastPushConnection = mod.WebcastPushConnection || null;
    } catch (err) {
      connectorLoadError = connectorLoadError || err;
    }
  }
})();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

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

const LEADERBOARD_FILE =
  process.env.LEADERBOARD_FILE || path.join(__dirname, 'data', 'leaderboard.json');

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
let currentTiktokStatus = { ok: false, msg: 'Not connected yet.' };
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

let leaderboardCache = null;
let leaderboardFlushTimer = null;
let leaderboardWriteWarned = false;
const LEADERBOARD_FLUSH_MS = 1000;

function readLeaderboard() {
  if (leaderboardCache && leaderboardCache.dayKey === dayKey()) return leaderboardCache;

  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
  } catch (_) {
    parsed = null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !parsed.entries ||
    typeof parsed.entries !== 'object' ||
    parsed.dayKey !== dayKey()
  ) {
    parsed = { dayKey: dayKey(), entries: {} };
  }
  leaderboardCache = parsed;
  return parsed;
}

// Atomic write: a crash mid-write can never truncate the existing leaderboard file.
// Non-fatal: a read-only filesystem degrades to "scores are not persisted" rather than
// taking the stream down on the first gift.
function writeLeaderboard(lb) {
  const tmp = `${LEADERBOARD_FILE}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(LEADERBOARD_FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(lb, null, 2), 'utf8');
    fs.renameSync(tmp, LEADERBOARD_FILE);
  } catch (err) {
    if (!leaderboardWriteWarned) {
      leaderboardWriteWarned = true;
      console.warn(
        `[leaderboard] Could not persist to ${LEADERBOARD_FILE} (${err.code || err.message}). ` +
          'Playback continues, but scores will not survive a restart. ' +
          'Point LEADERBOARD_FILE at a writable path or mount a volume.'
      );
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_) {}
  }
}

// Damage arrives in bursts, so coalesce disk writes instead of rewriting the JSON
// file on every single gift.
function scheduleLeaderboardFlush() {
  if (leaderboardFlushTimer) return;
  leaderboardFlushTimer = setTimeout(() => {
    leaderboardFlushTimer = null;
    if (leaderboardCache) writeLeaderboard(leaderboardCache);
  }, LEADERBOARD_FLUSH_MS);
  if (typeof leaderboardFlushTimer.unref === 'function') leaderboardFlushTimer.unref();
}

function flushLeaderboardNow() {
  if (leaderboardFlushTimer) {
    clearTimeout(leaderboardFlushTimer);
    leaderboardFlushTimer = null;
  }
  if (leaderboardCache) writeLeaderboard(leaderboardCache);
}

function recordDamage(uid, nickname, avatar, dmg) {
  if (!uid || dmg <= 0) return;
  const lb = readLeaderboard();
  const e = lb.entries[uid] || { nickname: nickname || 'Player', avatar: avatar || '', damage: 0 };
  e.damage += dmg;
  e.nickname = nickname || e.nickname;
  e.avatar = avatar || e.avatar;
  lb.entries[uid] = e;
  scheduleLeaderboardFlush();
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

// tiktok-live-connector 2.x emits `{ info, exception }` on its "error" event rather than a
// plain Error, which is why naive stringification shows "[object Object]".
function errorText(err) {
  if (err == null) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (typeof err.info === 'string' && err.info) return err.info;
  if (typeof err.message === 'string' && err.message) return err.message;
  if (err.exception && typeof err.exception.message === 'string' && err.exception.message) {
    return err.exception.message;
  }
  try {
    const s = JSON.stringify(err);
    if (s && s !== '{}') return s;
  } catch (_) {}
  return String(err);
}

function setTiktokStatus(io, status) {
  currentTiktokStatus = status;
  io.emit('tiktokStatus', status);
}

// Builds a viewer object for the /admin/api "simulate*" test actions.
function demoUser(body) {
  const uid = String(body.uniqueId || `demo_${Math.floor(Math.random() * 1e6)}`);
  return {
    uniqueId: uid,
    userId: uid,
    nickname: String(body.nickname || uid).slice(0, 24),
    avatar: String(body.avatar || ''),
  };
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

async function connectTikTok(io) {
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

  await connectorReady;

  if (!WebcastPushConnection) {
    const detail = connectorLoadError ? ` (${connectorLoadError.message})` : '';
    const msg =
      `tiktok-live-connector could not be loaded${detail}. TikTok events are disabled; ` +
      'the game and the admin panel still work. Run "npm install" and restart to enable them.';
    console.error('[TikTok]', msg);
    setTiktokStatus(io, { ok: false, msg, demo: true });
    return;
  }

  if (!TIKTOK_USERNAME) {
    const msg =
      'TIKTOK_USERNAME is not set, so the game runs without a TikTok connection. ' +
      'Set TIKTOK_USERNAME (or TIKTOK_ROOM_ID) to receive live events.';
    console.warn('[TikTok]', msg);
    setTiktokStatus(io, { ok: false, msg, demo: true });
    return;
  }

  const conn = new WebcastPushConnection(TIKTOK_USERNAME, {
    enableExtendedGiftInfo: true,
    enableWebsocketUpgrade: true,
    requestPollingIntervalMs: 1000,
  });

  const roomArg = TIKTOK_ROOM_ID ? TIKTOK_ROOM_ID : undefined;

  setTiktokStatus(io, { ok: false, msg: `Connecting to @${TIKTOK_USERNAME}...` });

  conn
    .connect(roomArg)
    .then(() => {
      console.log(`[TikTok] Connected to @${TIKTOK_USERNAME}.`);
      setTiktokStatus(io, { ok: true, msg: `Connected to @${TIKTOK_USERNAME}.` });
    })
    .catch((err) => {
      const text = errorText(err);
      const isMissingOrOffline = /user_not_found|19881007|offline|not live|retrieve Room ID/i.test(
        text
      );
      const hint = isMissingOrOffline
        ? ' Check the username (no leading @) and make sure you are actually live. ' +
          'You can also pass TIKTOK_ROOM_ID directly.'
        : '';
      console.warn(`[TikTok] ${text}${hint}`);
      setTiktokStatus(io, { ok: false, msg: text + hint });
      const delay = isMissingOrOffline ? 60_000 : 5000;
      reconnectTimer = setTimeout(() => {
        connectTikTok(io).catch(() => {});
      }, delay);
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
    setTiktokStatus(io, { ok: false, msg: 'Stream ended. Reconnecting...' });
    reconnectTimer = setTimeout(() => {
      connectTikTok(io).catch(() => {});
    }, 8000);
  });

  conn.on('error', (err) => {
    setTiktokStatus(io, { ok: false, msg: errorText(err) });
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

// Used by container hosts (Render/Railway/Fly/Docker) to decide when the app is ready.
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    matchRunning: gameState.running,
    tiktokConnected: currentTiktokStatus.ok === true,
    tiktok: currentTiktokStatus.msg,
    winner: gameState.winner,
  });
});

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function adminAuth(req) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : req.body?.token;
  if (!tok) return false;
  return safeEqual(tok, ADMIN_TOKEN);
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
    if (action === 'resetMatch') {
      resetMatch(io);
      return res.json({ ok: true });
    }

    // The actions below inject synthetic viewer events through the exact same code path the
    // TikTok connector uses. They let you verify the overlay end to end while offline.
    if (action === 'simulateGift') {
      const user = demoUser(req.body);
      lastGiftAt.delete(user.uniqueId);
      processGiftInternal(
        {
          user,
          _mergedDiamonds: Math.max(1, Math.floor(Number(req.body.diamonds) || 10)),
          repeatEnd: true,
        },
        io
      );
      return res.json({ ok: true, simulated: 'gift', user });
    }
    if (action === 'simulateChat') {
      const user = demoUser(req.body);
      handleChat({ user, comment: String(req.body.comment || '1') }, io);
      return res.json({ ok: true, simulated: 'chat', user });
    }
    if (action === 'simulateJoin') {
      const user = demoUser(req.body);
      lastWelcomeAt.delete(user.uniqueId);
      handleMemberJoin({ user, followerCount: Number(req.body.followers) || 0 }, io);
      return res.json({ ok: true, simulated: 'join', user });
    }
    if (action === 'simulateLikes') {
      const n = Math.min(5000, Math.max(1, Math.floor(Number(req.body.count) || 200)));
      pendingLikes += n;
      flushLikes(io);
      return res.json({ ok: true, simulated: 'likes', count: n });
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

  socket.emit('tiktokStatus', currentTiktokStatus);
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

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[fatal] Port ${PORT} is already in use. Set PORT to a free port and restart.`);
  } else {
    console.error('[fatal] Server error:', err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Tower battle server listening on http://${HOST}:${PORT}`);
  console.log(`Game view: /   |   Streamer panel: /admin`);
  if (IS_DEFAULT_ADMIN_TOKEN) {
    console.warn(
      '[security] ADMIN_TOKEN is not set, so /admin/api falls back to the public default ' +
        '"admindev". Set a strong ADMIN_TOKEN before you go live.'
    );
  }
  if (TIKTOK_USERNAME) {
    console.log(
      `[TikTok] Account to connect: @${TIKTOK_USERNAME}` +
        (TIKTOK_ROOM_ID ? ` (fixed room_id: ${TIKTOK_ROOM_ID.slice(0, 10)}…)` : '')
    );
  }
  connectTikTok(io).catch((err) => {
    console.error('[TikTok] Unexpected connection error:', err);
  });
});

function shutdown(signal) {
  console.log(`[shutdown] ${signal} received, closing down...`);
  flushLeaderboardNow();
  for (const t of [reconnectTimer, postGameTimer, likeBatchTimer, giftBatchTimer]) {
    if (t) clearTimeout(t);
  }
  try {
    if (tiktokConn) tiktokConn.disconnect();
  } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A dropped viewer event must never take the stream down mid-match.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
