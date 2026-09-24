import { auth, api, IS_ELECTRON } from './api.js';
import { MeshClient } from './rtc.js';
import { LiveKitClient } from './livekit-client.js';
// v2.0：媒体面走 LiveKit SFU。保留 MeshClient 作为 2 人降级/回退实现，可通过 ?mesh=1 切回。
const USE_MESH = new URLSearchParams(location.search).has('mesh');
const MediaClient = USE_MESH ? MeshClient : LiveKitClient;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const meetingId = params.get('id');

if (!auth.isLoggedIn) { location.href = '/'; }
if (!meetingId) { location.href = '/'; }

// ---------- state ----------
const me = { peerId: 'self', userId: (auth.user || {}).id, avatar: (auth.user || {}).avatar || null, name: (auth.user || {}).name || '我', isHost: false, micOn: false, camOn: false, sharing: false, camStream: null, screenStream: null };
const participants = new Map(); // peerId -> {peerId,name,isHost,micOn,camOn,sharing,camStream,screenStream}
participants.set('self', me);

const tiles = new Map(); // peerId -> {el, video, avatar, nameEl, micEl, badge}
let client = null;
let policy = { allowMic: false, allowCam: false, allowDanmu: false, locked: false }; // 默认禁参会者开麦/摄像头/弹幕(主持人豁免)；入会后以服务器下发为准

const MIC_ON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="#18b566"><path d="M12 14a3 3 0 003-3V6a3 3 0 00-6 0v5a3 3 0 003 3z"/><path d="M19 11a7 7 0 01-14 0H3a9 9 0 008 8.94V23h2v-3.06A9 9 0 0021 11z"/></svg>`;
const MIC_OFF = `<svg viewBox="0 0 24 24" width="14" height="14" fill="#f5475b"><path d="M12 14a3 3 0 003-3V6a3 3 0 00-6 0v5a3 3 0 003 3z"/><path d="M19 11a7 7 0 01-14 0H3a9 9 0 008 8.94V23h2v-3.06A9 9 0 0021 11z"/><path d="M3 3l18 18" stroke="#f5475b" stroke-width="2.4"/></svg>`;

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

// 屏幕中央矩形提示，显示几秒后淡出（用于「主持人已关闭权限」等需要醒目告知的场景）
function centerNotice(msg) {
  let el = document.getElementById('centerNotice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'centerNotice';
    el.style.cssText = [
      'position:fixed', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
      'z-index:9999', 'background:rgba(20,20,24,.88)', 'color:#fff',
      'padding:18px 30px', 'border-radius:12px', 'font-size:15px', 'font-weight:500', 'line-height:1.5',
      'max-width:70vw', 'text-align:center', 'pointer-events:none', 'white-space:pre-wrap',
      'box-shadow:0 10px 36px rgba(0,0,0,.5)', 'opacity:0', 'transition:opacity .35s ease',
    ].join(';');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  requestAnimationFrame(() => { el.style.opacity = '1'; });
  clearTimeout(centerNotice._t);
  centerNotice._t = setTimeout(() => { el.style.opacity = '0'; }, 2400);
}
const initial = (n) => (n || '?').trim().charAt(0).toUpperCase();
const INVITE_DOMAIN = 'https://meeting.prismglory.org';

// deterministic avatar background color from a key (name/id)
function avatarColor(key) {
  let h = 0; const s = String(key || '?');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 68% 55%), hsl(${(h + 38) % 360} 70% 46%))`;
}
// render a circular avatar element: custom image if present, else colored initial
function paintAvatar(el, p) {
  if (p && p.avatar) {
    el.style.background = '#000';
    el.innerHTML = `<img src="${p.avatar}" alt="">`;
  } else {
    el.style.background = avatarColor(p?.userId ?? p?.name);
    el.textContent = initial(p?.name);
  }
}

// ================= prejoin =================
let pjStream = null;
// 按会议策略置灰「入会开启麦克风/摄像头」并给出原因。
// 不这么做的话，参会者能勾上、本地预览也正常，但入会后会被服务端策略静默拦掉，看起来像功能坏了。
function applyPrejoinPolicy(meeting) {
  const isHost = meeting.hostUserId && auth.user && meeting.hostUserId === auth.user.id;
  const pol = meeting.policy;
  if (isHost || !pol) return;                      // 主持人豁免；老服务端不返回 policy 时保持原行为
  const lock = (id, allowed, what) => {
    const cb = $(id); if (!cb || allowed) return;
    cb.checked = false; cb.disabled = true;
    const label = cb.closest('.opt');
    if (label) { label.classList.add('disabled'); label.title = `主持人未允许参会者开启${what}`; }
  };
  lock('pjMic', pol.allowMic, '麦克风');
  lock('pjCam', pol.allowCam, '摄像头');
  if (!pol.allowMic || !pol.allowCam) {
    const box = document.querySelector('#prejoin .opts');
    if (box && !$('pjPolicyNote')) {
      const n = document.createElement('div');
      n.id = 'pjPolicyNote'; n.className = 'pj-note';
      const off = [!pol.allowMic && '麦克风', !pol.allowCam && '摄像头'].filter(Boolean).join(' / ');
      n.textContent = `主持人当前未允许参会者开启${off}，入会后可请主持人在「设置」中开放。`;
      box.insertAdjacentElement('afterend', n);
    }
  }
}

