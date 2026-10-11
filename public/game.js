(function () {
  'use strict';

  const EMOJI_BULLETS = ['💥', '⚡', '❤️', '🔥', '✨', '🌟', '💫', '🎯'];

  // Same origin by default. When the overlay is hosted separately from the game server
  // (for example a static CDN in front of a container host), set window.GAME_SERVER_URL
  // in index.html to the game server's origin.
  const socket = io(
    typeof window.GAME_SERVER_URL === 'string' && window.GAME_SERVER_URL
      ? window.GAME_SERVER_URL
      : undefined,
    { transports: ['websocket', 'polling'] }
  );

  const stage = document.getElementById('stage');
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d', { alpha: true });
  const giftDropCanvas = document.getElementById('giftDropCanvas');
  const pctx = giftDropCanvas.getContext('2d');

  // Procedural audio engine (public/audio.js) — SFX + music, all synthesized.
  const LTB = typeof window.LTBAudio === 'object' && window.LTBAudio ? window.LTBAudio : null;
  let musicModeState = null;
  let prevPowerOn = null;

  // Keeps the music loop in sync with the match (normal / sudden death / ended).
  function syncMusicMode() {
    if (!LTB) return;
    const m = !gameState.running ? 'ended' : (suddenDeathActive ? 'sd' : 'normal');
    if (m !== musicModeState) {
      musicModeState = m;
      LTB.musicMode(m);
    }
  }

  // Streamers can mute the overlay audio from the admin panel (same-origin
  // localStorage key 'ltbMuted'); the storage event keeps tabs in sync.
  function applyAudioMute() {
    if (!LTB) return;
    let m = false;
    try {
      m = localStorage.getItem('ltbMuted') === '1';
    } catch (e) {}
    LTB.setMuted(m);
  }
  window.addEventListener('storage', function (e) {
    if (e && e.key === 'ltbMuted') applyAudioMute();
  });

  const hpRed = document.getElementById('hpRed');
  const hpBlue = document.getElementById('hpBlue');
  const hpRedGhost = document.getElementById('hpRedGhost');
  const hpBlueGhost = document.getElementById('hpBlueGhost');
  const powerFill = document.getElementById('powerFill');
  const powerOverlay = document.getElementById('powerOverlay');
  const powerLabel = document.getElementById('powerLabel');
  const giftOverlay = document.getElementById('giftOverlay');
  const giftCaption = document.getElementById('giftCaption');
  const welcomeOverlay = document.getElementById('welcomeOverlay');
  const welcomeAvatar = document.getElementById('welcomeAvatar');
  const welcomeTitle = document.getElementById('welcomeTitle');
  const spikerEl = document.getElementById('spiker');
  const mvp = document.getElementById('mvp');
  const mvpAvatar = document.getElementById('mvpAvatar');
  const mvpTitle = document.getElementById('mvpTitle');
  const statusEl = document.getElementById('status');
  const capRed = document.getElementById('capRed');
  const capBlue = document.getElementById('capBlue');
  const viewerBadge = document.getElementById('viewerBadge');
  const critFlashEl = document.getElementById('critFlash');
  const suddenDeathEl = document.getElementById('suddenDeathOverlay');
  const bonusPoolCelebration = document.getElementById('bonusPoolCelebration');
  const bonusPoolCelebrationInner = document.getElementById('bonusPoolCelebrationInner');
  const vipBanner = document.getElementById('vipBanner');
  const leaderboardPanel = document.getElementById('leaderboardPanel');
  const leaderboardList = document.getElementById('leaderboardList');
  const bonusPoolAmountEl = document.getElementById('bonusPoolAmount');
  const comboFill = document.getElementById('comboFill');
  const comboLabel = document.getElementById('comboLabel');
  const topHudEl = document.getElementById('topHud');
  const matchTimerEl = document.getElementById('matchTimer');
  const killFeedEl = document.getElementById('killFeed');
  const teamTopRedEl = document.getElementById('teamTopRed');
  const teamTopBlueEl = document.getElementById('teamTopBlue');
  const captainChipRedEl = document.getElementById('captainChipRed');
  const captainChipBlueEl = document.getElementById('captainChipBlue');
  const teamTotalRedEl = document.getElementById('teamTotalRed');
  const teamTotalBlueEl = document.getElementById('teamTotalBlue');

  
  let hudTopReservePx = 0;

  let W = 360;
  let H = 640;

  let gameStartedAt = Date.now();
  let teamTopState = { red: [], blue: [] };
  let teamTotalsState = { red: 0, blue: 0 };

  let bonusPool = 0;
  let comboCountState = 0;
  let suddenDeathActive = false;
  let matchDurationMs = 5 * 60 * 1000;
  const towerImpactMeter = { red: 0, blue: 0 };
  const TOWER_IMPACT_THRESHOLD = 100;
  const TOWER_IMPACT_GAIN_MULT = 1.0;
  let camZoom = 1;
  let camPanX = 0;
  let camPanY = 0;

  // Screen shake (per-frame, decays smoothly)
  let shakeMag = 0;
  // Brief animation freeze on crits so big hits "land"
  let hitStopUntil = 0;
  // Per-tower hit reactions
  const towerHitFlash = { red: 0, blue: 0 };
  const towerSquash = { red: 0, blue: 0 };
  // Smoothed HP bars (main fill eases toward real value, ghost trails behind)
  const displayHp = { red: 1, blue: 1 };
  const ghostHp = { red: 1, blue: 1 };
  let winnerSide = null;
  let vignetteGrad = null;

  const shockwaves = [];
  const hitGlows = [];
  const debris = [];

  let gameState = {
    red: { hp: 10000, maxHp: 10000, captain: null },
    blue: { hp: 10000, maxHp: 10000, captain: null },
    running: true,
    winner: null,
  };
  let powerProgress = 0;
  let powerUntil = 0;

  const bullets = [];
  const floatTexts = [];
  const likePopTexts = [];
  const likeBridgePulses = [];
  const towerBurstEffects = [];
  const particles = [];
  const soldiers = [];
  const smokes = [];
  const confetti = [];
  const welcomeFlies = [];

  
  const profileImageCache = Object.create(null);
  const MAX_VISIBLE_JOINS = 3;
  const JOIN_SLOT_COUNT = 3;
  const JOIN_SAFE_EDGE = 8;
  const JOIN_MAX_WIDTH_FRAC = 0.42;
  const joinQueue = [];
  const activeJoinParticles = [];

  const imgCache = new Map();
  const giftQueue = [];
  let giftBusy = false;

  function loadProfileForJoin(url) {
    if (!url) return Promise.resolve(null);
    if (Object.prototype.hasOwnProperty.call(profileImageCache, url)) {
      return Promise.resolve(profileImageCache[url]);
    }
    return new Promise(function (resolve) {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = function () {
        profileImageCache[url] = im;
        resolve(im);
      };
      im.onerror = function () {
        profileImageCache[url] = null;
        resolve(null);
      };
      im.src = url;
    });
  }

  function truncateNickname(s, maxLen) {
    const t = String(s || '');
    if (t.length <= maxLen) return t;
    return t.slice(0, maxLen - 1) + '…';
  }

  function formatDamage(n) {
    const v = Math.floor(Number(n) || 0);
    if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 10_000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
    return String(v);
  }

  
  function getJoinSlotCenterYs() {
    const minY = hudTopReservePx + 14;
    const maxY = H - 52;
    const boxHalf = 21;
    const minCenter = minY + boxHalf;
    const maxCenter = maxY - boxHalf;
    const ys = [];
    if (maxCenter <= minCenter) {
      const mid = (minY + maxY) * 0.5;
      const step = 12;
      for (let s = 0; s < JOIN_SLOT_COUNT; s++) {
        ys.push(mid + (s - (JOIN_SLOT_COUNT - 1) / 2) * step);
      }
      return ys;
    }
    for (let s = 0; s < JOIN_SLOT_COUNT; s++) {
      const t = JOIN_SLOT_COUNT === 1 ? 0.5 : s / (JOIN_SLOT_COUNT - 1);
      ys.push(minCenter + (maxCenter - minCenter) * t);
    }
    return ys;
  }

  function computeJoinBoxMetrics(nickname, c, gPre) {
    const g = gPre || towerGeom();
    const betweenW = Math.max(56, g.blue.x - (g.red.x + g.red.w) - 2 * JOIN_SAFE_EDGE);
    const maxW = Math.max(88, Math.min(W * JOIN_MAX_WIDTH_FRAC, betweenW - JOIN_SAFE_EDGE));
    const maxChars = betweenW < 130 ? 14 : betweenW < 180 ? 18 : 22;
    const name = truncateNickname(nickname, maxChars);
    c.font = 'bold 13px Segoe UI, system-ui, -apple-system, sans-serif';
    const textW = c.measureText(name).width;
    const avatarR = Math.min(14, W * 0.038);
    const padL = 8;
    const padR = 8;
    const gapText = 8;
    const boxH = Math.max(avatarR * 2 + 8, 36);
    let boxW = padL + avatarR * 2 + gapText + textW + padR;
    if (boxW > maxW) {
      boxW = maxW;
    }
    return {
      name: name,
      textW: textW,
      avatarR: avatarR,
      padL: padL,
      padR: padR,
      gapText: gapText,
      boxW: boxW,
      boxH: boxH,
    };
  }

  function tryDrainJoinQueue() {
    while (activeJoinParticles.length < MAX_VISIBLE_JOINS && joinQueue.length > 0) {
      const used = new Set();
      for (let j = 0; j < activeJoinParticles.length; j++) {
        used.add(activeJoinParticles[j].slotIndex);
      }
      let slot = -1;
      for (let s = 0; s < JOIN_SLOT_COUNT; s++) {
        if (!used.has(s)) {
          slot = s;
          break;
        }
      }
      if (slot < 0) break;

      const item = joinQueue.shift();
      const ys = getJoinSlotCenterYs();
      const slotY = ys[slot];

      const p = {
        uniqueId: item.uniqueId || '',
        nickname: item.nickname || 'Player',
        profilePictureUrl: item.profilePictureUrl || '',
        img: null,
        slotIndex: slot,
        slotY: slotY,
        born: performance.now(),
        enteringMs: 220,
        waitingMs: 1000,
        exitingMs: 260,
        state: 'entering',
        alpha: 0,
        boxX: 0,
      };

      activeJoinParticles.push(p);

      loadProfileForJoin(item.profilePictureUrl || '').then(function (img) {
        for (let k = 0; k < activeJoinParticles.length; k++) {
          if (activeJoinParticles[k] === p) {
            activeJoinParticles[k].img = img;
            break;
          }
        }
      });
    }
  }

  function updateAndDrawJoinParticles(c) {
    tryDrainJoinQueue();

    const gCached = towerGeom();
    const slotYs = getJoinSlotCenterYs();
    for (let sj = 0; sj < activeJoinParticles.length; sj++) {
      const jp = activeJoinParticles[sj];
      if (jp.slotIndex >= 0 && jp.slotIndex < slotYs.length) {
        jp.slotY = slotYs[jp.slotIndex];
      }
    }

    const now = performance.now();
    const metricsFont = 'bold 13px Segoe UI, system-ui, -apple-system, sans-serif';

    for (let i = activeJoinParticles.length - 1; i >= 0; i--) {
      const p = activeJoinParticles[i];
      const elapsed = now - p.born;
      const enterEnd = p.enteringMs;
      const waitEnd = enterEnd + p.waitingMs;
      const exitEnd = waitEnd + p.exitingMs;

      c.font = metricsFont;
      const m = computeJoinBoxMetrics(p.nickname, c, gCached);
      const boxW = m.boxW;
      const boxH = m.boxH;
      const slotY = p.slotY;
      const boxY = slotY - boxH / 2;

      const padH = 5;
      const leftBound = gCached.red.x + gCached.red.w + padH;
      const rightBound = gCached.blue.x - padH;
      const arenaMidX = (gCached.red.x + gCached.red.w + gCached.blue.x) * 0.5;
      let targetX = arenaMidX - boxW * 0.5;
      if (targetX < leftBound) targetX = leftBound;
      if (targetX + boxW > rightBound) targetX = Math.max(leftBound, rightBound - boxW);
      const enterX = -boxW - 24;
      const exitX = W + boxW + 24;

      if (elapsed < enterEnd) {
        p.state = 'entering';
        const t = elapsed / enterEnd;
        const e = 1 - Math.pow(1 - t, 3);
        p.boxX = enterX + (targetX - enterX) * e;
        p.alpha = e;
      } else if (elapsed < waitEnd) {
        p.state = 'waiting';
        p.boxX = targetX;
        p.alpha = 1;
      } else if (elapsed < exitEnd) {
        p.state = 'exiting';
        const u = (elapsed - waitEnd) / p.exitingMs;
        p.boxX = targetX + (exitX - targetX) * (u * u);
        p.alpha = 1 - u * u;
      } else {
        activeJoinParticles.splice(i, 1);
        continue;
      }

      const r = m.avatarR;
      const cx = p.boxX + m.padL + r;
      const cy = slotY;
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.01 + i * 0.7);

      c.save();
      c.globalAlpha = p.alpha;

      const cardGrad = c.createLinearGradient(p.boxX, boxY, p.boxX + boxW, boxY + boxH);
      cardGrad.addColorStop(0, 'rgba(16, 10, 34, 0.82)');
      cardGrad.addColorStop(1, 'rgba(11, 26, 44, 0.82)');
      c.fillStyle = cardGrad;
      if (typeof c.roundRect === 'function') {
        c.beginPath();
        c.roundRect(p.boxX, boxY, boxW, boxH, 10);
        c.fill();
      } else {
        c.fillRect(p.boxX, boxY, boxW, boxH);
      }
      c.strokeStyle = 'rgba(255,255,255,0.24)';
      c.lineWidth = 1;
      if (typeof c.roundRect === 'function') {
        c.beginPath();
        c.roundRect(p.boxX, boxY, boxW, boxH, 10);
        c.stroke();
      }

      const shineX = p.boxX + ((now * 0.05 + i * 31) % (boxW + 34)) - 24;
      const shine = c.createLinearGradient(shineX, boxY, shineX + 24, boxY);
      shine.addColorStop(0, 'rgba(255,255,255,0)');
      shine.addColorStop(0.5, 'rgba(255,255,255,0.18)');
      shine.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = shine;
      c.fillRect(p.boxX, boxY, boxW, boxH);

      c.save();
      c.strokeStyle = 'rgba(255,255,255,' + (0.16 + pulse * 0.2) + ')';
      c.lineWidth = 2;
      c.beginPath();
      c.arc(cx, cy, r + 3, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.clip();
      if (p.img) {
        c.drawImage(p.img, cx - r, cy - r, r * 2, r * 2);
      } else {
        c.fillStyle = 'rgba(90,70,120,0.95)';
        c.beginPath();
        c.arc(cx, cy, r, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();

      c.strokeStyle = 'rgba(255,255,255,0.45)';
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.stroke();

      const badgeW = 24;
      const badgeH = 11;
      const badgeX = p.boxX + boxW - badgeW - 6;
      const badgeY = boxY + 4;
      c.fillStyle = 'rgba(118, 246, 255, 0.9)';
      if (typeof c.roundRect === 'function') {
        c.beginPath();
        c.roundRect(badgeX, badgeY, badgeW, badgeH, 6);
        c.fill();
      } else {
        c.fillRect(badgeX, badgeY, badgeW, badgeH);
      }
      c.font = '700 8px Segoe UI, sans-serif';
      c.fillStyle = '#072231';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('NEW', badgeX + badgeW / 2, badgeY + badgeH / 2 + 0.5);

      const textX = p.boxX + m.padL + r * 2 + m.gapText;
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      c.font = metricsFont;
      c.fillStyle = '#ffffff';
      c.shadowColor = 'rgba(0,0,0,0.75)';
      c.shadowBlur = 3;
      const maxTextW = p.boxX + boxW - m.padR - textX;
      let drawName = m.name;
      if (c.measureText(drawName).width > maxTextW && maxTextW > 20) {
        while (drawName.length > 2 && c.measureText(drawName + '…').width > maxTextW) {
          drawName = drawName.slice(0, -1);
        }
        drawName += '…';
      }
      c.fillText(drawName, textX, cy);
      c.shadowBlur = 0;

      c.restore();
    }
  }

  function loadImage(url) {
    if (!url) return Promise.resolve(null);
    if (imgCache.has(url)) return imgCache.get(url);
    const p = new Promise((resolve) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = url;
    });
    imgCache.set(url, p);
    return p;
  }

  function resize() {
    const r = stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.floor(r.width);
    H = Math.floor(r.height);
    if (topHudEl && H > 0) {
      const rHud = topHudEl.getBoundingClientRect();
      const measured = Math.ceil(Math.max(0, rHud.bottom - r.top) + 10);
      hudTopReservePx = Math.floor(
        Math.max(H * 0.26, Math.min(H * 0.52, measured || H * 0.34))
      );
    } else {
      hudTopReservePx = Math.floor(H * 0.34);
    }
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pr = giftOverlay.getBoundingClientRect();
    const pw = Math.max(200, Math.floor(pr.width));
    const ph = Math.max(200, Math.floor(pr.height * 0.72));
    giftDropCanvas.width = pw * dpr;
    giftDropCanvas.height = ph * dpr;
    giftDropCanvas.style.width = pw + 'px';
    giftDropCanvas.style.height = ph + 'px';
    pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    giftDropLogicalW = pw;
    giftDropLogicalH = ph;
    vignetteGrad = ctx.createRadialGradient(
      W * 0.5,
      H * 0.45,
      Math.min(W, H) * 0.42,
      W * 0.5,
      H * 0.55,
      Math.max(W, H) * 0.78
    );
    vignetteGrad.addColorStop(0, 'rgba(0,0,0,0)');
    vignetteGrad.addColorStop(1, 'rgba(12,0,28,0.3)');
    const ysJoin = getJoinSlotCenterYs();
    for (let j = 0; j < activeJoinParticles.length; j++) {
      const jp = activeJoinParticles[j];
      if (jp.slotIndex >= 0 && jp.slotIndex < ysJoin.length) {
        jp.slotY = ysJoin[jp.slotIndex];
      }
    }
  }

  let giftDropLogicalW = 360;
  let giftDropLogicalH = 400;

  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(stage);
  if (topHudEl) {
    new ResizeObserver(resize).observe(topHudEl);
  }

  
  function towerGeom() {
    const marginX = Math.max(10, W * 0.045);
    const bottomReserve = Math.max(50, H * 0.105);
    const playTop = Math.max(H * 0.085, hudTopReservePx + 22);
    const bandEnd = H - bottomReserve;
    const bandH = Math.max(0, bandEnd - playTop);

    const tw = Math.min(W * 0.26, (W - 2 * marginX - 24) * 0.42);
    const minTh = H * 0.078;
    const maxTh = H * 0.124;
    let th = Math.min(H * 0.115, bandH * 0.68);
    th = Math.max(minTh, Math.min(th, maxTh));

    const cy = playTop + bandH * 0.5;
    const y = cy - th / 2;

    const red = {
      x: marginX,
      y: y,
      w: tw,
      h: th,
      cx: marginX + tw / 2,
      cy: cy,
    };
    const blue = {
      x: W - marginX - tw,
      y: y,
      w: tw,
      h: th,
      cx: W - marginX - tw / 2,
      cy: cy,
    };
    return { red, blue, tw, th };
  }

  function hpRatio(side) {
    const g = gameState[side];
    if (!g || !g.maxHp) return 1;
    return Math.max(0, Math.min(1, g.hp / g.maxHp));
  }

  function renderMiniCaptain(el, cap) {
    if (!el) return;
    if (cap && cap.userId) {
      el.classList.add('on');
      el.innerHTML =
        '<span class="cup">👑</span><img alt="" src="' +
        (cap.avatar || '') +
        '" /><span class="name">' +
        truncateNickname(cap.nickname || '', 11) +
        '</span>';
    } else {
      el.classList.remove('on');
      el.innerHTML = '<span class="cup">👑</span><span class="name">—</span>';
    }
  }

  function fillMiniTeamEl(ol, entries) {
    if (!ol) return;
    ol.innerHTML = '';
    (entries || []).forEach(function (e, i) {
      const li = document.createElement('li');
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = i + 1 + '.';
      const img = document.createElement('img');
      img.src = e.avatar || '';
      img.alt = '';
      const nick = document.createElement('span');
      nick.className = 'nick';
      nick.textContent = truncateNickname(e.nickname || '', 12);
      const dmg = document.createElement('span');
      dmg.className = 'dmg';
      const d = e.damage != null ? e.damage : e.coins;
      dmg.textContent = d != null ? formatDamage(d) : '';
      li.appendChild(rank);
      li.appendChild(img);
      li.appendChild(nick);
      li.appendChild(dmg);
      ol.appendChild(li);
    });
  }

  function renderTeamTotals() {
    if (teamTotalRedEl) {
      teamTotalRedEl.textContent =
        'Σ ' + formatDamage(teamTotalsState.red) + ' toplam points';
    }
    if (teamTotalBlueEl) {
      teamTotalBlueEl.textContent =
        'Σ ' + formatDamage(teamTotalsState.blue) + ' toplam points';
    }
  }

  function renderTeamTop() {
    fillMiniTeamEl(teamTopRedEl, teamTopState.red);
    fillMiniTeamEl(teamTopBlueEl, teamTopState.blue);
    renderTeamTotals();
  }

  function updateMatchTimer() {
    if (!matchTimerEl) return;
    if (!gameState.running) {
      matchTimerEl.textContent = '—';
      matchTimerEl.classList.remove('sd');
      return;
    }
    if (suddenDeathActive) {
      matchTimerEl.textContent = 'FINAL';
      matchTimerEl.classList.add('sd');
      return;
    }
    matchTimerEl.classList.remove('sd');
    const left = Math.max(0, matchDurationMs - (Date.now() - gameStartedAt));
    const s = Math.floor(left / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    matchTimerEl.textContent = String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }

  function pushKillFeed(ev) {
    if (!killFeedEl || !ev || !ev.killFeed) return;
    const k = ev.killFeed;
    const line = document.createElement('div');
    line.className = 'kill-feed-line' + (ev.isCrit ? ' crit' : '');
    line.textContent =
      k.nickname +
      ' → ' +
      k.targetLabel +
      ' tower ' +
      k.damage +
      ' points' +
      (ev.isCrit ? ' · belirgin' : '');
    killFeedEl.insertBefore(line, killFeedEl.firstChild);
    while (killFeedEl.children.length > 6) {
      killFeedEl.removeChild(killFeedEl.lastChild);
    }
  }

  function updateHpBars() {
    if (!hpRed || !hpBlue) return;
    const rA = hpRatio('red');
    const bA = hpRatio('blue');
    displayHp.red += (rA - displayHp.red) * 0.14;
    displayHp.blue += (bA - displayHp.blue) * 0.14;
    if (Math.abs(displayHp.red - rA) < 0.0005) displayHp.red = rA;
    if (Math.abs(displayHp.blue - bA) < 0.0005) displayHp.blue = bA;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 'red' : 'blue';
      if (ghostHp[side] > displayHp[side]) {
        ghostHp[side] = Math.max(
          displayHp[side],
          ghostHp[side] - (0.0016 + (ghostHp[side] - displayHp[side]) * 0.02)
        );
      } else {
        ghostHp[side] = displayHp[side];
      }
    }
    hpRed.style.transform = 'scaleX(' + displayHp.red + ')';
    hpBlue.style.transform = 'scaleX(' + displayHp.blue + ')';
    if (hpRedGhost) hpRedGhost.style.transform = 'scaleX(' + ghostHp.red + ')';
    if (hpBlueGhost) hpBlueGhost.style.transform = 'scaleX(' + ghostHp.blue + ')';
  }

  function updateHud() {
    powerFill.style.width = Math.min(100, powerProgress) + '%';
    powerFill.classList.toggle('charged', powerProgress >= 90);
    if (bonusPoolAmountEl) {
      bonusPoolAmountEl.textContent = String(Math.floor(bonusPool));
    }
    if (comboFill && comboLabel) {
      const step = Math.min(5, Math.max(0, comboCountState));
      comboFill.style.width = (step / 5) * 100 + '%';
      comboLabel.textContent = step + ' / 5' + (step >= 5 ? ' ⚡ team bonus' : '');
      comboFill.classList.toggle('full', step >= 5);
    }
    const now = Date.now();
    const powerOn = now < powerUntil;
    if (prevPowerOn === true && !powerOn && gameState.running && LTB) LTB.powerOff();
    prevPowerOn = powerOn;
    powerOverlay.classList.toggle('on', powerOn);
    if (powerOn) {
      const s = Math.max(0, Math.ceil((powerUntil - now) / 1000));
      powerLabel.textContent = '⚡ POWER MODE! DOUBLE EFFECT - ' + s + ' SN';
    } else {
      powerLabel.textContent = '⚡ POWER BAR — LIKE & LIVE INTERACTION';
    }

    const rc = gameState.red.captain;
    const bc = gameState.blue.captain;
    if (rc && rc.userId) {
      capRed.style.opacity = 1;
      capRed.innerHTML =
        '<span>👑</span><img alt="" src="' +
        (rc.avatar || '') +
        '" />' +
        (rc.nickname || '');
    } else {
      capRed.style.opacity = 0;
      capRed.innerHTML = '';
    }
    if (bc && bc.userId) {
      capBlue.style.opacity = 1;
      capBlue.innerHTML =
        (bc.nickname || '') +
        '<img alt="" src="' +
        (bc.avatar || '') +
        '" /><span>👑</span>';
    } else {
      capBlue.style.opacity = 0;
      capBlue.innerHTML = '';
    }

    renderMiniCaptain(captainChipRedEl, rc);
    renderMiniCaptain(captainChipBlueEl, bc);

    if (stage) {
      stage.classList.toggle('sudden-death-pulse', suddenDeathActive);
    }
    if (suddenDeathEl) {
      suddenDeathEl.classList.toggle('on', suddenDeathActive);
      suddenDeathEl.setAttribute('aria-hidden', suddenDeathActive ? 'false' : 'true');
    }
  }

  let sharedAudioContext = null;
  let audioUnlocked = false;
  let pendingVipChime = false;
  const pendingSpikerTts = [];
  
  const ENABLE_SPIKER_TTS = false;

  
  function getSharedAudioContext() {
    if (!audioUnlocked) return null;
    if (sharedAudioContext) return sharedAudioContext;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    sharedAudioContext = new Ctx();
    return sharedAudioContext;
  }

  function flushPendingSpikerTts() {
    if (!pendingSpikerTts.length) return;
    const last = pendingSpikerTts[pendingSpikerTts.length - 1];
    pendingSpikerTts.length = 0;
    speakSpikerLinesImmediate(last);
  }

  function speakSpikerLinesImmediate(lines) {
    if (!ENABLE_SPIKER_TTS) return;
    if (!lines || !lines.length || !('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(lines.join(' '));
      u.lang = 'tr-TR';
      u.rate = suddenDeathActive ? 1.12 : 1;
      u.volume = 0.95;
      speechSynthesis.speak(u);
    } catch (_) {}
  }

  function unlockAudioPlayback() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    const ac = getSharedAudioContext();
    if (ac && ac.state === 'suspended') {
      ac.resume().catch(function () {});
    }
    if (LTB) LTB.unlock();
    flushPendingSpikerTts();
    if (pendingVipChime) {
      pendingVipChime = false;
      playVipChimeNow();
    }
  }

  function setupAudioUnlockListeners() {
    const onFirstInteraction = function () {
      unlockAudioPlayback();
      window.removeEventListener('pointerdown', onFirstInteraction);
      window.removeEventListener('keydown', onFirstInteraction);
      window.removeEventListener('touchstart', onFirstInteraction);
      window.removeEventListener('click', onFirstInteraction);
      if (stage) stage.removeEventListener('pointerdown', onFirstInteraction);
      if (stage) stage.removeEventListener('touchstart', onFirstInteraction);
    };
    window.addEventListener('pointerdown', onFirstInteraction, { passive: true });
    window.addEventListener('keydown', onFirstInteraction);
    window.addEventListener('touchstart', onFirstInteraction, { passive: true });
    window.addEventListener('click', onFirstInteraction);
    if (stage) stage.addEventListener('pointerdown', onFirstInteraction, { passive: true });
    if (stage) stage.addEventListener('touchstart', onFirstInteraction, { passive: true });
  }

  function playVipChimeNow() {
    if (LTB) {
      LTB.vip();
      return;
    }
    const ac = getSharedAudioContext();
    if (!ac) return;
    function runOsc() {
      try {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(523, ac.currentTime);
        o.frequency.exponentialRampToValueAtTime(784, ac.currentTime + 0.12);
        g.gain.setValueAtTime(0.1, ac.currentTime);
        g.gain.exponentialRampToValueAtTime(0.01, ac.currentTime + 0.35);
        o.connect(g);
        g.connect(ac.destination);
        o.start();
        o.stop(ac.currentTime + 0.35);
      } catch (_) {}
    }
    if (ac.state === 'suspended') {
      ac.resume().then(runOsc).catch(runOsc);
    } else {
      runOsc();
    }
  }

  function playVipChime() {
    if (!audioUnlocked) {
      pendingVipChime = true;
      return;
    }
    playVipChimeNow();
  }

  function speakSpikerLines(lines) {
    if (!ENABLE_SPIKER_TTS) return;
    if (!lines || !lines.length || !('speechSynthesis' in window)) return;
    if (!audioUnlocked) {
      pendingSpikerTts.push(lines.slice());
      return;
    }
    speakSpikerLinesImmediate(lines);
  }

  function flashCrit() {
    if (!critFlashEl) return;
    critFlashEl.classList.add('on');
    setTimeout(function () {
      critFlashEl.classList.remove('on');
    }, 80);
  }

  function spawnTowerSparks(cx, cy, count) {
    const n = Math.min(80, count | 0);
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 5;
      particles.push({
        x: cx + (Math.random() - 0.5) * 24,
        y: cy + (Math.random() - 0.5) * 16,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 1.2,
        r: 0.8 + Math.random() * 2.2,
        c: Math.random() < 0.5 ? 'rgba(255,230,120,' : 'rgba(255,100,200,',
        life: 0.85 + Math.random() * 0.15,
      });
    }
  }

  function bumpCameraToTower(targetTower, strength) {
    const g = towerGeom();
    const tr = targetTower === 'red' ? g.red : g.blue;
    const s = strength || 1;
    camZoom = Math.min(1.14, camZoom + 0.06 * s);
    camPanX += (tr.cx - W * 0.5) * 0.08 * s;
    camPanY += (tr.cy - H * 0.5) * 0.06 * s;
  }

  function spawnEmojiBurst(count, fromTeam) {
    const g = towerGeom();
    const n = Math.min(400, Math.max(1, count | 0));
    for (let i = 0; i < n; i++) {
      const team = Math.random() < 0.5 ? 'red' : 'blue';
      const from = team === 'red' ? g.red : g.blue;
      const to = team === 'red' ? g.blue : g.red;
      const sx = from.cx + (Math.random() - 0.5) * from.w * 0.7;
      const sy = from.cy + (Math.random() - 0.5) * from.h * 0.5;
      const tx = to.cx + (Math.random() - 0.5) * to.w * 0.8;
      const ty = to.cy + (Math.random() - 0.5) * to.h * 0.5;
      bullets.push({
        emoji: EMOJI_BULLETS[(Math.random() * EMOJI_BULLETS.length) | 0],
        sx,
        sy,
        tx,
        ty,
        t: Math.random() * 0.2,
        spd: 0.02 + Math.random() * 0.04,
      });
    }
  }

  function spawnFloat(targetTower, text, crit, attacker) {
    const g = towerGeom();
    const tr = targetTower === 'red' ? g.red : g.blue;
    const x = tr.cx + (Math.random() - 0.5) * tr.w * 0.5;
    const y = tr.y + tr.h * 0.2;
    const teamColor = targetTower === 'red' ? '#ff9ec9' : '#9ffff8';
    floatTexts.push({
      x,
      y,
      text,
      sub: attacker ? truncateNickname(attacker, 16) : null,
      crit: !!crit,
      teamColor: teamColor,
      born: performance.now(),
      seed: Math.random() * Math.PI * 2,
    });
  }

  function spawnLikePops(count) {
    const n = Math.max(1, Math.min(3, Math.ceil((count || 1) / 80)));
    const centerX = W * 0.5;
    const minY = Math.max(hudTopReservePx + 18, H * 0.22);
    const maxY = Math.min(H * 0.4, minY + 70);
    const laneStep = Math.max(16, (maxY - minY) / 3);
    const laneBase = [minY, minY + laneStep, minY + laneStep * 2];
    for (let i = 0; i < n; i++) {
      const lane = laneBase[i % laneBase.length];
      const x = Math.max(84, Math.min(W - 84, centerX + (Math.random() - 0.5) * 90));
      const y = Math.max(minY, Math.min(maxY, lane + (Math.random() - 0.5) * 8));
      likePopTexts.push({
        x,
        y,
        text: '👍 +' + count + ' likes',
        born: performance.now(),
        vy: -0.22 - Math.random() * 0.16,
        vx: (Math.random() - 0.5) * 0.12,
        a: 1,
      });
    }
  }

  function spawnLikeBridgePulse(count) {
    const g = towerGeom();
    const intensity = Math.max(2, Math.min(8, Math.ceil((count || 1) / 60)));
    const yMid = Math.max(hudTopReservePx + 20, Math.min(H * 0.56, g.red.y + g.red.h + 6));
    for (let i = 0; i < intensity; i++) {
      const fromLeft = i % 2 === 0;
      const from = fromLeft ? g.red : g.blue;
      const to = fromLeft ? g.blue : g.red;
      likeBridgePulses.push({
        sx: from.cx,
        sy: yMid + (Math.random() - 0.5) * 18,
        tx: to.cx,
        ty: yMid + (Math.random() - 0.5) * 18,
        t: Math.random() * 0.12,
        spd: 0.02 + Math.random() * 0.015,
        size: 13 + Math.random() * 4,
        emoji: fromLeft ? '💗' : '✨',
        color: fromLeft ? 'rgba(255,120,180,0.95)' : 'rgba(120,245,255,0.95)',
        trail: fromLeft ? 'rgba(255,120,180,0.55)' : 'rgba(120,245,255,0.55)',
        life: 1,
      });
    }
  }

  function triggerTowerBurst(side) {
    const g = towerGeom();
    const t = side === 'red' ? g.red : g.blue;
    const cx = t.cx;
    const cy = t.y + t.h * 0.55;
    towerBurstEffects.push({
      side,
      born: performance.now(),
      durationMs: 520,
      sx: cx,
      sy: cy,
    });
    bumpCameraToTower(side, 1.2);
    spawnTowerSparks(cx, cy, 70);
    spawnExplosion(cx, cy, 420);
    const rgb = side === 'red' ? '255,130,190' : '130,245,255';
    spawnHitGlow(cx, cy, rgb, 190);
    spawnShockwave(cx, cy, rgb, 240, 6);
    spawnShockwave(cx, cy, '255,255,255', 150, 3);
    const ca = side === 'red' ? 'rgba(255,120,170,0.95)' : 'rgba(120,240,255,0.95)';
    const cb = side === 'red' ? 'rgba(150,40,80,0.95)' : 'rgba(20,120,150,0.95)';
    spawnDebris(cx, cy, 26, ca, cb);
    towerHitFlash[side] = 1;
    towerSquash[side] = 0.16;
    addShake(14);
    triggerHitStop(60);
    if (LTB) LTB.explosion();
  }

  function addTowerImpact(targetTower, damage) {
    const key = targetTower === 'red' ? 'red' : 'blue';
    const rawGain = Math.min(26, Math.max(5, Math.floor((damage || 0) / 750)));
    const gain = Math.max(1, Math.round(rawGain * TOWER_IMPACT_GAIN_MULT));
    towerImpactMeter[key] = Math.min(TOWER_IMPACT_THRESHOLD, towerImpactMeter[key] + gain);
    if (towerImpactMeter[key] >= TOWER_IMPACT_THRESHOLD) {
      towerImpactMeter[key] = 0;
      triggerTowerBurst(key);
    }
  }

  function spawnExplosion(x, y, power) {
    const n = Math.min(150, 45 + (power | 0));
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 1.5 + Math.random() * (6 + power * 0.015);
      const roll = Math.random();
      const c =
        roll < 0.4
          ? 'rgba(255,225,130,'
          : roll < 0.75
            ? 'rgba(255,200,80,'
            : 'rgba(255,60,140,';
      particles.push({
        x,
        y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 0.8,
        r: 1.5 + Math.random() * 2.5,
        c: c,
        life: 0.9 + Math.random() * 0.35,
        glow: Math.random() < 0.35,
      });
    }
  }

  function addShake(mag) {
    shakeMag = Math.min(26, shakeMag + (mag || 0));
  }

  function triggerHitStop(ms) {
    hitStopUntil = Math.max(hitStopUntil, performance.now() + (ms || 0));
  }

  function spawnShockwave(x, y, rgb, rMax, lw) {
    shockwaves.push({
      x,
      y,
      rgb: rgb || '255,255,255',
      r: 8,
      rMax: rMax || 70,
      lw: lw || 4,
    });
  }

  function spawnHitGlow(x, y, rgb, size) {
    hitGlows.push({
      x,
      y,
      rgb: rgb || '255,255,255',
      size: size || 70,
      born: performance.now(),
    });
  }

  function spawnDebris(x, y, n, colorA, colorB) {
    const count = Math.min(44, n | 0);
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 6.5;
      debris.push({
        x,
        y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 2.4,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.35,
        w: 3 + Math.random() * 5,
        h: 2 + Math.random() * 4,
        c: Math.random() < 0.5 ? colorA : colorB,
        life: 1,
      });
    }
  }

  function spawnTowerHitFx(side, power, crit) {
    const g = towerGeom();
    const t = side === 'red' ? g.red : g.blue;
    const cx = t.cx + (Math.random() - 0.5) * t.w * 0.4;
    const cy = t.y + t.h * (0.35 + Math.random() * 0.4);
    const rgb = side === 'red' ? '255,130,190' : '130,245,255';
    const pw = Math.min(2.5, power || 0.5);
    spawnHitGlow(cx, cy, rgb, 46 + pw * 55 + (crit ? 60 : 0));
    spawnShockwave(cx, cy, rgb, 55 + pw * 70 + (crit ? 90 : 0), crit ? 5 : 3.5);
    towerHitFlash[side] = Math.min(1, towerHitFlash[side] + 0.3 + pw * 0.2 + (crit ? 0.35 : 0));
    towerSquash[side] = Math.min(0.16, towerSquash[side] + 0.045 + pw * 0.025 + (crit ? 0.05 : 0));
    if (pw > 0.45 || crit) {
      const ca = side === 'red' ? 'rgba(255,120,170,0.95)' : 'rgba(120,240,255,0.95)';
      const cb = side === 'red' ? 'rgba(150,40,80,0.95)' : 'rgba(20,120,150,0.95)';
      spawnDebris(cx, cy, Math.floor(10 + pw * 14) + (crit ? 10 : 0), ca, cb);
    }
    addShake(Math.min(9, 1.2 + pw * 2.4) + (crit ? 6 : 0));
    if (crit) triggerHitStop(75);
    if (LTB) {
      if (crit) LTB.crit();
      else LTB.hit(Math.min(1, pw / 2.5));
    }
  }

  function drawBackground() {
    const t = performance.now() * 0.001;
    const grd = ctx.createLinearGradient(0, 0, W, H);
    if (suddenDeathActive) {
      grd.addColorStop(0, 'rgba(120,20,40,0.55)');
      grd.addColorStop(0.45, 'rgba(80,10,25,0.45)');
      grd.addColorStop(1, 'rgba(40,5,15,0.5)');
    } else {
      grd.addColorStop(0, 'rgba(255,200,230,0.38)');
      grd.addColorStop(0.45, 'rgba(180,120,255,0.22)');
      grd.addColorStop(1, 'rgba(120,255,240,0.32)');
    }
    ctx.fillStyle = grd;
    ctx.fillRect(-40, -40, W + 80, H + 80);

    const powerOn = Date.now() < powerUntil;
    if (powerOn && !suddenDeathActive) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      const pulse = 0.35 + Math.sin(t * 4) * 0.12;
      const rg = ctx.createRadialGradient(W * 0.5, H * 0.15, 0, W * 0.5, H * 0.35, H * 0.6);
      rg.addColorStop(0, 'rgba(255, 240, 120, ' + pulse + ')');
      rg.addColorStop(1, 'rgba(255, 200, 80, 0)');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(255,255,220,0.35)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        const x0 = ((t * 80 + i * 97) % (W + 80)) - 40;
        ctx.beginPath();
        ctx.moveTo(x0, 0);
        ctx.lineTo(x0 + (i % 2 === 0 ? 30 : -25), H * (0.35 + (i % 3) * 0.08));
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.save();
    ctx.fillStyle = suddenDeathActive ? '#ffaaaa' : '#fff';
    for (let i = 0; i < 56; i++) {
      const tw = 0.5 + 0.5 * Math.sin(t * (1.2 + (i % 5) * 0.5) + i * 1.7);
      ctx.globalAlpha = (suddenDeathActive ? 0.1 : 0.14) + tw * 0.22;
      const sx = (i * 73 + t * 7) % W;
      const sy = (i * 41 + t * 11) % H;
      ctx.beginPath();
      ctx.arc(sx, sy, 1.1 + (i % 3) * 0.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    const g = towerGeom();
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const glowDefs = [
      { tt: g.red, rgb: '255,80,150' },
      { tt: g.blue, rgb: '80,230,220' },
    ];
    for (let i = 0; i < glowDefs.length; i++) {
      const gd = glowDefs[i];
      const gy = gd.tt.y + gd.tt.h;
      const gr = ctx.createRadialGradient(gd.tt.cx, gy, 0, gd.tt.cx, gy, gd.tt.w * 1.6);
      gr.addColorStop(0, 'rgba(' + gd.rgb + ',0.2)');
      gr.addColorStop(1, 'rgba(' + gd.rgb + ',0)');
      ctx.fillStyle = gr;
      ctx.fillRect(gd.tt.cx - gd.tt.w * 1.7, gy - gd.tt.w * 0.5, gd.tt.w * 3.4, gd.tt.w * 1.6);
    }
    ctx.restore();
  }

  function drawTower(side) {
    const g = towerGeom();
    const t = side === 'red' ? g.red : g.blue;
    const ratio = hpRatio(side);
    const dmg = 1 - ratio;
    const col1 = side === 'red' ? '#c9184a' : '#008b8b';
    const col2 = side === 'red' ? '#ff5c9a' : '#2ee6dc';
    const colDark = side === 'red' ? '#7a0d30' : '#005a5a';
    const colLight = side === 'red' ? '#ffb3d1' : '#b8fffa';

    ctx.save();
    if (side === 'blue') {
      ctx.translate(t.cx, 0);
      ctx.scale(-1, 1);
      ctx.translate(-t.cx, 0);
    }
    const sq = towerSquash[side];
    if (sq > 0.002) {
      ctx.translate(t.cx, t.y + t.h);
      ctx.scale(1 + sq * 0.7, 1 - sq);
      ctx.translate(-t.cx, -(t.y + t.h));
    }
    if (winnerSide === side && !gameState.running) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.005);
      const aurR = Math.max(t.w, t.h) * (1.3 + pulse * 0.2);
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      const rg = ctx.createRadialGradient(t.cx, t.cy, 0, t.cx, t.cy, aurR);
      rg.addColorStop(0, 'rgba(255,215,110,' + (0.3 + pulse * 0.22).toFixed(3) + ')');
      rg.addColorStop(1, 'rgba(255,215,110,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(t.cx - aurR, t.cy - aurR, aurR * 2, aurR * 2);
      ctx.restore();
    }
    const x = t.x;
    const y = t.y;
    const w = t.w;
    const h = t.h;
    const skew = w * 0.08;

    const bodyGrad = ctx.createLinearGradient(x, y, x + w, y + h);
    bodyGrad.addColorStop(0, col1);
    bodyGrad.addColorStop(0.55, col2);
    bodyGrad.addColorStop(1, colDark);

    ctx.shadowColor = side === 'red' ? 'rgba(255,60,130,0.55)' : 'rgba(0,220,200,0.55)';
    ctx.shadowBlur = 16;
    const bodyPath = new Path2D();
    bodyPath.moveTo(x + skew, y + h * 0.22);
    bodyPath.lineTo(x + w - skew, y + h * 0.18);
    bodyPath.lineTo(x + w, y + h);
    bodyPath.lineTo(x, y + h);
    bodyPath.closePath();
    ctx.fillStyle = bodyGrad;
    ctx.fill(bodyPath);

    const upperH = h * 0.42;
    const topPath = new Path2D();
    topPath.moveTo(x + skew * 0.5, y + h * 0.22);
    topPath.lineTo(x + w - skew * 0.5, y + h * 0.18);
    topPath.lineTo(x + w - skew * 0.3, y + h * 0.22 - upperH);
    topPath.lineTo(x + skew * 0.3, y + h * 0.22 - upperH);
    topPath.closePath();
    const upGrad = ctx.createLinearGradient(x, y, x + w, y + upperH);
    upGrad.addColorStop(0, colLight);
    upGrad.addColorStop(1, col2);
    ctx.fillStyle = upGrad;
    ctx.fill(topPath);

    const merlonW = w / 7;
    for (let m = 0; m < 6; m++) {
      const mx = x + skew * 0.5 + m * merlonW * 1.02;
      const myTop = y + h * 0.22 - upperH;
      ctx.fillStyle = colLight;
      ctx.fillRect(mx, myTop - h * 0.08, merlonW * 0.65, h * 0.08);
    }

    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 2;
    ctx.stroke(topPath);

    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(x + w * 0.35, y + h * 0.45, w * 0.12, h * 0.18);
    ctx.fillRect(x + w * 0.52, y + h * 0.45, w * 0.12, h * 0.18);

    const crackN = Math.min(12, 3 + Math.floor(dmg * 14));
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1.4;
    for (let c = 0; c < crackN; c++) {
      const seed = (side === 'red' ? 2.1 : 1.7) + c * 1.3;
      const px = x + w * (0.2 + (Math.sin(seed + dmg * 3) * 0.5 + 0.5) * 0.65);
      const py = y + h * (0.25 + ((c * 17) % 70) * 0.008);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + (c % 2 === 0 ? 8 : -10), py + h * (0.12 + (c % 5) * 0.04));
      ctx.lineTo(px + (c % 3 === 0 ? -6 : 12), py + h * (0.28 + (c % 4) * 0.05));
      ctx.stroke();
    }

    if (ratio < 0.35) {
      ctx.strokeStyle = 'rgba(60,10,20,0.5)';
      ctx.lineWidth = 2;
      for (let c = 0; c < 4; c++) {
        ctx.beginPath();
        ctx.moveTo(x + 10 + c * 12, y + h * 0.5);
        ctx.lineTo(x + 18 + c * 12, y + h * 0.92);
        ctx.stroke();
      }
    }

    const flash = towerHitFlash[side];
    if (flash > 0.02) {
      ctx.fillStyle = 'rgba(255,255,255,' + Math.min(1, flash * 0.85).toFixed(3) + ')';
      ctx.fill(bodyPath);
      ctx.fill(topPath);
    }

    const m = Math.max(0, Math.min(1, (towerImpactMeter[side] || 0) / TOWER_IMPACT_THRESHOLD));
    const bx = x + w * 0.12;
    const by = Math.max(hudTopReservePx + 6, y - h * 0.12);
    const bw = w * 0.76;
    const bh = Math.max(5, h * 0.045);
    ctx.fillStyle = 'rgba(8,8,16,0.55)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = side === 'red' ? 'rgba(255,120,180,0.95)' : 'rgba(120,245,255,0.95)';
    ctx.fillRect(bx + 1, by + 1, Math.max(0, (bw - 2) * m), Math.max(1, bh - 2));
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.restore();
  }

  function drawBullets() {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.t += b.spd;
      if (b.t >= 1) {
        bullets.splice(i, 1);
        continue;
      }
      const x = b.sx + (b.tx - b.sx) * b.t;
      const y = b.sy + (b.ty - b.sy) * b.t;
      const t0 = Math.max(0, b.t - 0.07);
      const tx0 = b.sx + (b.tx - b.sx) * t0;
      const ty0 = b.sy + (b.ty - b.sy) * t0;
      const sizePop = 22 * Math.min(1, 0.45 + b.t * 3.2);
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = 'rgba(255,210,130,0.4)';
      ctx.beginPath();
      ctx.arc(tx0, ty0, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.font = Math.floor(sizePop) + 'px Segoe UI Emoji, Apple Color Emoji';
      ctx.fillText(b.emoji, x, y);
    }
  }

  function easeOutBack(t) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const u = t - 1;
    return 1 + c3 * u * u * u + c1 * u * u;
  }

  function drawFloats() {
    const now = performance.now();
    for (let i = floatTexts.length - 1; i >= 0; i--) {
      const f = floatTexts[i];
      const age = now - (f.born || 0);
      const LIFE = f.crit ? 1500 : 1150;
      if (age >= LIFE) {
        floatTexts.splice(i, 1);
        continue;
      }
      const u = age / LIFE;
      const pop = easeOutBack(Math.min(1, age / 170));
      const settle = u > 0.82 ? 1 - ((u - 0.82) / 0.18) * 0.18 : 1;
      const scale = (f.crit ? 1.32 : 1) * pop * settle;
      const alpha = u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3;
      const rise = age * (f.crit ? 0.032 : 0.024);
      const sway = Math.sin((f.seed || 0) + age * 0.006) * (f.crit ? 3.2 : 1.6);
      const x = f.x + sway;
      const y = f.y - rise;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      if (f.crit) {
        ctx.font = '900 34px Segoe UI, sans-serif';
        ctx.fillStyle = '#fff59d';
        ctx.shadowColor = '#ff2d78';
        ctx.shadowBlur = 18;
        ctx.fillText('💥 ' + f.text, 0, 0);
      } else {
        ctx.font = '800 24px Segoe UI, sans-serif';
        ctx.fillStyle = f.teamColor || '#fff';
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = 7;
        ctx.fillText(f.text, 0, 0);
      }
      if (f.sub) {
        ctx.font = '700 13px Segoe UI, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = 4;
        ctx.fillText(f.sub, 0, f.crit ? 19 : 16);
      }
      ctx.restore();
    }
  }

  function drawLikePops() {
    ctx.textAlign = 'center';
    for (let i = likePopTexts.length - 1; i >= 0; i--) {
      const f = likePopTexts[i];
      const age = performance.now() - (f.born || 0);
      const hold = age < 280;
      if (!hold) {
        f.x += f.vx;
        f.y += f.vy;
      }
      f.a -= hold ? 0.005 : 0.009;
      if (f.a <= 0) {
        likePopTexts.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = Math.max(0, f.a);
      ctx.font = '800 18px Segoe UI, sans-serif';
      ctx.fillStyle = '#d8fff8';
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = 6;
      ctx.fillText(f.text, f.x, f.y);
      ctx.restore();
    }
  }

  function drawLikeBridgePulses() {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = likeBridgePulses.length - 1; i >= 0; i--) {
      const p = likeBridgePulses[i];
      p.t += p.spd * 1.35;
      p.life -= 0.011;
      if (p.t >= 1 || p.life <= 0) {
        likeBridgePulses.splice(i, 1);
        continue;
      }
      const x = p.sx + (p.tx - p.sx) * p.t;
      const y = p.sy + (p.ty - p.sy) * p.t;
      const t0 = Math.max(0, p.t - 0.08);
      const px = p.sx + (p.tx - p.sx) * t0;
      const py = p.sy + (p.ty - p.sy) * t0;
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.strokeStyle = p.trail;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.font = '900 ' + Math.floor(p.size) + 'px Segoe UI Emoji, Apple Color Emoji';
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 9;
      ctx.fillText(p.emoji, x, y);
      ctx.restore();
    }
  }

  function drawTowerBurstEffects() {
    const now = performance.now();
    for (let i = towerBurstEffects.length - 1; i >= 0; i--) {
      const e = towerBurstEffects[i];
      const p = (now - e.born) / e.durationMs;
      if (p >= 1) {
        towerBurstEffects.splice(i, 1);
        continue;
      }
      const inPhase = Math.min(1, p / 0.58);
      const ex = inPhase < 1 ? 1 - Math.pow(1 - inPhase, 3) : 1;
      const tx = W * 0.5;
      const ty = Math.max(hudTopReservePx + 86, H * 0.52);
      const x = e.sx + (tx - e.sx) * ex;
      const y = e.sy + (ty - e.sy) * ex;
      const baseR = 14 + 54 * ex;
      const core = e.side === 'red' ? 'rgba(255,100,160,' : 'rgba(110,235,255,';
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = core + (0.35 + (1 - p) * 0.3) + ')';
      ctx.beginPath();
      ctx.arc(x, y, baseR, 0, Math.PI * 2);
      ctx.fill();
      if (p > 0.58) {
        const q = (p - 0.58) / 0.42;
        const rr = baseR + q * 95;
        ctx.strokeStyle = core + (0.65 * (1 - q)) + ')';
        ctx.lineWidth = 4 + (1 - q) * 2;
        ctx.beginPath();
        ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.font = '900 32px Segoe UI Emoji, Apple Color Emoji';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(255,255,255,' + (0.95 - q * 0.7) + ')';
        ctx.fillText('💥', x, y);
      }
      ctx.restore();
    }
  }

  function drawParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.12;
      p.vx *= 0.995;
      p.life -= 0.014;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      const a = p.life * 0.9;
      if (p.glow) {
        ctx.fillStyle = p.c + a * 0.25 + ')';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = p.c + a + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawShockwaves() {
    for (let i = shockwaves.length - 1; i >= 0; i--) {
      const s = shockwaves[i];
      if (s.r >= s.rMax) {
        shockwaves.splice(i, 1);
        continue;
      }
      s.r += Math.max(2.5, (s.rMax - s.r) * 0.16);
      const k = s.r / s.rMax;
      const a = 0.85 * (1 - k);
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.strokeStyle = 'rgba(' + s.rgb + ',' + a.toFixed(3) + ')';
      ctx.lineWidth = Math.max(1, s.lw * (1 - k));
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawHitGlows() {
    const now = performance.now();
    for (let i = hitGlows.length - 1; i >= 0; i--) {
      const gl = hitGlows[i];
      const age = now - gl.born;
      if (age > 240) {
        hitGlows.splice(i, 1);
        continue;
      }
      const u = age / 240;
      const r = gl.size * (0.55 + u * 0.95);
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      const rg = ctx.createRadialGradient(gl.x, gl.y, 0, gl.x, gl.y, r);
      rg.addColorStop(0, 'rgba(255,255,255,' + (0.85 * (1 - u)).toFixed(3) + ')');
      rg.addColorStop(0.4, 'rgba(' + gl.rgb + ',' + (0.55 * (1 - u)).toFixed(3) + ')');
      rg.addColorStop(1, 'rgba(' + gl.rgb + ',0)');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(gl.x, gl.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawDebris() {
    for (let i = debris.length - 1; i >= 0; i--) {
      const d = debris[i];
      d.x += d.vx;
      d.y += d.vy;
      d.vy += 0.22;
      d.vx *= 0.99;
      d.rot += d.vr;
      d.life -= 0.016;
      if (d.life <= 0 || d.y > H + 30) {
        debris.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(d.rot);
      ctx.globalAlpha = Math.min(1, d.life * 1.4);
      ctx.fillStyle = d.c;
      ctx.fillRect(-d.w * 0.5, -d.h * 0.5, d.w, d.h);
      ctx.restore();
    }
  }

  function drawSmokes() {
    for (let i = smokes.length - 1; i >= 0; i--) {
      const s = smokes[i];
      s.x += s.vx;
      s.y += s.vy;
      s.a -= 0.007;
      s.r += 0.3;
      if (s.a <= 0) {
        smokes.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = s.a;
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r);
      g.addColorStop(0, 'rgba(40,20,60,0.45)');
      g.addColorStop(1, 'rgba(10,5,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawSoldiers() {
    for (let i = soldiers.length - 1; i >= 0; i--) {
      const s = soldiers[i];
      s.x += s.vx;
      s.life -= 0.002;
      if (s.x < -40 || s.x > W + 40 || s.life <= 0) {
        soldiers.splice(i, 1);
        continue;
      }
      const label = truncateNickname(s.label || s.nickname || '', 14);
      const r = 16;
      ctx.save();
      ctx.globalAlpha = Math.min(1, s.life);
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.clip();
      if (s.img) {
        ctx.drawImage(s.img, s.x - r, s.y - r, r * 2, r * 2);
      } else {
        ctx.fillStyle = s.team === 'red' ? 'rgba(255,100,150,0.95)' : 'rgba(100,220,255,0.95)';
        ctx.fill();
      }
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = Math.min(1, s.life);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.stroke();
      if (label) {
        ctx.font = 'bold 10px Segoe UI, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = '#fff';
        ctx.shadowColor = 'rgba(0,0,0,0.85)';
        ctx.shadowBlur = 5;
        ctx.fillText(label, s.x, s.y - r - 4);
        ctx.shadowBlur = 0;
      }
      ctx.restore();
    }
  }

  function drawWelcomeFlies() {
    for (let i = welcomeFlies.length - 1; i >= 0; i--) {
      const w = welcomeFlies[i];
      w.t += 0.018;
      if (w.t >= 1) {
        welcomeFlies.splice(i, 1);
        continue;
      }
      const e = 1 - Math.pow(1 - w.t, 3);
      const x = w.sx + (w.tx - w.sx) * e;
      const y = w.sy + (w.ty - w.sy) * e;
      ctx.save();
      ctx.globalAlpha = 0.95;
      if (w.img) {
        ctx.beginPath();
        ctx.arc(x, y, 22, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(w.img, x - 22, y - 22, 44, 44);
      } else {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(x, y, 18, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function drawConfetti() {
    for (let i = confetti.length - 1; i >= 0; i--) {
      const c = confetti[i];
      c.x += c.vx;
      c.y += c.vy;
      c.rot += c.vr;
      if (c.y > H + 30) {
        confetti.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.fillStyle = 'hsla(' + c.hue + ',90%,62%,0.95)';
      ctx.fillRect(-c.w * 0.5, -c.h * 0.5, c.w, c.h);
      ctx.restore();
    }
  }

  function tick() {
    if (performance.now() < hitStopUntil) {
      requestAnimationFrame(tick);
      return;
    }

    camZoom += (1 - camZoom) * 0.038;
    if (camZoom < 1.0005) camZoom = 1;
    camPanX *= 0.92;
    camPanY *= 0.92;

    let shx = 0;
    let shy = 0;
    if (shakeMag > 0.08) {
      shx = (Math.random() * 2 - 1) * shakeMag;
      shy = (Math.random() * 2 - 1) * shakeMag * 0.85;
      shakeMag *= 0.86;
    } else {
      shakeMag = 0;
    }

    towerHitFlash.red = Math.max(0, towerHitFlash.red - 0.05);
    towerHitFlash.blue = Math.max(0, towerHitFlash.blue - 0.05);
    towerSquash.red *= 0.8;
    towerSquash.blue *= 0.8;
    if (towerSquash.red < 0.002) towerSquash.red = 0;
    if (towerSquash.blue < 0.002) towerSquash.blue = 0;

    updateHpBars();
    updateMatchTimer();

    const cx = W * 0.5;
    const cy = H * 0.5;
    ctx.save();
    ctx.translate(cx + camPanX + shx, cy + camPanY + shy);
    ctx.scale(camZoom, camZoom);
    ctx.translate(-cx, -cy);

    drawBackground();
    drawTower('red');
    drawTower('blue');
    drawTowerBurstEffects();
    (function drawArenaMid() {
      const g = towerGeom();
      const y0 = g.red.y + g.red.h + 3;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 8]);
      ctx.beginPath();
      ctx.moveTo(g.red.x + g.red.w * 0.5, y0);
      ctx.lineTo(g.blue.x + g.blue.w * 0.5, y0);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    })();
    const gr = hpRatio('red');
    const gb = hpRatio('blue');
    if (gr < 0.35 && Math.random() < 0.06) {
      const g = towerGeom();
      smokes.push({
        x: g.red.cx + (Math.random() - 0.5) * g.red.w,
        y: g.red.y + g.red.h,
        vx: (Math.random() - 0.5) * 0.6,
        vy: -0.8 - Math.random(),
        r: 8 + Math.random() * 16,
        a: 0.35,
      });
    }
    if (gb < 0.35 && Math.random() < 0.06) {
      const g = towerGeom();
      smokes.push({
        x: g.blue.cx + (Math.random() - 0.5) * g.blue.w,
        y: g.blue.y + g.blue.h,
        vx: (Math.random() - 0.5) * 0.6,
        vy: -0.8 - Math.random(),
        r: 8 + Math.random() * 16,
        a: 0.35,
      });
    }
    drawSmokes();
    drawHitGlows();
    drawBullets();
    drawParticles();
    drawDebris();
    drawShockwaves();
    drawFloats();
    drawLikePops();
    drawLikeBridgePulses();
    drawSoldiers();
    drawWelcomeFlies();
    drawConfetti();
    updateAndDrawJoinParticles(ctx);
    ctx.restore();

    if (vignetteGrad) {
      ctx.fillStyle = vignetteGrad;
      ctx.fillRect(0, 0, W, H);
    }

    requestAnimationFrame(tick);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function drawGiftThankYouFrame(pw, ph, av, nick, subline) {
    pctx.clearRect(0, 0, pw, ph);
    const bg = pctx.createLinearGradient(0, 0, 0, ph);
    bg.addColorStop(0, '#1a3550');
    bg.addColorStop(1, '#0f1a28');
    pctx.fillStyle = bg;
    pctx.fillRect(0, 0, pw, ph);
    pctx.textAlign = 'center';
    pctx.fillStyle = 'rgba(255,255,255,0.9)';
    pctx.font = '700 13px Segoe UI, sans-serif';
    pctx.fillText('Team support', pw * 0.5, ph * 0.14);
    pctx.fillStyle = 'rgba(255,255,255,0.65)';
    pctx.font = '600 11px Segoe UI, sans-serif';
    pctx.fillText(subline || 'Thanks', pw * 0.5, ph * 0.22);
    const br = Math.min(pw, ph) * 0.11;
    const bx = pw * 0.5;
    const by = ph * 0.48;
    pctx.save();
    pctx.beginPath();
    pctx.arc(bx, by, br, 0, Math.PI * 2);
    pctx.clip();
    if (av) pctx.drawImage(av, bx - br, by - br, br * 2, br * 2);
    else {
      pctx.fillStyle = '#ff6b9d';
      pctx.fillRect(bx - br, by - br, br * 2, br * 2);
    }
    pctx.restore();
    pctx.strokeStyle = 'rgba(255,255,255,0.85)';
    pctx.lineWidth = 3;
    pctx.beginPath();
    pctx.arc(bx, by, br, 0, Math.PI * 2);
    pctx.stroke();
    pctx.fillStyle = 'rgba(255,255,255,0.55)';
    pctx.font = '600 10px Segoe UI, sans-serif';
    const showNick = (nick || 'Guest').slice(0, 18);
    pctx.fillText(showNick, pw * 0.5, ph * 0.72);
  }

  async function runGiftThankYouPanel(ev, subline) {
    const pw = giftDropLogicalW;
    const ph = giftDropLogicalH;
    const nick = (ev.user && ev.user.nickname) || 'Guest';
    giftCaption.textContent = nick + ' — ' + (subline || 'thanks');
    const av = await loadImage(ev.user && ev.user.avatar);
    drawGiftThankYouFrame(pw, ph, av, nick, subline);
    await sleep(250);
  }

  async function processGift(ev) {
    giftOverlay.classList.add('show');
    giftCaption.textContent = '';
    if (LTB) LTB.gift();
    resize();

    await runGiftThankYouPanel(ev, 'Thanks for the support');
    if (ev.doubleBonus) {
      await sleep(80);
      await runGiftThankYouPanel(ev, 'Ek destek kaydedildi');
    }

    giftCaption.textContent =
      ev.caption || (ev.user && ev.user.nickname ? ev.user.nickname + ' — thanks' : 'Thanks');

    gameState = ev.gameState;
    if (ev.bonusPool != null) bonusPool = ev.bonusPool;
    if (ev.comboCount != null) {
      if (ev.comboCount >= 5 && comboCountState < 5 && LTB) LTB.comboFull();
      comboCountState = ev.comboCount;
    }
    const g = towerGeom();
    const target = ev.targetTower;
    const tr = target === 'red' ? g.red : g.blue;
    spawnTowerSparks(tr.cx, tr.cy, Math.min(70, 24 + Math.floor(ev.damage / 80)));
    spawnExplosion(tr.cx, tr.cy, Math.min(500, ev.damage));
    addTowerImpact(target, ev.damage);

    const serverCrit = !!ev.isCrit;
    const isCrit = serverCrit || ev.totalMultiplier >= 50 || ev.damage >= 8000;
    const bigMult = (ev.totalMultiplier >= 25 || ev.damage >= 4000 || (ev.giftDiamondTotal || 0) >= 80);
    spawnTowerHitFx(target, Math.min(2.5, 0.5 + (ev.damage || 0) / 2500), isCrit);
    if (bigMult) {
      bumpCameraToTower(target, 1);
      addShake(5);
    }
    const ra =
      gameState[target] && gameState[target].maxHp
        ? gameState[target].hp / gameState[target].maxHp
        : 1;
    if (ra < 0.12) bumpCameraToTower(target, 1.3);

    if (serverCrit) {
      flashCrit();
      addShake(10);
      triggerHitStop(90);
    }

    spawnFloat(target, '+' + ev.damage + ' points', isCrit, (ev.user && ev.user.nickname) || null);
    if (ev.teamTop) {
      teamTopState = ev.teamTop;
      renderTeamTop();
    }
    if (ev.teamTotals) {
      teamTotalsState = ev.teamTotals;
      renderTeamTotals();
    }
    pushKillFeed(ev);

    updateHud();
    await sleep(250);
    giftOverlay.classList.remove('show');
  }

  function enqueueGift(ev) {
    giftQueue.push(ev);
    drainGift();
  }

  async function drainGift() {
    if (giftBusy) return;
    giftBusy = true;
    while (giftQueue.length) {
      const ev = giftQueue.shift();
      await processGift(ev);
    }
    giftBusy = false;
  }

  function showSpiker(lines) {
    spikerEl.innerHTML = '';
    lines.forEach(function (l) {
      const d = document.createElement('div');
      d.className = 'line';
      d.textContent = l;
      spikerEl.appendChild(d);
    });
    spikerEl.classList.add('show');
    speakSpikerLines(lines);
    setTimeout(function () {
      spikerEl.classList.remove('show');
      spikerEl.innerHTML = '';
    }, 5200);
  }

  function showLeaderboardBrief(entries) {
    if (!leaderboardPanel || !leaderboardList || !entries || !entries.length) return;
    leaderboardList.innerHTML = '';
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const li = document.createElement('li');
      li.textContent = i + 1 + '. ' + (e.nickname || '—') + ' — ' + Math.floor(e.damage || 0) + ' points';
      leaderboardList.appendChild(li);
    }
    leaderboardPanel.classList.add('show');
    setTimeout(function () {
      leaderboardPanel.classList.remove('show');
    }, 9000);
  }

  function showBonusPoolCelebration(amount, winnerName) {
    if (!bonusPoolCelebration || !bonusPoolCelebrationInner) return;
    bonusPoolCelebrationInner.innerHTML =
      '⭐ MATCH BONUS<br/>' +
      Math.floor(amount) +
      ' skor<br/><span style="font-size:70%">' +
      (winnerName || 'Standout') +
      '</span>';
    bonusPoolCelebration.classList.add('show');
    for (let j = 0; j < 220; j++) {
      confetti.push({
        x: Math.random() * W,
        y: -10 - Math.random() * 120,
        vy: 4 + Math.random() * 6,
        vx: (Math.random() - 0.5) * 4,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.2,
        w: 6 + Math.random() * 10,
        h: 4 + Math.random() * 6,
        hue: (Math.random() < 0.5 ? 300 : 170) + Math.random() * 40,
      });
    }
    setTimeout(function () {
      bonusPoolCelebration.classList.remove('show');
    }, 6500);
  }

  function showViewerWelcome(payload) {
    const u = payload.user;
    const name = (u && u.nickname) || 'Player';
    welcomeAvatar.src = (u && u.avatar) || '';
    welcomeTitle.textContent =
      (payload.vip ? '⭐ ' : '') + 'WELCOME ' + name.toUpperCase() + '!';
    welcomeOverlay.classList.add('show');
    if (payload.vip && vipBanner) {
      vipBanner.textContent = '⭐ VIP SUPPORTER - ' + name.toUpperCase();
      vipBanner.classList.add('show');
      playVipChime();
      setTimeout(function () {
        vipBanner.classList.remove('show');
      }, 3800);
    }
    loadImage(u && u.avatar).then((im) => {
      const g = towerGeom();
      const team = payload.team === 'blue' ? 'blue' : 'red';
      const t = team === 'red' ? g.red : g.blue;
      welcomeFlies.push({
        sx: W * 0.5,
        sy: H * 0.5,
        tx: t.cx,
        ty: t.cy,
        t: 0,
        img: im,
      });
      const y0 = team === 'red' ? g.red.cy : g.blue.cy;
      soldiers.push({
        team: team,
        nickname: name,
        label: name,
        x: team === 'red' ? g.red.x - 10 : g.blue.x + g.blue.w + 10,
        y: y0 + (Math.random() - 0.5) * 18,
        vx: team === 'red' ? 2.6 + Math.random() * 1 : -2.6 - Math.random() * 1,
        life: 1,
        img: im,
      });
    });
    setTimeout(function () {
      welcomeOverlay.classList.remove('show');
    }, 1600);
  }

  socket.on('init', function (payload) {
    gameState = payload.gameState;
    powerProgress =
      payload.powerBoost && payload.powerBoost.progress != null ? payload.powerBoost.progress : 0;
    const fu = payload.powerBoost && payload.powerBoost.activeUntil;
    powerUntil = fu && fu > Date.now() ? fu : 0;
    bonusPool = payload.bonusPool != null ? payload.bonusPool : 0;
    comboCountState = payload.comboCount || 0;
    suddenDeathActive = !!payload.suddenDeath;
    matchDurationMs = payload.matchDurationMs || matchDurationMs;
    if (payload.gameStartedAt != null) gameStartedAt = payload.gameStartedAt;
    towerImpactMeter.red = 0;
    towerImpactMeter.blue = 0;
    winnerSide = null;
    if (payload.teamTop) teamTopState = payload.teamTop;
    if (payload.teamTotals) teamTotalsState = payload.teamTotals;
    applyAudioMute();
    syncMusicMode();
    resize();
    renderTeamTop();
    updateHud();
  });

  socket.on('state', function (payload) {
    if (!payload || !payload.gameState) return;
    gameState = payload.gameState;
    if (payload.powerBoost) {
      powerProgress = payload.powerBoost.progress || 0;
      const fu = payload.powerBoost.activeUntil;
      powerUntil = fu && fu > Date.now() ? fu : 0;
    }
    if (payload.bonusPool != null) bonusPool = payload.bonusPool;
    if (payload.comboCount != null) comboCountState = payload.comboCount;
    if (payload.suddenDeath != null) suddenDeathActive = payload.suddenDeath;
    if (payload.matchDurationMs != null) matchDurationMs = payload.matchDurationMs;
    if (payload.teamTop) {
      teamTopState = payload.teamTop;
      renderTeamTop();
    }
    if (payload.teamTotals) {
      teamTotalsState = payload.teamTotals;
      renderTeamTotals();
    }
    syncMusicMode();
    updateHud();
  });

  socket.on('powerMode', function (p) {
    powerProgress = p.powerProgress || 0;
    const fu = p.until;
    powerUntil = fu && fu > Date.now() ? fu : 0;
    if (p && p.active && LTB) LTB.powerOn();
    updateHud();
  });

  socket.on('likeBurst', function (p) {
    powerProgress = p.powerProgress != null ? p.powerProgress : powerProgress;
    const c = p.count || 1;
    spawnEmojiBurst(Math.min(400, c * 3));
    spawnLikePops(c);
    spawnLikeBridgePulse(c);
    if (LTB) LTB.like();
    updateHud();
  });

  socket.on('giftStrike', function (ev) {
    enqueueGift(ev);
  });

  socket.on('viewerJoin', function (payload) {
    showViewerWelcome(payload);
  });

  socket.on('viewerJoinEffect', function (joinData) {
    if (!joinData) return;
    joinQueue.push({
      uniqueId: joinData.uniqueId || '',
      nickname: joinData.nickname || 'Player',
      profilePictureUrl: joinData.profilePictureUrl || '',
    });
  });

  socket.on('viewerCount', function (p) {
    if (p.count != null) {
      viewerBadge.style.display = 'block';
      viewerBadge.textContent = '👀 ' + p.count;
    }
  });

  socket.on('spiker', function (p) {
    if (p.lines && p.lines.length) showSpiker(p.lines);
  });

  socket.on('gameOver', function (p) {
    gameState = p.gameState || gameState;
    updateHud();
    winnerSide = gameState.winner || (p.destroyedTower === 'blue' ? 'red' : 'blue');
    syncMusicMode();
    if (LTB) LTB.fanfare();
    if (p.destroyedTower) {
      const g = towerGeom();
      const dt = p.destroyedTower === 'blue' ? g.blue : g.red;
      const rgb = p.destroyedTower === 'blue' ? '130,245,255' : '255,130,190';
      spawnHitGlow(dt.cx, dt.cy, '255,220,130', 300);
      spawnShockwave(dt.cx, dt.cy, rgb, 340, 7);
      spawnShockwave(dt.cx, dt.cy, '255,255,255', 220, 4);
      spawnExplosion(dt.cx, dt.cy, 600);
      const ca = p.destroyedTower === 'blue' ? 'rgba(120,240,255,0.95)' : 'rgba(255,120,170,0.95)';
      const cb = p.destroyedTower === 'blue' ? 'rgba(20,120,150,0.95)' : 'rgba(150,40,80,0.95)';
      for (let k = 0; k < 3; k++) {
        spawnDebris(dt.cx + (Math.random() - 0.5) * dt.w, dt.y + dt.h * 0.5, 16, ca, cb);
      }
      for (let k = 0; k < 6; k++) {
        smokes.push({
          x: dt.cx + (Math.random() - 0.5) * dt.w,
          y: dt.y + dt.h * (0.3 + Math.random() * 0.5),
          vx: (Math.random() - 0.5) * 0.8,
          vy: -0.9 - Math.random(),
          r: 14 + Math.random() * 22,
          a: 0.5,
        });
      }
      addShake(18);
      triggerHitStop(110);
    }
    const m = p.mvp;
    if (m && m.nickname) {
      mvp.classList.add('show');
      mvpAvatar.src = m.avatar || '';
      const tower = p.destroyedTower === 'blue' ? 'BLUE' : 'RED';
      mvpTitle.textContent =
        tower + ' tower has fallen - match star: ' + (m.nickname || '');
      for (let i = 0; i < 180; i++) {
        confetti.push({
          x: Math.random() * W,
          y: -10 - Math.random() * 100,
          vy: 3 + Math.random() * 5,
          vx: (Math.random() - 0.5) * 3,
          rot: Math.random() * Math.PI,
          vr: (Math.random() - 0.5) * 0.15,
          w: 6 + Math.random() * 8,
          h: 4 + Math.random() * 5,
          hue: Math.random() * 360,
        });
      }
      loadImage(m.avatar);
      setTimeout(function () {
        mvp.classList.remove('show');
      }, 9000);
    }
  });

  socket.on('gameReset', function (p) {
    gameState = p.gameState;
    powerProgress = 0;
    powerUntil = 0;
    towerImpactMeter.red = 0;
    towerImpactMeter.blue = 0;
    winnerSide = null;
    towerHitFlash.red = 0;
    towerHitFlash.blue = 0;
    towerSquash.red = 0;
    towerSquash.blue = 0;
    suddenDeathActive = false;
    mvp.classList.remove('show');
    if (p.gameStartedAt != null) gameStartedAt = p.gameStartedAt;
    if (p.teamTop) teamTopState = p.teamTop;
    if (p.teamTotals) teamTotalsState = p.teamTotals;
    renderTeamTop();
    if (p.leaderboardTop && p.leaderboardTop.length) {
      showLeaderboardBrief(p.leaderboardTop);
    }
    syncMusicMode();
    if (LTB) LTB.resetChime();
    updateHud();
  });

  socket.on('matchConfig', function (p) {
    if (p.matchDurationMs != null) matchDurationMs = p.matchDurationMs;
  });

  socket.on('suddenDeath', function (p) {
    suddenDeathActive = !!(p && p.active);
    if (suddenDeathActive && LTB) LTB.suddenDeath();
    syncMusicMode();
    updateHud();
  });

  socket.on('bonusPoolWin', function (p) {
    bonusPool = 0;
    if (LTB) LTB.coin();
    updateHud();
    const w = (p && p.winner && p.winner.nickname) || (p && p.mvp && p.mvp.nickname) || 'Player';
    showBonusPoolCelebration(p && p.amount != null ? p.amount : 0, w);
  });

  socket.on('soldier', function (s) {
    const g = towerGeom();
    const team = s.team;
    const y = team === 'red' ? g.red.cy : g.blue.cy;
    const nick = (s.user && s.user.nickname) || '';
    soldiers.push({
      team,
      nickname: nick,
      label: nick,
      x: team === 'red' ? g.red.x - 10 : g.blue.x + g.blue.w + 10,
      y: y + (Math.random() - 0.5) * 20,
      vx: team === 'red' ? 2.8 + Math.random() * 1.2 : -2.8 - Math.random() * 1.2,
      life: 1,
      img: null,
    });
    const idx = soldiers.length - 1;
    loadImage(s.user && s.user.avatar).then(function (im) {
      if (soldiers[idx]) soldiers[idx].img = im;
    });
  });

  socket.on('tiktokStatus', function (s) {
    statusEl.textContent = s.msg || '';
  });

  setupAudioUnlockListeners();
  resize();
  requestAnimationFrame(tick);
})();
