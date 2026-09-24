// REST + token helpers shared across pages
const TOKEN_KEY = 'pm_token';
const USER_KEY = 'pm_user';
const VER_KEY = 'pm_app_ver';

// Client version. Bump on each release. If the saved version differs from this,
// the stored login is cleared on launch so the user must log in again.
export const APP_VERSION = '2.0.2';
(function enforceVersionRelogin() {
  try {
    const saved = localStorage.getItem(VER_KEY);
    if (localStorage.getItem(TOKEN_KEY) && saved !== APP_VERSION) {
      // version changed (or first run of versioned client) -> require fresh login
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    }
    localStorage.setItem(VER_KEY, APP_VERSION);
  } catch {}
})();

// Backend base URL. Empty = same origin (browser/dev). Electron sets window.PM_API_BASE.
export const API_BASE = ((typeof window !== 'undefined' && window.PM_API_BASE) || '').replace(/\/$/, '');
export const IS_ELECTRON = !!(typeof window !== 'undefined' && window.PM_ELECTRON);
export function wsBase() {
  if (API_BASE) return API_BASE.replace(/^http/, 'ws');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
}

export const auth = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  get user() { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } },
  set(token, user) { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(USER_KEY, JSON.stringify(user)); },
  clear() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); },
  get isLoggedIn() { return !!this.token; },
  patchUser(patch) { const u = { ...(this.user || {}), ...patch }; localStorage.setItem(USER_KEY, JSON.stringify(u)); return u; },
};

async function req(path, { method = 'GET', body, authed = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authed && auth.token) headers.Authorization = `Bearer ${auth.token}`;
  const res = await fetch(API_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

export const api = {
  sendCode: (phone, purpose) => req('/api/auth/send-code', { method: 'POST', body: { phone, purpose } }),
  check: (field, value) => req(`/api/auth/check?field=${field}&value=${encodeURIComponent(value)}`),
  register: (data) => req('/api/auth/register', { method: 'POST', body: data }),
  login: (identifier, password) => req('/api/auth/login', { method: 'POST', body: { identifier, password } }),
  loginByCode: (phone, code) => req('/api/auth/login', { method: 'POST', body: { phone, code } }),
  resetPassword: (phone, code, password) => req('/api/auth/reset', { method: 'POST', body: { phone, code, password } }),
  // opts: 字符串(仅标题) 或 { title, startAt(ms), maxParticipants }
  createMeeting: (opts) => req('/api/meetings', { method: 'POST', authed: true, body: typeof opts === 'string' ? { title: opts } : (opts || {}) }),
  getMeeting: (id) => req(`/api/meetings/${id}`),
  ice: () => req('/api/ice'),
  setAvatar: (avatar) => req('/api/auth/avatar', { method: 'POST', authed: true, body: { avatar } }),
  setName: (name) => req('/api/auth/profile', { method: 'POST', authed: true, body: { name } }),
};