function initPrejoin() {
  $('pjTitle').textContent = '加入会议';
  // fetch the meeting title in the background — must NOT block wiring of the buttons
  api.getMeeting(meetingId).then(info => {
    $('pjTitle').textContent = info.meeting.title || '加入会议';
    try { applyPrejoinPolicy(info.meeting); } catch {}
  }).catch(() => {});
  $('pjCam').onchange = async () => {
    if ($('pjCam').checked) {
      try {
        pjStream = await navigator.mediaDevices.getUserMedia({ video: true });
        $('pjVideo').srcObject = pjStream; $('pjPh').classList.add('hidden');
      } catch { $('pjCam').checked = false; toast('无法打开摄像头'); }
    } else {
      if (pjStream) pjStream.getTracks().forEach(t => t.stop());
      $('pjVideo').srcObject = null; $('pjPh').classList.remove('hidden');
    }
  };
  $('pjJoin').onclick = () => {
    ensureAudioCtx(); // resume AudioContext on user gesture (for speaking detection)
    const wantMic = $('pjMic').checked, wantCam = $('pjCam').checked;
    if (pjStream) pjStream.getTracks().forEach(t => t.stop());
    $('prejoin').classList.add('hidden');
    $('room').classList.remove('hidden');
    join(wantMic, wantCam);
  };
}

// ================= join / client wiring =================
const fmtMeetingId = (id) => String(id).replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
function showJoinLoading() { $('jlId').textContent = `会议号 ${fmtMeetingId(meetingId)}`; $('joinLoading').classList.remove('hidden'); }
function hideJoinLoading() { clearJoinWatchdog(); $('joinLoading').classList.add('hidden'); }

// 浏览器/WebView 内核版本（安卓上就是「Android System WebView」的版本）
function engineVersion() {
  const m = /(?:Chrome|CriOS)\/(\d+)/.exec(navigator.userAgent);
  return m ? Number(m[1]) : null;
}
const MIN_ENGINE = 100;   // LiveKit 客户端要求的大致下限；低于此版本 connect() 可能永不 resolve

// 内核过旧时，给任何入会失败的提示补一段可操作的说明
function withEngineHint(msg) {
  const v = engineVersion();
  if (v === null || v >= MIN_ENGINE) return msg;
  return `${msg}\n\n检测到浏览器内核版本过低（Chrome ${v}），音视频组件要求 ${MIN_ENGINE} 及以上。\n` +
         `请在应用商店更新「Android System WebView」或系统浏览器后重试。`;
}

// 入会看门狗：connect() 在过旧的 WebView 上会一直挂着不 resolve 也不 reject，
// 界面就永远停在「正在进入会议…」。这里超时后给出可操作的提示，而不是无限转圈。
let joinWatchdog = null;
function clearJoinWatchdog() { if (joinWatchdog) { clearTimeout(joinWatchdog); joinWatchdog = null; } }
function startJoinWatchdog() {
  clearJoinWatchdog();
  joinWatchdog = setTimeout(() => {
    joinWatchdog = null;
    $('joinLoading').classList.add('hidden');
    const v = engineVersion();
    const old = v !== null && v < MIN_ENGINE;
    const msg = old
      ? `进入会议超时。\n\n检测到浏览器内核版本过低（Chrome ${v}），音视频组件要求 ${MIN_ENGINE} 及以上。\n` +
        `请在应用商店更新「Android System WebView」或系统浏览器后重试。`
      : '进入会议超时，可能是网络不稳定或被拦截。\n\n请检查网络后重试。';
    alert(msg);
    leaveToHome();
  }, 30000);
}

