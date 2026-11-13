const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const rooms = new Map();

function id(bytes = 18) { return crypto.randomBytes(bytes).toString('hex'); }
function code() {
  let value;
  do { value = String(100000 + crypto.randomInt(900000)); } while (rooms.has(value));
  return value;
}
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1_000_000) reject(new Error('Request too large')); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function roomFor(req, codeValue) {
  const room = rooms.get(String(codeValue || '').toUpperCase());
  if (!room) throw Object.assign(new Error('Game not found. Check the code and try again.'), { status: 404 });
  const token = req.headers['x-session-token'];
  if (token === room.hostToken) return { room, host: true };
  const player = room.players.find(p => p.token === token);
  if (player) return { room, host: false, player };
  throw Object.assign(new Error('This session has expired. Rejoin the game.'), { status: 401 });
}
function lockQuestion(room) {
  room.phase = 'locked';
  room.deadline = 0;
}
function beginQuestion(room, now = Date.now()) {
  const q = room.questions[room.questionIndex];
  if (!q) { room.phase = 'finished'; room.deadline = 0; room.assigneeId = null; return; }
  room.assigneeId = null;
  room.answered = new Set();
  room.attempts = [];
  room.assignedAttempts = 0;
  if (q.firstTurn && room.players.length) {
    room.phase = 'ready';
    room.assigneeId = room.players[0].id;
    room.deadline = 0;
  } else {
    room.phase = 'open';
    room.deadline = now + q.duration * 1000;
  }
  room.phaseStartedAt = now;
}
function tick(room, now = Date.now()) {
  if (!room.deadline || now < room.deadline) return;
  if (room.phase === 'question') {
    room.phase = 'open';
    room.phaseStartedAt = now;
    room.deadline = now + room.questions[room.questionIndex].duration * 1000;
    const eligible = room.players.filter(p => p.id !== room.assigneeId);
    if (!eligible.length) lockQuestion(room);
  } else if (room.phase === 'open') lockQuestion(room);
}
function publicState(room, player = null, host = false) {
  tick(room);
  const q = room.questions[room.questionIndex] || null;
  const now = Date.now();
  const answeredCount = room.attempts.length;
  const playerAttempts = player ? room.attempts.filter(a => a.playerId === player.id) : [];
  return {
    code: room.code, title: room.title, joinUrl: room.joinUrl, phase: room.phase, questionIndex: room.questionIndex,
    total: room.questions.length, duration: q?.duration || 0,
    remainingPct: room.phase === 'ready' ? 100 : room.deadline ? Math.max(0, Math.min(100, (room.deadline - now) / ((q?.duration || 1) * 10))) : 0,
    deadline: room.deadline, assigneeId: room.assigneeId,
    assigneeName: room.players.find(p => p.id === room.assigneeId)?.name || '',
    answeredCount, players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
    question: q ? { text: q.text, options: q.options, duration: q.duration, firstTurn: q.firstTurn, ...(host || room.phase === 'locked' ? { correct: q.correct } : {}) } : null,
    me: player ? { id: player.id, name: player.name, score: player.score, answered: room.answered.has(player.id) } : null,
    myResult: playerAttempts.length ? playerAttempts[playerAttempts.length - 1] : null,
    results: room.phase === 'locked' ? {
      correct: q?.correct,
      counts: (q?.options || []).map((_, index) => room.attempts.filter(a => a.choice === index).length),
      attempts: room.attempts.map(a => ({ name: room.players.find(p => p.id === a.playerId)?.name || 'Participant', choice: a.choice, correct: a.correct, points: a.points }))
    } : null
  };
}
function localAddress() {
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) for (const item of list || []) {
    if (item.family === 'IPv4' && !item.internal) return item.address;
  }
  return 'localhost';
}
async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/qr') {
    const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
    if (!room) return json(res, 404, { error: 'This room has expired. Create a new quiz to get a fresh QR code.' });
    const svg = await QRCode.toString(room.joinUrl, {
      type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 480,
      color: { dark: '#241642', light: '#FFFFFF' }
    });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(svg);
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const { room, host, player } = roomFor(req, url.searchParams.get('room'));
    return json(res, 200, publicState(room, player, host));
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const data = await readBody(req);
    if (url.pathname === '/api/create') {
      const title = String(data.title || 'Untitled quiz').trim().slice(0, 80);
      if (!Array.isArray(data.questions) || !data.questions.length || data.questions.length > 50) throw Object.assign(new Error('Add between 1 and 50 questions.'), { status: 400 });
      const questions = data.questions.map(q => {
        const text = String(q.text || '').trim().slice(0, 240);
        const options = Array.isArray(q.options) ? q.options.map(a => String(a || '').trim().slice(0, 120)) : [];
        const correct = Number(q.correct), duration = Number(q.duration);
        if (!text || options.length !== 4 || options.some(a => !a) || !Number.isInteger(correct) || correct < 0 || correct > 3 || ![10,15,20,30,45,60].includes(duration)) throw Object.assign(new Error('Every question needs four answers, one correct answer, and a valid time limit.'), { status: 400 });
        return { text, options, correct, duration, firstTurn: Boolean(q.firstTurn) };
      });
      const gameCode = code();
      const room = { code: gameCode, title, joinUrl: '', questions, hostToken: id(24), players: [], phase: 'lobby', questionIndex: -1, deadline: 0, phaseStartedAt: 0, assigneeId: null, assignedAttempts: 0, answered: new Set(), attempts: [] };
      rooms.set(gameCode, room);
      const origin = req.headers.origin || `http://${req.headers.host}`;
      const parsedOrigin = new URL(origin);
      const host = parsedOrigin.hostname;
      const local = ['localhost', '127.0.0.1', '::1'].includes(host);
      const joinBase = local ? `http://${localAddress()}:${PORT}` : parsedOrigin.origin;
      room.joinUrl = `${joinBase}/join?room=${gameCode}`;
      return json(res, 201, { room: gameCode, token: room.hostToken, title, joinUrl: room.joinUrl });
    }
    if (url.pathname === '/api/join') {
      const room = rooms.get(String(data.room || '').toUpperCase());
      if (!room) throw Object.assign(new Error('Game not found. Check the code and try again.'), { status: 404 });
      if (room.phase !== 'lobby') throw Object.assign(new Error('This quiz has already started.'), { status: 409 });
      const name = String(data.name || '').trim().slice(0, 30);
      if (!name) throw Object.assign(new Error('Enter your name to join.'), { status: 400 });
      if (room.players.length >= 100) throw Object.assign(new Error('This room is full.'), { status: 409 });
      const player = { id: id(12), token: id(24), name, score: 0 };
      room.players.push(player);
      return json(res, 201, { token: player.token, title: room.title });
    }
    if (url.pathname === '/api/start') {
      const { room, host } = roomFor(req, data.room); if (!host) throw Object.assign(new Error('Only the host can start the quiz.'), { status: 403 });
      if (room.phase !== 'lobby' || !room.players.length) throw Object.assign(new Error('Wait for at least one participant before starting.'), { status: 409 });
      room.questionIndex = 0; beginQuestion(room); return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/assign') {
      const { room, host } = roomFor(req, data.room); if (!host) throw Object.assign(new Error('Only the host can assign a first turn.'), { status: 403 });
      if (!['ready', 'question'].includes(room.phase) || !room.players.some(p => p.id === data.playerId)) throw Object.assign(new Error('That participant cannot be assigned now.'), { status: 409 });
      room.assigneeId = data.playerId; room.assignedAttempts = 0;
      if (room.phase === 'question') { room.deadline = Date.now() + room.questions[room.questionIndex].duration * 1000; room.phaseStartedAt = Date.now(); }
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/begin-turn') {
      const { room, host } = roomFor(req, data.room); if (!host) throw Object.assign(new Error('Only the host can start the first turn.'), { status: 403 });
      if (room.phase !== 'ready' || !room.assigneeId) throw Object.assign(new Error('Choose a learner before starting the turn.'), { status: 409 });
      room.phase = 'question'; room.phaseStartedAt = Date.now(); room.deadline = Date.now() + room.questions[room.questionIndex].duration * 1000;
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/open') {
      const { room, host } = roomFor(req, data.room); if (!host) throw Object.assign(new Error('Only the host can open the room.'), { status: 403 });
      if (room.phase !== 'question') throw Object.assign(new Error('The first turn is not active.'), { status: 409 });
      room.phase = 'open'; room.phaseStartedAt = Date.now(); room.deadline = Date.now() + room.questions[room.questionIndex].duration * 1000;
      if (!room.players.some(p => p.id !== room.assigneeId)) lockQuestion(room);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/answer') {
      const { room, host, player } = roomFor(req, data.room); if (host) throw Object.assign(new Error('Join as a participant to answer.'), { status: 403 });
      tick(room);
      const q = room.questions[room.questionIndex];
      if (!q || !Number.isInteger(Number(data.choice)) || Number(data.choice) < 0 || Number(data.choice) > 3) throw Object.assign(new Error('Choose one of the answers.'), { status: 400 });
      const choice = Number(data.choice);
      if (room.phase === 'question') {
        if (player.id !== room.assigneeId) throw Object.assign(new Error('The assigned learner gets the first turn.'), { status: 403 });
        if (choice === q.correct) {
          const points = Math.max(100, Math.round(1000 * Math.max(0, room.deadline - Date.now()) / (q.duration * 1000)));
          player.score += points; room.attempts.push({ playerId: player.id, choice, correct: true, points }); lockQuestion(room); return json(res, 200, { ok: true, points, correct: true });
        }
        room.assignedAttempts++;
        room.attempts.push({ playerId: player.id, choice, correct: false, points: 0 });
        return json(res, 200, { ok: true, points: 0, correct: false, retry: true });
      }
      if (room.phase !== 'open') throw Object.assign(new Error('This question is closed.'), { status: 409 });
      if (player.id === room.assigneeId) throw Object.assign(new Error('You had the first turn and cannot retry this question.'), { status: 403 });
      if (room.answered.has(player.id)) throw Object.assign(new Error('You have already answered.'), { status: 409 });
      room.answered.add(player.id);
      let points = 0;
      if (choice === q.correct) {
        points = Math.max(100, Math.round(1000 * Math.max(0, room.deadline - Date.now()) / (q.duration * 1000)));
        player.score += points;
      }
      room.attempts.push({ playerId: player.id, choice, correct: choice === q.correct, points });
      const eligible = room.players.filter(p => p.id !== room.assigneeId);
      if (eligible.every(p => room.answered.has(p.id))) lockQuestion(room);
      return json(res, 200, { ok: true, points, correct: choice === q.correct });
    }
    if (url.pathname === '/api/next') {
      const { room, host } = roomFor(req, data.room); if (!host) throw Object.assign(new Error('Only the host can move to the next question.'), { status: 403 });
      if (!['open', 'locked'].includes(room.phase)) throw Object.assign(new Error('Finish the current question first.'), { status: 409 });
      room.questionIndex++;
      if (room.questionIndex >= room.questions.length) { room.phase = 'finished'; room.deadline = 0; }
      else beginQuestion(room);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/end') {
      const { room, host } = roomFor(req, data.room); if (!host) throw Object.assign(new Error('Only the host can end the session.'), { status: 403 });
      room.phase = 'finished'; room.deadline = 0;
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/leave') {
      const { room, host, player } = roomFor(req, data.room);
      if (host) throw Object.assign(new Error('The host should end the session instead.'), { status: 403 });
      room.players = room.players.filter(p => p.id !== player.id);
      room.answered.delete(player.id);
      if (room.phase === 'ready' && room.assigneeId === player.id) room.assigneeId = room.players[0]?.id || null;
      if (room.phase === 'question' && room.assigneeId === player.id) {
        room.phase = 'open'; room.phaseStartedAt = Date.now(); room.deadline = Date.now() + room.questions[room.questionIndex].duration * 1000;
      }
      if (room.phase === 'open' && room.players.filter(p => p.id !== room.assigneeId).every(p => room.answered.has(p.id))) lockQuestion(room);
      return json(res, 200, { ok: true });
    }
  }
  if (req.method === 'GET') {
    const requested = url.pathname === '/' || url.pathname === '/join' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(ROOT, requested);
    if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) return json(res, 403, { error: 'Forbidden' });
    fs.readFile(file, (error, content) => {
      if (error) return json(res, 404, { error: 'Not found' });
      const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(content);
    });
    return;
  }
  json(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch(error => json(res, error.status || 400, { error: error.message || 'Request failed' }));
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`First Turn is running at http://localhost:${PORT}`);
  const ip = localAddress();
  if (ip !== 'localhost') console.log(`Same-network participants can open http://${ip}:${PORT}`);
});
