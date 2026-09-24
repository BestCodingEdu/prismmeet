import { api, auth, APP_VERSION } from './api.js';

const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

// version label (bottom-right corner)
const verEl = document.createElement('div');
verEl.textContent = `PrismMeet v${APP_VERSION}`;
verEl.style.cssText = 'position:fixed;right:14px;bottom:10px;font-size:12px;color:#aab2bd;z-index:5;pointer-events:none;';
document.body.appendChild(verEl);

function avatarColor(key) {
  let h = 0; const s = String(key || '?');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 68% 55%), hsl(${(h + 38) % 360} 70% 46%))`;
}
function paintHomeAvatar(u) {
  const av = $('homeAvatar');
  if (u.avatar) { av.style.background = '#000'; av.innerHTML = `<img src="${u.avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`; }
  else { av.innerHTML = ''; av.style.background = avatarColor(u.id ?? u.name); av.textContent = (u.name || 'U').charAt(0).toUpperCase(); }
}

function render() {
  if (auth.isLoggedIn) {
    hide($('authView')); show($('homeView'));
    const u = auth.user || {};
    $('homeName').textContent = u.name || '用户';
    paintHomeAvatar(u);
    if ($('joinName')) $('joinName').value = u.name || '';
    const h = new Date().getHours();
    const part = h < 6 ? '凌晨好' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
    $('greetHi').textContent = `${part}，${u.name || ''} 👋`;
  } else {
    show($('authView')); hide($('homeView'));
  }
}

// ---- auth form switching ----
const forms = ['loginForm', 'registerForm', 'forgotForm'];
function showForm(id) { forms.forEach(f => $(f).classList.toggle('hidden', f !== id)); }
$('toRegister').onclick = (e) => { e.preventDefault(); showForm('registerForm'); };
$('toLogin').onclick = (e) => { e.preventDefault(); showForm('loginForm'); };
$('toLogin2').onclick = (e) => { e.preventDefault(); showForm('loginForm'); };
$('toForgot').onclick = (e) => { e.preventDefault(); showForm('forgotForm'); };

// ---- password show/hide toggles ----
document.querySelectorAll('.pwd-eye').forEach(btn => {
  btn.onclick = () => {
    const inp = $(btn.dataset.for);
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    btn.classList.toggle('on', show);
  };
});

// ---- 60s countdown for code buttons ----
function startCountdown(btn) {
  let n = 60; btn.disabled = true; const orig = '获取验证码';
  btn.textContent = `${n}s`;
  const t = setInterval(() => { n--; btn.textContent = `${n}s`; if (n <= 0) { clearInterval(t); btn.disabled = false; btn.textContent = orig; } }, 1000);
}
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isPhone = (s) => /^1[3-9]\d{9}$/.test(s);
const isNickname = (s) => /^[\x21-\x7E]{3,20}$/.test(s);

// ---- inline field validation (green=ok / red=problem) ----
const setHint = (id, state, text) => { const el = $(id); if (!el) return; el.className = 'hint' + (state ? ' ' + state : ''); el.textContent = text || ''; };
const debounce = (fn, ms = 400) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
async function checkAvail(field, value, id, okText, takenText) {
  setHint(id, 'checking', '检查中…');
  try { const r = await api.check(field, value); setHint(id, r.available ? 'ok' : 'bad', r.available ? okText : takenText); }
  catch { setHint(id, '', ''); }
}
const ckPhone = debounce(v => checkAvail('phone', v, 'hPhone', '✓ 手机号可用', '该手机号已注册'));
function bindRegisterValidation() {
  $('regPhone').addEventListener('input', () => { const v = $('regPhone').value.trim(); if (!v) return setHint('hPhone', '', ''); if (!isPhone(v)) return setHint('hPhone', 'bad', '需 11 位中国大陆手机号'); ckPhone(v); });
  $('regUsername').addEventListener('input', () => { const v = $('regUsername').value.trim(); if (!v) return setHint('hUser', '', ''); setHint('hUser', v.length <= 24 ? 'ok' : 'bad', v.length <= 24 ? '✓ 可用' : '显示名最多 24 个字符'); });
  $('regCode').addEventListener('input', () => { const v = $('regCode').value.trim(); if (!v) return setHint('hCode', '', ''); const okf = /^\d{6}$/.test(v); setHint('hCode', okf ? 'ok' : 'bad', okf ? '✓ 格式正确（提交时校验是否正确）' : '验证码为 6 位数字'); });
  const vP = () => { const v = $('regPass').value; if (!v) return setHint('hPass', '', ''); setHint('hPass', v.length >= 6 ? 'ok' : 'bad', v.length >= 6 ? '✓ 密码长度合格' : '密码至少 6 位'); };
  const vP2 = () => { const a = $('regPass').value, b = $('regPass2').value; if (!b) return setHint('hPass2', '', ''); setHint('hPass2', a === b ? 'ok' : 'bad', a === b ? '✓ 两次密码一致' : '两次输入的密码不一致'); };
  $('regPass').addEventListener('input', () => { vP(); vP2(); });
  $('regPass2').addEventListener('input', vP2);
  // forgot-password fields
  const fg = () => { const v = $('fgPass').value; if (!v) return setHint('hFgPass', '', ''); setHint('hFgPass', v.length >= 6 ? 'ok' : 'bad', v.length >= 6 ? '✓ 密码长度合格' : '新密码至少 6 位'); };
  const fg2 = () => { const a = $('fgPass').value, b = $('fgPass2').value; if (!b) return setHint('hFgPass2', '', ''); setHint('hFgPass2', a === b ? 'ok' : 'bad', a === b ? '✓ 两次密码一致' : '两次输入的密码不一致'); };
  $('fgPass').addEventListener('input', () => { fg(); fg2(); });
  $('fgPass2').addEventListener('input', fg2);
}
bindRegisterValidation();