async function join(wantMic, wantCam) {
  showJoinLoading();
  startJoinWatchdog();
  $('topId').textContent = `会议号: ${fmtMeetingId(meetingId)}`;
  $('topId').onclick = () => {
    const invite = `邀请你加入 PrismMeet 会议\n会议号：${meetingId}\n点击加入：https://meeting.prismglory.org/join.html?m=${meetingId}`;
    navigator.clipboard?.writeText(invite); toast('邀请信息已复制');
  };
  startTimer();

  client = new MediaClient({ meetingId, token: auth.token });
  // debug hook for automated tests
  window.__PM = { get client() { return client; }, participants, me, tiles, get policy() { return policy; } };

  client.addEventListener('joined', (e) => {
    const d = e.detail;
    me.isHost = d.isHost;
    me.name = (auth.user || {}).name || '我';
    policy = d.policy;
    curOptions = { startAt: d.startAt || null, maxParticipants: d.maxParticipants || null };
    $('topTitle').textContent = d.title || '会议';
    for (const p of d.peers) addParticipant(p);
    applyPolicyUI();
    ensureTile('self'); updateTile('self'); layout(); renderMembers();
    hideJoinLoading(); // 已入会，撤掉加载浮层
  });

  client.addEventListener('peer-joined', (e) => { addParticipant(e.detail.peer); toast(`${e.detail.peer.name} 加入了会议`); layout(); renderMembers(); });
  client.addEventListener('peer-left', (e) => {
    const p = participants.get(e.detail.peerId);
    if (p) toast(`${p.name} 离开了会议`);
    removeParticipant(e.detail.peerId); layout(); renderMembers();
  });

  client.addEventListener('peer-media', (e) => {
    const p = participants.get(e.detail.peerId);
    if (!p) return;
    p.camStream = e.detail.camStream;
    p.screenStream = e.detail.screenStream;
    attachAnalyser(e.detail.peerId, e.detail.camStream);
    updateTile(e.detail.peerId); layout();
  });

  client.addEventListener('peer-state', (e) => {
    const p = participants.get(e.detail.peerId);
    if (!p) return;
    p.micOn = e.detail.micOn; p.camOn = e.detail.camOn; p.sharing = e.detail.sharing;
    updateTile(e.detail.peerId); renderMembers(); layout(); updateToolbar(); // 他人共享变化 -> 刷新本端共享按钮置灰
  });

  client.addEventListener('self-state', (e) => {
    me.micOn = e.detail.micOn; me.camOn = e.detail.camOn; me.sharing = e.detail.sharing;
    updateToolbar(); updateTile('self'); renderMembers();
  });
  client.addEventListener('peer-renamed', (e) => {
    const p = participants.get(e.detail.peerId);
    if (p) { p.name = e.detail.name; updateTile(e.detail.peerId); renderMembers(); layout(); }
  });
  client.addEventListener('self-renamed', (e) => {
    me.name = e.detail.name; updateTile('self'); renderMembers(); layout();
    if ($('setNameInput')) $('setNameInput').value = e.detail.name;
    toast('本次会议昵称已更新为「' + e.detail.name + '」');
  });
  client.addEventListener('local-media', () => { me.camStream = client.localStream; attachAnalyser('self', client.localStream); updateTile('self'); });
  client.addEventListener('local-screen', (e) => { me.screenStream = e.detail.stream; me.sharing = true; updateToolbar(); layout(); });
  client.addEventListener('local-screen-stop', () => { me.screenStream = null; me.sharing = false; updateToolbar(); layout(); });

  client.addEventListener('policy', (e) => {
    policy = e.detail.policy; applyPolicyUI();
    toast('主持人更新了会议设置');
  });
  client.addEventListener('meeting-options', (e) => {
    curOptions = { startAt: e.detail.startAt || null, maxParticipants: e.detail.maxParticipants || null };
    fillHostOptions();
    if (me.isHost) toast('入会限制已更新');
  });
  client.addEventListener('forced', (e) => {
    if (e.detail.action === 'mute') toast('你已被主持人静音');
    if (e.detail.action === 'cam-off') toast('主持人已关闭你的摄像头');
    if (e.detail.action === 'stopShare') toast('主持人已停止你的共享');
    updateToolbar();
  });
  client.addEventListener('chat', (e) => addChat(e.detail.name, e.detail.text, false, e.detail.from === me.peerId));
  client.addEventListener('kicked', () => { alert('你已被主持人移出会议'); leaveToHome(); });
  // 被服务端终态拒绝：会议未开始 / 已达人数上限 / 已锁定 —— 提示后返回首页（不重连）
  client.addEventListener('rejected', (e) => {
    hideJoinLoading();
    // 内核过旧时 LiveKit 会以 "could not establish pc connection" 之类的底层措辞 reject，
    // 对用户毫无指导意义 —— 补一段可操作的说明（实测 Chrome 83 的 WebView 必现）。
    alert(withEngineHint(e.detail.message || '无法加入会议'));
    leaveToHome();
  });
  client.addEventListener('server-error', (e) => toast(e.detail.message));
  client.addEventListener('media-error', (e) => toast(e.detail.message));
  client.addEventListener('share-denied', (e) => toast(`${e.detail.sharerName || '他人'} 正在共享，同一时间只能一人共享`));
  client.addEventListener('reconnecting', (e) => toast(`连接断开，正在重连…（第 ${e.detail.attempt} 次）`));
  client.addEventListener('reconnected', () => toast('已重新连接 ✓'));

  try {
    await client.connect();
    if (wantMic) await client.enableMic();
    if (wantCam) await client.enableCamera();
    updateToolbar();
    hideJoinLoading(); // 兜底：连接成功也撤浮层（若 joined 事件未触发）
  } catch (e) { hideJoinLoading(); alert('加入会议失败：' + e.message); leaveToHome(); }
}

