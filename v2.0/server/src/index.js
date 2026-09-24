import express from 'express';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { nanoid } from 'nanoid';

import { store } from './store.js';
import authRouter, { requireAuth, verifyToken } from './auth.js';
import { handleConnection } from './rooms.js';
import { LIVEKIT_URL, issueToken, moderate } from './livekit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;

const app = express();

// CORS — the desktop client runs at origin app://local and calls this API cross-origin.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// --- API: auth ---
app.use('/api/auth', authRouter);

// --- API: ICE servers (STUN/TURN) for WebRTC ---
app.get('/api/ice', (req, res) => {
  const iceServers = [];
  // 自建 STUN（coturn 同端口也提供 STUN）——国内可达，替代常被墙的 Google STUN，能拿到 srflx 直连候选、减少中继负载
  if (process.env.TURN_HOST) iceServers.push({ urls: [`stun:${process.env.TURN_HOST}:3478`] });
  iceServers.push({ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }); // 备用(海外用户)
  // Self-hosted coturn with use-auth-secret -> ephemeral TURN REST credentials
  if (process.env.TURN_SECRET && process.env.TURN_HOST) {
    const host = process.env.TURN_HOST;
    const ttl = 24 * 3600;
    const username = `${Math.floor(Date.now() / 1000) + ttl}:prismmeet`;
    const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
    iceServers.push({
      urls: [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`],
      username, credential,
    });
  }
  res.json({ iceServers });
});

// --- API: meetings ---
function genMeetingId() {
  // cryptographically-random 9-digit id (not sequential/guessable), unique in store
  let id;
  do { id = String(crypto.randomInt(100000000, 1000000000)); }
  while (store.getMeeting(id));
  return id;
}

app.post('/api/meetings', requireAuth, (req, res) => {
  // 会议创建即进入，不在此设置开始时间/人数上限——这些由主持人入会后在「设置」里配置。
  const title = (req.body?.title || '').trim() || `${req.user.name} 的会议`;
  const id = genMeetingId();
  store.createMeeting({ id, title, hostUserId: req.user.uid });
  res.json({ meeting: { id, title, hostUserId: req.user.uid } });
});

app.get('/api/meetings/:id', (req, res) => {
  const m = store.getMeeting(req.params.id);
  if (!m) return res.status(404).json({ error: '会议不存在' });
  const host = store.getUserById(m.hostUserId);
  // policy 一并返回：客户端在「预加入」界面就能据此置灰麦克风/摄像头开关并给出提示，
  // 避免参会者勾了却被服务端策略静默拦掉（看起来像功能坏了）。
  res.json({ meeting: { id: m.id, title: m.title, hostUserId: m.hostUserId, hostName: host?.name || '', startAt: m.startAt || null, maxParticipants: m.maxParticipants || null, policy: m.policy || null } });
});

// --- API: 运行时配置下发 ---
// 客户端只硬编码一个【锚点域名】(PM_API_BASE)，其余服务地址一律由服务端下发。
// 这样更换应用服务器 / LiveKit 节点时，只需改边缘反代的上游，客户端无需重新打包。
// ⚠️ LIVEKIT_URL 必须配成边缘域名（wss://<域名>/pmlk），不要写成机器 IP。
app.get('/api/runtime-config', (req, res) => {
  res.json({
    livekitUrl: LIVEKIT_URL,
    // 前端版本门禁：低于此值的客户端会被要求重新登录（见 public/js/api.js）
    appVersion: process.env.PM_APP_VERSION || '2.0.2',
    // 浏览器/WebView 内核下限：LiveKit 客户端在过旧内核上会连接不上
    minEngineVersion: Number(process.env.PM_MIN_ENGINE || 100),
    features: { sms: true, screenShare: true },
    serverTime: Date.now(),
  });
});

// --- API: LiveKit (SFU) —— 媒体面走 LiveKit，会议号即 room ---
app.get('/api/livekit/config', (req, res) => res.json({ url: LIVEKIT_URL }));
app.post('/api/livekit/token', requireAuth, async (req, res) => {
  try {
    const r = await issueToken({ meetingId: String(req.body?.meetingId || ''), user: req.user });
    if (r.error) return res.status(404).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ error: 'token 签发失败：' + (e?.message || e) }); }
});
app.post('/api/livekit/moderate', requireAuth, async (req, res) => {
  try {
    const r = await moderate({ meetingId: String(req.body?.meetingId || ''), user: req.user, action: req.body?.action, target: req.body?.target, patch: req.body?.patch, opts: req.body?.opts });
    if (r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ error: '操作失败：' + (e?.message || e) }); }
});

// --- 可选扩展：src/ext/*.js 若存在则按文件名顺序挂载（目录不存在时跳过）---
//     约定：模块默认导出 register({ app, requireAuth, store })。
try {
  const extDir = join(__dirname, 'ext');
  const files = (await readdir(extDir)).filter((n) => n.endsWith('.js')).sort();
  for (const f of files) {
    const mod = await import(pathToFileURL(join(extDir, f)).href);
    if (typeof mod.default === 'function') mod.default({ app, requireAuth, store });
  }
} catch { /* 没有扩展目录属正常情况 */ }

// --- Static web client ---
app.use(express.static(join(__dirname, '..', 'public')));

const server = createServer(app);

// --- WebSocket signaling ---
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const token = url.searchParams.get('token');
  const meetingId = url.searchParams.get('meetingId');
  const payload = token && verifyToken(token);
  if (!payload || !meetingId) { socket.destroy(); return; }
  const meeting = store.getMeeting(meetingId);
  if (!meeting) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // 心跳存活标记：收到 pong 即视为活着
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    handleConnection(ws, { uid: payload.uid, name: payload.name, email: payload.email }, meetingId);
  });
});

// keepalive + 死连接检测：上一轮没回 pong 的连接判定已死 → terminate（触发 close → 清理 → 广播 peer-left，消除幽灵参会者）
const HEARTBEAT_MS = Number(process.env.PM_HEARTBEAT_MS) || 20000;
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_MS);

server.listen(PORT, () => {
  console.log(`PrismMeet server listening on http://localhost:${PORT}`);
});