// ---- send SMS code (register) ----
$('regSendCode').onclick = async () => {
  $('regErr').textContent = '';
  const phone = $('regPhone').value.trim();
  if (!isPhone(phone)) { $('regErr').textContent = '请先填写正确的手机号'; return; }
  $('regSendCode').disabled = true;
  try {
    await api.sendCode(phone, 'register');
    startCountdown($('regSendCode'));
    setHint('hCode', 'ok', `✅ 验证码已发送至 ${phone}`);
  } catch (e) { $('regErr').textContent = e.message; $('regSendCode').disabled = false; }
};

// ---- login (密码 / 短信验证码 两种方式) ----
let loginMode = 'pwd';
function setLoginMode(m) {
  loginMode = m;
  $('loginPwdMode').classList.toggle('hidden', m !== 'pwd');
  $('loginCodeMode').classList.toggle('hidden', m !== 'code');
  $('tabPwd').style.background = m === 'pwd' ? '#eef1ff' : '#f6f7fa';
  $('tabPwd').style.fontWeight = m === 'pwd' ? '600' : '400';
  $('tabCode').style.background = m === 'code' ? '#eef1ff' : '#f6f7fa';
  $('tabCode').style.fontWeight = m === 'code' ? '600' : '400';
  $('loginErr').textContent = '';
}
$('tabPwd').onclick = () => setLoginMode('pwd');
$('tabCode').onclick = () => setLoginMode('code');

$('loginSendCode').onclick = async () => {
  $('loginErr').textContent = '';
  const phone = $('loginCodePhone').value.trim();
  if (!isPhone(phone)) { $('loginErr').textContent = '请先填写正确的手机号'; return; }
  $('loginSendCode').disabled = true;
  try { await api.sendCode(phone, 'login'); startCountdown($('loginSendCode')); }
  catch (e) { $('loginErr').textContent = e.message; $('loginSendCode').disabled = false; }
};

$('loginBtn').onclick = async () => {
  $('loginErr').textContent = '';
  $('loginBtn').disabled = true;
  try {
    let r;
    if (loginMode === 'code') {
      const phone = $('loginCodePhone').value.trim(), code = $('loginCode').value.trim();
      if (!isPhone(phone)) throw new Error('手机号格式不正确');
      if (!/^\d{6}$/.test(code)) throw new Error('请输入 6 位短信验证码');
      r = await api.loginByCode(phone, code);
    } else {
      r = await api.login($('loginId').value.trim(), $('loginPass').value);
    }
    auth.set(r.token, r.user); render();
  } catch (e) { $('loginErr').textContent = e.message; }
  finally { $('loginBtn').disabled = false; }
};
$('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginBtn').click(); });
$('loginCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginBtn').click(); });

// ---- register (手机号 + 短信验证码 + 显示名 + 密码) ----
$('regBtn').onclick = async () => {
  $('regErr').textContent = '';
  const phone = $('regPhone').value.trim();
  const code = $('regCode').value.trim();
  const name = $('regUsername').value.trim();
  const pass = $('regPass').value, pass2 = $('regPass2').value;
  if (!isPhone(phone)) return ($('regErr').textContent = '手机号格式不正确（11 位中国大陆手机号）');
  if (!/^\d{6}$/.test(code)) return ($('regErr').textContent = '请输入 6 位短信验证码');
  if (!name) return ($('regErr').textContent = '请填写显示名（会议中显示的名字）');
  if (pass.length < 6) return ($('regErr').textContent = '密码至少 6 位');
  if (pass !== pass2) return ($('regErr').textContent = '两次输入的密码不一致');
  $('regBtn').disabled = true;
  try {
    const r = await api.register({ phone, name, password: pass, code });
    auth.set(r.token, r.user); render();
  } catch (e) { $('regErr').textContent = e.message; }
  finally { $('regBtn').disabled = false; }
};