function addParticipant(p) {
  participants.set(p.peerId, { ...p, camStream: null, screenStream: null });
  ensureTile(p.peerId); updateTile(p.peerId);
}
function removeParticipant(peerId) {
  participants.delete(peerId);
  const t = tiles.get(peerId);
  if (t) { t.el.remove(); tiles.delete(peerId); }
}

// ================= tiles & layout =================
function ensureTile(peerId) {
  if (tiles.get(peerId)) return tiles.get(peerId);
  const el = document.createElement('div'); el.className = 'tile'; el.dataset.peer = peerId;
  const video = document.createElement('video'); video.autoplay = true; video.playsInline = true;
  if (peerId === 'self') video.muted = true;
  const avatar = document.createElement('div'); avatar.className = 'avatar-big';
  const circle = document.createElement('div'); circle.className = 'circle'; avatar.appendChild(circle);
  const bar = document.createElement('div'); bar.className = 'tile-bar';
  const micEl = document.createElement('span'); micEl.className = 'mic-ico';
  const nameEl = document.createElement('span'); nameEl.className = 'name';
  const badge = document.createElement('span'); badge.className = 'host-badge hidden'; badge.textContent = '主持人';
  const flag = document.createElement('span'); flag.className = 'share-flag'; flag.textContent = '🖥 共享中';
  bar.append(micEl, nameEl, badge);
  el.append(video, avatar, bar, flag);
  const t = { el, video, avatar, circle, nameEl, micEl, badge, flag };
  tiles.set(peerId, t);
  return t;
}

function updateTile(peerId) {
  const p = participants.get(peerId); const t = tiles.get(peerId);
  if (!p || !t) return;
  t.nameEl.textContent = (peerId === 'self' ? p.name + '（我）' : p.name);
  paintAvatar(t.circle, p);
  t.badge.classList.toggle('hidden', !p.isHost);
  t.micEl.innerHTML = p.micOn ? MIC_ON : MIC_OFF;
  t.el.classList.toggle('is-sharing', !!p.sharing);
  const stream = p.camStream;
  if (stream && t.video.srcObject !== stream) t.video.srcObject = stream;
  // 声画稳定：以「媒体真相」判断是否显示画面，别只看 camOn 标志（它可能比视频轨晚到/漏发 -> 帧已在流却显示头像）。
  //  · self：本端 camOn 就是即时真相（本地轨 muted 恒 false，不能用），按 camOn。
  //  · 远端：有 live 视频轨，且 camOn 为真【或】轨道未 muted（正在收帧）就显示——camOn 晚到也不挡画面。
  const vt = stream && stream.getVideoTracks()[0];
  const camActive = (peerId === 'self')
    ? !!(p.camOn && vt && vt.readyState === 'live')
    : !!(vt && vt.readyState === 'live' && (p.camOn || !vt.muted));
  t.avatar.style.display = camActive ? 'none' : 'flex';
  t.video.style.visibility = camActive ? 'visible' : 'hidden';
}

const hasLiveVideo = (stream) => !!(stream && stream.getVideoTracks().some(tr => tr.readyState === 'live'));
function findPresenter() {
  if (me.sharing && me.screenStream) return 'self';
  // 以媒体真相为准：对端只要有 screenStream 且其中有 live 视频轨就认定在共享，即使 sharing 标志晚到/漏发也能切大画面。
  for (const [id, p] of participants) if (id !== 'self' && hasLiveVideo(p.screenStream)) return id;
  return null;
}

