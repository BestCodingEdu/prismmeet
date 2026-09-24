import express from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { store } from './store.js';
import { sendSmsCode, smsEnabled } from './sms.js';

export const JWT_SECRET = process.env.JWT_SECRET || 'prismmeet-dev-secret-change-me';
const TOKEN_TTL = '30d';

export function signToken(user) {
  return jwt.sign({ uid: user.id, name: user.name, phone: user.phone || null, email: user.email || null }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}
export function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}
export function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: '未登录或登录已过期' });
  req.user = payload;
  next();
}

// ---------------- validators ----------------
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isPhone = (s) => typeof s === 'string' && /^1[3-9]\d{9}$/.test(s);      // 中国大陆手机号
const isCode = (s) => typeof s === 'string' && /^\d{6}$/.test(s);
const publicUser = (u) => ({ id: u.id, name: u.name, phone: u.phone || null, email: u.email || null, nickname: u.nickname || null, avatar: u.avatar || null });

// ---------------- verification codes (in-memory, keyed by phone) ----------------
const codes = new Map(); // key `${purpose}:${phone}` -> { code, expires, attempts, lastSent, dayCount, dayStart }
const TTL = 10 * 60 * 1000, RESEND = 60 * 1000, DAY = 24 * 3600 * 1000, DAY_CAP = 15;

function issueCode(phone, purpose) {
  const key = `${purpose}:${phone}`;
  const now = Date.now();
  const e = codes.get(key);
  if (e && now - e.lastSent < RESEND) return { error: '验证码发送过于频繁，请稍后再试' };
  let dayStart = e?.dayStart || now, dayCount = e?.dayCount || 0;
  if (now - dayStart > DAY) { dayStart = now; dayCount = 0; }
  if (dayCount >= DAY_CAP) return { error: '今日验证码发送次数过多，请明天再试' };
  const code = String(crypto.randomInt(100000, 1000000));
  codes.set(key, { code, expires: now + TTL, attempts: 0, lastSent: now, dayCount: dayCount + 1, dayStart });
  return { code };
}
function checkCode(phone, purpose, input) {
  const key = `${purpose}:${phone}`;
  const e = codes.get(key);
  if (!e) return '请先获取验证码';
  if (Date.now() > e.expires) { codes.delete(key); return '验证码已过期，请重新获取'; }
  if (e.attempts >= 5) { codes.delete(key); return '验证码错误次数过多，请重新获取'; }
  if (String(input) !== e.code) { e.attempts++; return '验证码错误'; }
  codes.delete(key);
  return null; // ok
}

const router = express.Router();

// ---------------- send SMS verification code (register / login / reset) ----------------
router.post('/send-code', async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  const purpose = ['register', 'login', 'reset'].includes(req.body?.purpose) ? req.body.purpose : 'register';
  if (!isPhone(phone)) return res.status(400).json({ error: '手机号格式不正确（需 11 位中国大陆手机号）' });

  const exists = store.getUserByPhone(phone);
  if (purpose === 'register' && exists) return res.status(409).json({ error: '该手机号已注册，请直接登录' });
  if ((purpose === 'login' || purpose === 'reset') && !exists) return res.status(404).json({ error: '该手机号未注册' });

  const r = issueCode(phone, purpose);
  if (r.error) return res.status(429).json({ error: r.error });

  // test-only: expose code in response (绝不在生产开启)
  if (process.env.PM_EXPOSE_CODE === '1') return res.json({ ok: true, code: r.code });

  if (!smsEnabled()) return res.status(503).json({ error: '短信服务未配置，暂时无法发送验证码' });
  try {
    const { sentCode } = await sendSmsCode(phone, r.code);
    // 若阿里云自动生成了验证码(##code##模板)，用其实际下发的码覆盖本地待校验码
    if (sentCode && sentCode !== r.code) {
      const e = codes.get(`${purpose}:${phone}`);
      if (e) e.code = String(sentCode);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[sms] send failed:', e.message);
    res.status(502).json({ error: '验证码短信发送失败，请稍后再试' });
  }
});

