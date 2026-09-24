// Dependency-free JSON-file store (works on any Node version; no native deps).
// Data volume is tiny (users + meetings) so a single JSON file is more than enough.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });
const FILE = join(dataDir, 'store.json');

let db = { seqUser: 0, users: [], meetings: {} };
if (existsSync(FILE)) {
  try { db = JSON.parse(readFileSync(FILE, 'utf8')); } catch { /* keep defaults */ }
  db.seqUser ||= 0; db.users ||= []; db.meetings ||= {};
}

let saveTimer = null;
function save() {
  // debounce + atomic write
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(db));
    renameSync(tmp, FILE);
  }, 50);
}

export const store = {
  // name = 显示名(用户名,会议内显示); nickname = 唯一登录昵称(ASCII); phone = 手机号
  createUser({ email, phone, nickname, name, passHash }) {
    const user = { id: ++db.seqUser, email, phone: phone || null, nickname: nickname || null, name, passHash, avatar: null, createdAt: Date.now() };
    db.users.push(user);
    save();
    return user;
  },
  getUserByEmail(email) { const e = String(email || '').toLowerCase(); return db.users.find(u => u.email === e) || null; },
  getUserByPhone(phone) { return db.users.find(u => u.phone && u.phone === phone) || null; },
  getUserByNickname(nick) { const n = String(nick || '').toLowerCase(); return db.users.find(u => u.nickname && u.nickname.toLowerCase() === n) || null; },
  // login identifier: email OR phone OR nickname (case-insensitive for email/nickname)
  getUserByIdentifier(id) { return this.getUserByEmail(id) || this.getUserByPhone(id) || this.getUserByNickname(id); },
  getUserById(id) { return db.users.find(u => u.id === id) || null; },
  setAvatar(id, avatar) { const u = this.getUserById(id); if (u) { u.avatar = avatar; save(); } return u; },
  setName(id, name) { const u = this.getUserById(id); if (u) { u.name = name; save(); } return u; },
  setPassword(id, passHash) { const u = this.getUserById(id); if (u) { u.passHash = passHash; save(); } return u; },

  createMeeting({ id, title, hostUserId, startAt, maxParticipants }) {
    const m = {
      id, title, hostUserId, createdAt: Date.now(),
      startAt: startAt || null,                 // 计划开始时间(epoch ms)，null=立即开始
      maxParticipants: (maxParticipants && maxParticipants > 0) ? Math.floor(maxParticipants) : null, // 人数上限，null=不限
      // 主持人策略：默认禁参会者开麦/摄像头/弹幕、不锁定（主持人豁免）——与老 Mesh 版一致
      policy: { allowMic: false, allowCam: false, allowDanmu: false, locked: false },
    };
    db.meetings[id] = m;
    save();
    return m;
  },
  setMeetingOptions(id, { startAt, maxParticipants } = {}) {
    const m = db.meetings[id]; if (!m) return null;
    m.startAt = startAt || null;
    m.maxParticipants = (maxParticipants && maxParticipants > 0) ? Math.floor(maxParticipants) : null;
    save();
    return m;
  },
  setMeetingPolicy(id, patch = {}) {
    const m = db.meetings[id]; if (!m) return null;
    const cur = m.policy || { allowMic: false, allowCam: false, allowDanmu: false, locked: false };
    const allowed = ['allowMic', 'allowCam', 'allowDanmu', 'locked'];
    for (const k of allowed) if (k in patch) cur[k] = !!patch[k];
    m.policy = cur;
    save();
    return m;
  },
  getMeeting(id) { return db.meetings[id] || null; },
};