function layout() {
  for (const id of participants.keys()) { ensureTile(id); updateTile(id); }
  const presenter = findPresenter();
  if (presenter) {
    $('grid').classList.add('hidden');
    $('speaker').classList.remove('hidden');
    const p = participants.get(presenter);
    const sv = $('shareVideo');
    if (sv.srcObject !== p.screenStream) sv.srcObject = p.screenStream;
    // 本端共享：大画面必须静音——否则会把采集到的「共享电脑声音」在本机回放，再被采集→回放，形成指数级回环爆炸声。
    // 远端共享时不静音（要能听到对方共享的电脑声音）。
    sv.muted = (presenter === 'self');
    $('shareLabel').textContent = `${presenter === 'self' ? '你' : p.name} 正在共享屏幕`;
    const strip = $('filmstrip');
    for (const [id, t] of tiles) if (t.el.parentElement !== strip) strip.appendChild(t.el);
  } else {
    $('speaker').classList.add('hidden');
    $('grid').classList.remove('hidden');
    const grid = $('grid');
    for (const [id, t] of tiles) if (t.el.parentElement !== grid) grid.appendChild(t.el);
    const n = tiles.size;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  }
}

// 声画稳定兜底：每 2.5s 幂等重放一次「各 tile 渲染 + 布局」，兜住偶发漏掉的事件（meta/peer-state 未触发导致
// 画面没同步过来）。全程只做幂等重判，不重设 srcObject（流对象未变则不动），所以不会打断正在播放的声画。
setInterval(() => { try { for (const id of participants.keys()) updateTile(id); layout(); } catch {} }, 2500);

// ================= toolbar =================
function updateToolbar() {
  const micBtn = $('btnMic'), camBtn = $('btnCam');
  micBtn.classList.toggle('off', !me.micOn);
  micBtn.classList.toggle('active', me.micOn);
  $('micLabel').textContent = me.micOn ? '关闭麦克风' : '开启麦克风';
  camBtn.classList.toggle('off', !me.camOn);
  camBtn.classList.toggle('active', me.camOn);
  $('camLabel').textContent = me.camOn ? '关闭摄像头' : '开启摄像头';
  $('btnShare').classList.toggle('active', me.sharing);
  // ⚠ 必须排除 .ic-wrap：按钮结构是 <span class="ic-wrap"><svg/></span><span>文字</span>，
  //   querySelector('span') 取到的是第一个(图标容器)，会把 SVG 图标整个覆盖成文字，
  //   表现为图标位置显示「共享屏幕」且下方标签重复一次。
  $('btnShare').querySelector('span:not(.ic-wrap)').innerHTML = me.sharing ? '停止<br>共享' : '共享<br>屏幕';
  // 单人共享：已有他人共享时本端共享按钮置灰
  const otherSharing = [...participants].some(([id, p]) => id !== 'self' && p.sharing);
  $('btnShare').classList.toggle('disabled', otherSharing && !me.sharing);
  // policy lock for non-host
  const micBlocked = !policy.allowMic && !me.isHost;
  const camBlocked = !policy.allowCam && !me.isHost;
  micBtn.classList.toggle('disabled', micBlocked && !me.micOn);
  camBtn.classList.toggle('disabled', camBlocked && !me.camOn);
}

$('btnMic').onclick = () => {
  if (me.micOn) { client.disableMic(); return; }
  if (!policy.allowMic && !me.isHost) { centerNotice('主持人已关闭权限，不允许打开麦克风'); return; }
  client.enableMic();
};
$('btnCam').onclick = () => {
  if (me.camOn) { client.disableCamera(); return; }
  if (!policy.allowCam && !me.isHost) { centerNotice('主持人已关闭权限，不允许打开摄像头'); return; }
  client.enableCamera();
};
$('btnShare').onclick = () => {
  if (me.sharing) { client.stopScreenShare(); return; }
  const other = [...participants].find(([id, p]) => id !== 'self' && p.sharing);
  if (other) { toast(`${other[1].name} 正在共享，同一时间只能一人共享`); return; }
  client.startScreenShare();
};
$('btnLeave').onclick = () => { if (confirm('确定离开会议？')) leaveToHome(); };

function leaveToHome() { try { client?.leave(); } catch {} location.href = '/'; }
window.addEventListener('beforeunload', () => { try { client?.leave(); } catch {} });

// ================= invite =================
$('btnInvite').onclick = () => {
  const title = $('topTitle').textContent || '会议';
  const link = `${INVITE_DOMAIN}/join.html?m=${meetingId}`;
  const text = `邀请你参加 PrismMeet 会议\n主题：${title}\n会议号：${meetingId}\n点击加入：${link}`;
  $('invTitle').textContent = title;
  $('invId').textContent = meetingId.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
  const a = $('invLink'); a.textContent = link; a.href = link;
  $('invText').value = text;
  $('inviteModal').classList.remove('hidden');
};
$('invClose').onclick = () => $('inviteModal').classList.add('hidden');