// ---- forgot password (手机短信验证) ----
$('fgSendCode').onclick = async () => {
  $('fgErr').textContent = '';
  const phone = $('fgPhone').value.trim();
  if (!isPhone(phone)) { $('fgErr').textContent = '请先填写正确的手机号'; return; }
  $('fgSendCode').disabled = true;
  try { await api.sendCode(phone, 'reset'); startCountdown($('fgSendCode')); }
  catch (e) { $('fgErr').textContent = e.message; $('fgSendCode').disabled = false; }
};
$('fgBtn').onclick = async () => {
  $('fgErr').textContent = '';
  const phone = $('fgPhone').value.trim(), code = $('fgCode').value.trim();
  const pass = $('fgPass').value, pass2 = $('fgPass2').value;
  if (!isPhone(phone)) return ($('fgErr').textContent = '手机号格式不正确');
  if (!/^\d{6}$/.test(code)) return ($('fgErr').textContent = '请输入 6 位验证码');
  if (pass.length < 6) return ($('fgErr').textContent = '新密码至少 6 位');
  if (pass !== pass2) return ($('fgErr').textContent = '两次输入的密码不一致');
  $('fgBtn').disabled = true;
  try {
    await api.resetPassword(phone, code, pass);
    $('fgErr').textContent = '';
    alert('密码重置成功，请用新密码登录');
    $('loginId').value = phone; showForm('loginForm');
  } catch (e) { $('fgErr').textContent = e.message; }
  finally { $('fgBtn').disabled = false; }
};

$('logoutBtn').onclick = () => { auth.clear(); location.reload(); };

// ---- change avatar ----
const avFile = document.createElement('input'); avFile.type = 'file'; avFile.accept = 'image/*'; avFile.style.display = 'none';
document.body.appendChild(avFile);
$('homeAvatar').style.cursor = 'pointer';
$('homeAvatar').title = '点击更换头像';
$('homeAvatar').onclick = () => avFile.click();
avFile.onchange = () => {
  const f = avFile.files[0]; if (!f) return;
  const img = new Image();
  img.onload = async () => {
    // center-crop to square, scale to 160px, export optimized JPEG
    const S = 160, c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d');
    const side = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
    const dataUrl = c.toDataURL('image/jpeg', 0.85);
    try {
      await api.setAvatar(dataUrl);
      auth.patchUser({ avatar: dataUrl });
      paintHomeAvatar(auth.user);
    } catch (e) { alert('头像上传失败：' + e.message); }
  };
  img.src = URL.createObjectURL(f);
};

// ---- change nickname ----
$('homeName').style.cursor = 'pointer';
$('homeName').title = '点击修改昵称';
$('homeName').onclick = async () => {
  const name = prompt('修改昵称：', (auth.user || {}).name || '');
  if (name === null) return;
  const t = name.trim(); if (!t) { alert('昵称不能为空'); return; }
  try {
    const r = await api.setName(t);
    auth.set(r.token, { ...(auth.user || {}), ...r.user });
    render();
  } catch (e) { alert('修改失败：' + e.message); }
};

// ---- meeting actions ----
const fmtId = (id) => String(id).replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
function showEnter(title, id) { $('elTitle').textContent = title; $('elId').textContent = id ? `会议号 ${fmtId(id)}` : ''; show($('enterLoading')); }
function hideEnter() { hide($('enterLoading')); }

// 快速会议：立即创建并进入（主持人先进去，再在「设置」里配置开始时间/人数上限）
$('cardQuick').onclick = async () => {
  showEnter('正在创建会议…');
  try {
    const r = await api.createMeeting('');
    location.href = `/meeting.html?id=${r.meeting.id}`;
  } catch (e) { hideEnter(); alert(e.message); }
};

$('cardBook').onclick = async () => {
  const title = prompt('会议主题：', `${(auth.user||{}).name||''} 预定的会议`);
  if (title === null) return;
  showEnter('正在创建会议…');
  try {
    const r = await api.createMeeting(title);
    prompt('会议已创建，会议号（复制分享给参会者）：', r.meeting.id);
    location.href = `/meeting.html?id=${r.meeting.id}`;
  } catch (e) { hideEnter(); alert(e.message); }
};

$('cardJoin').onclick = () => { $('joinErr').textContent=''; show($('joinModal')); try { window.focus(); } catch {} setTimeout(() => $('joinId').focus(), 0); };
$('joinCancel').onclick = () => hide($('joinModal'));
$('joinGo').onclick = async () => {
  const id = $('joinId').value.trim();
  if (!/^\d{9}$/.test(id)) { $('joinErr').textContent = '请输入 9 位数字会议号'; return; }
  showEnter('正在进入会议…', id);
  try {
    await api.getMeeting(id); // verify exists
    location.href = `/meeting.html?id=${id}`;
  } catch (e) { hideEnter(); $('joinErr').textContent = e.message; }
};
$('joinId').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinGo').click(); });
// auto-extract the 9-digit meeting number from pasted invite text
const extractId = (t) => { const m = String(t).match(/(?<!\d)(\d{9})(?!\d)/); return m ? m[1] : null; };
$('joinId').addEventListener('paste', (e) => {
  const t = (e.clipboardData || window.clipboardData).getData('text');
  const id = extractId(t);
  if (id) { e.preventDefault(); $('joinId').value = id; $('joinErr').textContent = ''; }
});
$('joinId').addEventListener('input', () => {
  const v = $('joinId').value;
  if (/\D/.test(v)) { $('joinId').value = extractId(v) || v.replace(/\D/g, '').slice(0, 9); }
});

render();