// ---------------- live field check (format + availability) ----------------
router.get('/check', (req, res) => {
  const field = req.query.field;
  const value = String(req.query.value || '').trim();
  let valid = false, available = true;
  if (field === 'phone') { valid = isPhone(value); if (valid) available = !store.getUserByPhone(value); }
  else if (field === 'email') { valid = isEmail(value); if (valid) available = !store.getUserByEmail(value.toLowerCase()); }
  else return res.status(400).json({ error: 'bad field' });
  res.json({ valid, available });
});

// ---------------- register: phone + SMS code + display name + password ----------------
router.post('/register', (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  const name = String(req.body?.name || '').trim();   // 显示名(会议内显示)
  const password = req.body?.password || '';
  const code = String(req.body?.code || '').trim();

  if (!isPhone(phone)) return res.status(400).json({ error: '手机号格式不正确（需 11 位中国大陆手机号）' });
  if (name.length < 1 || name.length > 24) return res.status(400).json({ error: '显示名需为 1-24 个字符' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (!isCode(code)) return res.status(400).json({ error: '请输入 6 位短信验证码' });

  if (store.getUserByPhone(phone)) return res.status(409).json({ error: '该手机号已注册' });

  const codeErr = checkCode(phone, 'register', code);
  if (codeErr) return res.status(400).json({ error: codeErr });

  const hash = bcrypt.hashSync(password, 10);
  const user = store.createUser({ email: null, phone, nickname: null, name, passHash: hash });
  res.json({ token: signToken(user), user: publicUser(user) });
});

// ---------------- login: (手机号/邮箱 + 密码)  OR  (手机号 + 短信验证码) ----------------
router.post('/login', (req, res) => {
  const code = String(req.body?.code || '').trim();

  // 短信验证码登录
  if (code) {
    const phone = String(req.body?.phone || req.body?.identifier || '').trim();
    if (!isPhone(phone)) return res.status(400).json({ error: '手机号格式不正确' });
    const row = store.getUserByPhone(phone);
    if (!row) return res.status(404).json({ error: '该手机号未注册' });
    const codeErr = checkCode(phone, 'login', code);
    if (codeErr) return res.status(400).json({ error: codeErr });
    return res.json({ token: signToken(row), user: publicUser(row) });
  }

  // 密码登录（账号 = 手机号 或 老用户邮箱/昵称）
  const identifier = String(req.body?.identifier || req.body?.phone || req.body?.email || '').trim();
  const password = req.body?.password || '';
  if (!identifier || !password) return res.status(400).json({ error: '请输入账号和密码' });
  const row = store.getUserByIdentifier(identifier);
  if (!row || !bcrypt.compareSync(password, row.passHash)) {
    return res.status(401).json({ error: '账号或密码错误' });
  }
  res.json({ token: signToken(row), user: publicUser(row) });
});

// ---------------- forgot password: reset with SMS code ----------------
router.post('/reset', (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  const code = String(req.body?.code || '').trim();
  const password = req.body?.password || '';
  if (!isPhone(phone)) return res.status(400).json({ error: '手机号格式不正确' });
  if (password.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  const row = store.getUserByPhone(phone);
  if (!row) return res.status(404).json({ error: '该手机号未注册' });
  const codeErr = checkCode(phone, 'reset', code);
  if (codeErr) return res.status(400).json({ error: codeErr });
  store.setPassword(row.id, bcrypt.hashSync(password, 10));
  res.json({ ok: true });
});

// ---------------- profile ----------------
router.get('/me', requireAuth, (req, res) => {
  const row = store.getUserById(req.user.uid);
  res.json({ user: row ? publicUser(row) : { id: req.user.uid, name: req.user.name, phone: req.user.phone || null } });
});

router.post('/profile', requireAuth, (req, res) => {
  const name = (req.body?.name || '').trim();
  if (name.length < 1 || name.length > 24) return res.status(400).json({ error: '显示名需为 1-24 个字符' });
  store.setName(req.user.uid, name);
  const row = store.getUserById(req.user.uid);
  res.json({ token: signToken(row), user: publicUser(row) });
});

router.post('/avatar', requireAuth, (req, res) => {
  const { avatar } = req.body || {};
  if (typeof avatar !== 'string' || !avatar.startsWith('data:image/')) return res.status(400).json({ error: '头像格式不正确' });
  if (avatar.length > 400 * 1024) return res.status(413).json({ error: '头像过大（请使用更小的图片）' });
  store.setAvatar(req.user.uid, avatar);
  res.json({ ok: true, avatar });
});

export default router;