// ================= settings =================
$('btnSettings').onclick = () => {
  $('setNameInput').value = me.name || '';
  $('setHost').classList.toggle('hidden', !me.isHost);     // host-only permission controls
  $('setReadonly').classList.toggle('hidden', me.isHost);  // participants see a note instead
  applyPolicyUI();
  fillHostOptions();
  $('settingsModal').classList.remove('hidden');
};
$('setClose').onclick = () => {
  if (me.isHost && !applyMeetingOptions()) return; // 主持人点「完成」时应用入会限制；校验不过则保持打开让其修正
  $('settingsModal').classList.add('hidden');
};
$('setNameBtn').onclick = () => {
  const name = $('setNameInput').value.trim();
  if (!name) { toast('昵称不能为空'); return; }
  client.setMeetingName(name);
};
$('setNameInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('setNameBtn').click(); });
$('invCopy').onclick = async () => {
  try { await navigator.clipboard.writeText($('invText').value); }
  catch { $('invText').select(); document.execCommand('copy'); }
  toast('邀请信息已复制，发送给参会者即可');
};

// ================= viewer-controlled share fullscreen =================
function toggleShareFs() {
  const el = document.querySelector('.share-main');
  if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => {});
  else document.exitFullscreen?.();
}
$('shareFsBtn').onclick = toggleShareFs;
$('shareVideo').ondblclick = toggleShareFs;

// ================= speaking detection (audio level) =================
let audioCtx = null;
const analysers = new Map(); // peerId -> { an, data, trackId }
function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
function attachAnalyser(peerId, stream) {
  const at = stream && stream.getAudioTracks()[0];
  if (!at) { analysers.delete(peerId); return; }
  const ex = analysers.get(peerId);
  if (ex && ex.trackId === at.id) return;
  try {
    ensureAudioCtx();
    const src = audioCtx.createMediaStreamSource(new MediaStream([at]));
    const an = audioCtx.createAnalyser(); an.fftSize = 512;
    src.connect(an);
    analysers.set(peerId, { an, data: new Uint8Array(an.frequencyBinCount), trackId: at.id });
  } catch {}
}
setInterval(() => {
  for (const [pid, a] of analysers) {
    a.an.getByteTimeDomainData(a.data);
    let sum = 0; for (let i = 0; i < a.data.length; i++) { const d = (a.data[i] - 128) / 128; sum += d * d; }
    const rms = Math.sqrt(sum / a.data.length);
    const p = participants.get(pid);
    const speaking = !!(p && p.micOn && rms > 0.045);
    const t = tiles.get(pid); if (t) t.el.classList.toggle('speaking', speaking);
  }
}, 180);

// ================= drawer: members + chat =================
$('btnMembers').onclick = () => toggleDrawer('members');
$('btnChat').onclick = () => toggleDrawer('chat');
$('tabMembers').onclick = () => switchTab('members');
$('tabChat').onclick = () => switchTab('chat');

let drawerOpen = false, drawerTab = 'members';
function toggleDrawer(tab) {
  if (drawerOpen && drawerTab === tab) { $('drawer').classList.add('hidden'); drawerOpen = false; layout(); return; }
  $('drawer').classList.remove('hidden'); drawerOpen = true; switchTab(tab); layout();
}
function switchTab(tab) {
  drawerTab = tab;
  $('tabMembers').classList.toggle('active', tab === 'members');
  $('tabChat').classList.toggle('active', tab === 'chat');
  $('membersPanel').classList.toggle('hidden', tab !== 'members');
  $('chatPanel').classList.toggle('hidden', tab !== 'chat');
  $('btnMembers').classList.toggle('active', drawerOpen && tab === 'members');
  $('btnChat').classList.toggle('active', drawerOpen && tab === 'chat');
}

function renderMembers() {
  $('memCount').textContent = participants.size;
  const list = $('memberList'); list.innerHTML = '';
  for (const [id, p] of participants) {
    const row = document.createElement('div'); row.className = 'member';
    const av = document.createElement('div'); av.className = 'av'; paintAvatar(av, p);
    const name = document.createElement('div'); name.className = 'mname';
    name.textContent = (id === 'self' ? p.name + '（我）' : p.name) + (p.isHost ? ' · 主持人' : '');
    const stat = document.createElement('div'); stat.className = 'mstat';
    stat.innerHTML = (p.micOn ? MIC_ON : MIC_OFF);
    row.append(av, name, stat);
    // host controls for others
    if (me.isHost && id !== 'self') {
      const ctrl = document.createElement('div'); ctrl.className = 'mctrl';
      if (p.sharing) {
        const ss = document.createElement('button'); ss.textContent = '停止共享'; ss.onclick = () => client.hostStopShare(id);
        ctrl.appendChild(ss);
      }
      if (!p.isHost) {
        const mute = document.createElement('button'); mute.textContent = '静音'; mute.onclick = () => client.hostMute(id);
        const cam = document.createElement('button'); cam.textContent = '关摄像头'; cam.onclick = () => client.hostCamOff(id);
        const kick = document.createElement('button'); kick.textContent = '移出'; kick.onclick = () => { if (confirm(`移出 ${p.name}?`)) client.hostKick(id); };
        ctrl.append(mute, cam, kick);
      }
      if (ctrl.children.length) row.appendChild(ctrl);
    }
    list.appendChild(row);
  }
}

// host policy switches
document.querySelectorAll('#hostPolicy .switch').forEach(sw => {
  sw.onclick = () => {
    const key = sw.dataset.pol;
    const on = !sw.classList.contains('on');
    sw.classList.toggle('on', on);
    client.hostSetPolicy({ [key]: on });
  };
});
$('muteAllBtn').onclick = () => client.hostMuteAll();

// ===== 主持人入会限制：开始时间（年/月/日/时/分 分段）+ 人数上限 =====
let curOptions = { startAt: null, maxParticipants: null };
// 填充下拉项（月1-12 / 日1-31 / 时0-23 / 分0-59），年用数字输入框
(function initTimeSelects() {
  const fill = (id, from, to, pad) => {
    const sel = $(id); if (!sel) return;
    let html = ''; for (let i = from; i <= to; i++) html += `<option value="${i}">${pad ? String(i).padStart(2, '0') : i}</option>`;
    sel.innerHTML = html;
  };
  fill('optMonth', 1, 12); fill('optDay', 1, 31); fill('optHour', 0, 23, true); fill('optMin', 0, 59, true);
})();
function syncTimeFields() {
  const on = $('optTimeOn') && $('optTimeOn').checked;
  ['optYear', 'optMonth', 'optDay', 'optHour', 'optMin'].forEach(id => { if ($(id)) $(id).disabled = !on; });
}
if ($('optTimeOn')) $('optTimeOn').onchange = syncTimeFields;
function fillHostOptions() {
  // 参会时间：已设置则回填并勾选；未设置则默认本机当前时间、不勾选
  const d = curOptions.startAt ? new Date(curOptions.startAt) : new Date();
  if ($('optTimeOn')) $('optTimeOn').checked = !!curOptions.startAt;
  if ($('optYear')) $('optYear').value = d.getFullYear();
  if ($('optMonth')) $('optMonth').value = d.getMonth() + 1;
  if ($('optDay')) $('optDay').value = d.getDate();
  if ($('optHour')) $('optHour').value = d.getHours();
  if ($('optMin')) $('optMin').value = d.getMinutes();
  if ($('optMaxP')) $('optMaxP').value = curOptions.maxParticipants || '';
  syncTimeFields();
}
// 应用「入会限制」(开始时间/人数上限)。在点「完成」时调用；校验失败返回 false 让面板保持打开；无改动则不重复下发。
function applyMeetingOptions() {
  let startAt = null;
  if ($('optTimeOn') && $('optTimeOn').checked) {
    const y = parseInt($('optYear').value, 10);
    if (!Number.isFinite(y) || y < 1970 || y > 9999) { toast('请填写有效年份'); return false; }
    const t = new Date(y, parseInt($('optMonth').value, 10) - 1, parseInt($('optDay').value, 10), parseInt($('optHour').value, 10), parseInt($('optMin').value, 10), 0, 0).getTime();
    if (!Number.isFinite(t)) { toast('参会时间无效'); return false; }
    if (t <= Date.now()) { toast('参会时间需晚于当前时间'); return false; }
    startAt = t;
  }
  let maxParticipants = null;
  const cv = String($('optMaxP').value).trim();
  if (cv !== '') {
    const c = parseInt(cv, 10);
    if (!(c >= 1)) { toast('人数上限最少 1 人'); return false; }
    maxParticipants = c;
  }
  if (startAt === (curOptions.startAt || null) && maxParticipants === (curOptions.maxParticipants || null)) return true; // 无变化
  client.hostSetMeetingOptions({ startAt, maxParticipants });
  return true;
}

function applyPolicyUI() {
  document.querySelectorAll('#hostPolicy .switch').forEach(sw => {
    const key = sw.dataset.pol;
    const val = key === 'locked' ? policy.locked : policy[key];
    sw.classList.toggle('on', !!val);
  });
  updateToolbar();
  // chat input availability
  const chatAllowed = policy.allowDanmu || me.isHost;
  $('chatText').disabled = !chatAllowed; $('chatSend').disabled = !chatAllowed;
  $('chatText').placeholder = chatAllowed ? '发送消息（将以弹幕显示）' : '主持人已关闭聊天';
}

// chat
function addChat(name, text, _sys, mine) {
  const list = $('chatList');
  const div = document.createElement('div'); div.className = 'chat-msg' + (mine ? ' me' : '');
  div.innerHTML = `<div class="who">${escapeHtml(name)}</div><div class="body">${escapeHtml(text)}</div>`;
  list.appendChild(div); list.scrollTop = list.scrollHeight;
  shootDanmu(text);
}
$('chatSend').onclick = sendChat;
$('chatText').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
function sendChat() {
  const txt = $('chatText').value.trim(); if (!txt) return;
  client.sendChat(txt); $('chatText').value = '';
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// danmu overlay
function shootDanmu(text) {
  const layer = $('danmu');
  const item = document.createElement('div'); item.className = 'danmu-item';
  item.textContent = text;
  const top = 10 + Math.floor((Date.now() % 12)) * 6;
  item.style.top = top + '%';
  const dur = 8 + Math.random() * 4;
  item.style.animationDuration = dur + 's';
  layer.appendChild(item);
  setTimeout(() => item.remove(), dur * 1000 + 200);
}

// timer
function startTimer() {
  const t0 = Date.now();
  setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    $('topTimer').textContent = `${mm}:${ss}`;
  }, 1000);
}

// Desktop-first gating: run the meeting only inside the desktop app.
// `?web=1` is allowed ONLY on localhost (self-hosting / automated e2e), never on the
// public site — so production is client-only and the web backdoor is closed.
const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
const allowWeb = IS_ELECTRON || (isLocalHost && new URLSearchParams(location.search).has('web'));
if (allowWeb) {
  bootApp();
} else {
  const gate = $('browserGate');
  gate.classList.remove('hidden');
  $('gateOpen').onclick = () => { location.href = `prismmeet://join/${meetingId}`; };
  $('gateDownload').href = '/'; // marketing site download section
}

// 入会前先查会议是否设置了「计划开始时间」：未到则显示倒计时门禁，到点自动进入预入会页
async function bootApp() {
  let startAt = null, hostUserId = null;
  try { const info = await api.getMeeting(meetingId); startAt = info.meeting?.startAt || null; hostUserId = info.meeting?.hostUserId ?? null; } catch {}
  const iAmHost = hostUserId != null && (auth.user || {}).id === hostUserId;
  // 仅参会者受「开始时间」约束；主持人(设置时间的人)直接进入
  if (startAt && Date.now() < startAt && !iAmHost) { showStartGate(startAt); return; }
  $('prejoin').classList.remove('hidden');
  initPrejoin();
}

function showStartGate(startAt) {
  const p2 = (n) => String(n).padStart(2, '0');
  const d = new Date(startAt);
  const whenStr = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const ov = document.createElement('div');
  ov.id = 'startGate';
  ov.style.cssText = 'position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:#16171a;color:#e9eaed;';
  ov.innerHTML = `
    <div style="text-align:center;max-width:90vw;">
      <div style="font-size:46px;margin-bottom:10px;">⏰</div>
      <div style="font-size:20px;font-weight:600;margin-bottom:8px;">会议尚未开始</div>
      <div style="font-size:14px;color:#9aa0a6;margin-bottom:4px;">将于 <b style="color:#e9eaed;">${whenStr}</b> 开始</div>
      <div id="sgCountdown" style="font-size:34px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:1px;margin:14px 0;">--:--:--</div>
      <div style="font-size:13px;color:#9aa0a6;margin-bottom:20px;">会议号 <b id="sgId" style="color:#e9eaed;cursor:pointer;text-decoration:underline;">${fmtMeetingId(meetingId)}</b>（点击复制分享）</div>
      <button id="sgHome" style="padding:9px 22px;border:none;border-radius:8px;background:#33363d;color:#e9eaed;cursor:pointer;font-size:14px;">返回首页</button>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#sgId').onclick = () => { try { navigator.clipboard?.writeText(meetingId); } catch {} toast('会议号已复制'); };
  ov.querySelector('#sgHome').onclick = () => { location.href = '/'; };
  let iv = 0;
  const tick = () => {
    const left = startAt - Date.now();
    if (left <= 0) {
      clearInterval(iv); ov.remove();
      $('prejoin').classList.remove('hidden'); initPrejoin();
      return;
    }
    const s = Math.floor(left / 1000);
    ov.querySelector('#sgCountdown').textContent = `${p2(Math.floor(s / 3600))}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
  };
  tick(); iv = setInterval(tick, 1000);
}
