// LiveKitClient —— 与 rtc.js 的 MeshClient 同接口、同事件的媒体客户端，媒体面走 LiveKit SFU。
// 目标：meeting.js 只把 `new MeshClient(...)` 换成 `new LiveKitClient(...)`，UI 完全复用。
//
// 事件对齐 MeshClient：joined / peer-joined / peer-left / peer-media / peer-state / self-state /
//   chat / policy / meeting-options / forced / kicked / rejected / server-error / media-error /
//   share-denied / reconnecting / reconnected / local-media / local-screen / local-screen-stop / conn-state
import { API_BASE, auth } from './api.js';
import {
  Room, RoomEvent, Track, ConnectionState, DisconnectReason,
} from './vendor/livekit-client.esm.js';

// 把 Room 暴露到页面全局，供 Electron 预加载脚本复用。
// ⚠️ 预加载脚本是 CommonJS 上下文，在里面 `import('/js/vendor/livekit-client.esm.js')` 会走
//    Node 的 ESM 加载器（而非页面的模块加载器），实测会让渲染进程直接崩溃（表现为软件黑屏）。
//    所以预加载脚本一律用 window.__LK，不要自己去 import。
try { window.__LK = { Room, RoomEvent, Track }; } catch {}

export class LiveKitClient extends EventTarget {
  constructor({ meetingId, token }) {
    super();
    this.meetingId = meetingId;
    this._appToken = token;          // 我们自己的登录 JWT，用于换取 LiveKit token
    this.selfId = null;              // = LiveKit 本地 identity（我们的 uid）
    this.isHost = false;
    // 临时放宽策略以便媒体可用与测试；完整主持人策略下发在后续迭代（room metadata）。
    this.policy = { allowMic: true, allowCam: true, allowDanmu: true, locked: false };
    this.micOn = false; this.camOn = false; this.sharing = false;
    this.localStream = new MediaStream();
    this.room = null;
    this._name = '';                 // 本端显示名（用于聊天载荷带发送者名）
    this._names = new Map();         // identity -> 最新改名（防 rename 早于 peer-joined 到达而丢失）
    this._remote = new Map();        // identity -> { camStream, screenStream }
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async connect() {
    // 1) 用我们的 JWT 找后端换 LiveKit token
    let cfg;
    try {
      const r = await fetch(API_BASE + '/api/livekit/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this._appToken}` },
        body: JSON.stringify({ meetingId: this.meetingId }),
      });
      cfg = await r.json();
      if (!r.ok || cfg.error) { this.emit('rejected', { message: cfg.error || '无法加入会议', code: cfg.code }); throw new Error(cfg.error || 'token 获取失败'); }
    } catch (e) { if (!cfg || !cfg.error) this.emit('rejected', { message: e.message || '无法加入会议' }); throw e; }

    this.selfId = cfg.identity;
    this.isHost = !!cfg.isHost;
    this._name = (auth.user && auth.user.name) || '';
    if (cfg.policy) this.policy = cfg.policy;             // 入会时的权威策略（来自后端 store）
    this._startAt = cfg.startAt || null;
    this._maxParticipants = cfg.maxParticipants || null;

    // 2) 连接房间。dynacast 保留（发布端按需停层）；adaptiveStream 暂关：
    //    它按"元素可见性"决定订阅，而本适配器自建 MediaStream（未用 track.attach），会导致不自动订阅。
    //    后续若改用 track.attach 渲染可再开启以省带宽。
    this.room = new Room({ adaptiveStream: false, dynacast: true });
    this._wire();
    try {
      await this.room.connect(cfg.url, cfg.token);
    } catch (e) { this.emit('rejected', { message: '媒体服务器连接失败：' + (e.message || e) }); throw e; }

    // 3) 广播 joined（把已在房间的人作为 peers 交给 UI）
    const peers = [];
    for (const p of this.room.remoteParticipants.values()) peers.push(this._peerInfo(p));
    this.emit('joined', {
      selfId: this.selfId, isHost: this.isHost, title: '', policy: this.policy,
      peers, startAt: this._startAt, maxParticipants: this._maxParticipants,
    });
    this._reportState();
    // ⚠ 顺序关键：必须在 emit('joined')【之后】才对已在房间的远端做 _reconcile。
    //   否则连接期间已订阅轨触发的 peer-media 会因 meeting.js 尚未建好该参会者而被丢弃
    //   （表现为"后加入者看不到先在场者的视频"）。这里 joined 已建好参会者，再补发媒体即可渲染。
    for (const p of this.room.remoteParticipants.values()) this._reconcile(p);
  }

  _peerInfo(p) {
    // participant metadata 由服务端签 token 时写入（至少含 isHost）。
    // 这里把解析结果原样挂到 meta，上层可直接读服务端附加的其它标记，无需改动本文件。
    let meta = {}; try { meta = JSON.parse(p.metadata || '{}') || {}; } catch {}
    return {
      peerId: p.identity, name: this._names.get(p.identity) || p.name || p.identity,
      isHost: !!meta.isHost, meta,
      micOn: !p.isMicrophoneEnabled ? false : true, camOn: p.isCameraEnabled, sharing: p.isScreenShareEnabled,
    };
  }

  _wire() {
    const R = this.room;
    R.on(RoomEvent.ParticipantConnected, (p) => {
      this.emit('peer-joined', { peer: this._peerInfo(p) });
      this._reconcile(p);
    });
    R.on(RoomEvent.ParticipantDisconnected, (p) => {
      this._remote.delete(p.identity);
      this.emit('peer-left', { peerId: p.identity });
    });
    R.on(RoomEvent.TrackSubscribed, (_t, _pub, p) => this._reconcile(p));
    R.on(RoomEvent.TrackUnsubscribed, (_t, _pub, p) => this._reconcile(p));
    R.on(RoomEvent.TrackMuted, (pub, p) => {
      if (p === R.localParticipant) {
        // 本端被服务端强制静音/关摄像头/停共享（主持人管控）
        if (pub.source === Track.Source.Microphone) { this.micOn = false; this.emit('forced', { action: 'mute' }); this._reportState(); }
        else if (pub.source === Track.Source.Camera) { this.camOn = false; this.emit('forced', { action: 'cam-off' }); this._reportState(); }
        else if (pub.source === Track.Source.ScreenShare) { this.sharing = false; this.emit('forced', { action: 'stopShare' }); this._reportState(); }
      } else { this._emitState(p); }
    });
    R.on(RoomEvent.TrackUnmuted, (_pub, p) => { if (p === R.localParticipant) this._reportState(); else this._emitState(p); });
    R.on(RoomEvent.RoomMetadataChanged, (metadata) => this._applyMeta(metadata));
    R.on(RoomEvent.LocalTrackPublished, () => this._reportState());
    R.on(RoomEvent.LocalTrackUnpublished, () => this._reportState());
    R.on(RoomEvent.ActiveSpeakersChanged, () => {/* 说话人检测由 meeting.js 的 analyser 处理，这里可留空 */});
    R.on(RoomEvent.DataReceived, (payload, p) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        // livekit-client 某些版本 DataReceived 不传 participant，故发送者 identity 以载荷内 msg.id 为准
        const from = msg.id || (p && p.identity);
        if (msg.t === 'chat') this.emit('chat', { name: msg.name || (p && p.name) || '', text: msg.text, from });
        else if (msg.t === 'rename') { if (from) this._names.set(from, msg.name); this.emit('peer-renamed', { peerId: from, name: msg.name }); }
      } catch {}
    });
    R.on(RoomEvent.Disconnected, (reason) => {
      // 被主持人移出 -> 'kicked'（meeting.js 会提示并返回首页）；其他原因 -> 'close'
      const removed = reason === (DisconnectReason && DisconnectReason.PARTICIPANT_REMOVED) || reason === 4;
      if (removed) this.emit('kicked', {}); else this.emit('close', {});
    });
    R.on(RoomEvent.Reconnecting, () => this.emit('reconnecting', { attempt: 1 }));
    R.on(RoomEvent.Reconnected, () => this.emit('reconnected', {}));
    R.on(RoomEvent.ConnectionStateChanged, (st) => {
      this.emit('conn-state', { peerId: 'self', state: st === ConnectionState.Connected ? 'connected' : String(st) });
    });
  }

  // 根据某远端参会者当前订阅到的轨，重建/复用其 camStream / screenStream，并发 peer-media
  _reconcile(p) {
    let slot = this._remote.get(p.identity);
    if (!slot) { slot = { camStream: new MediaStream(), screenStream: new MediaStream() }; this._remote.set(p.identity, slot); }
    const want = { cam: new Set(), screen: new Set() };
    for (const pub of p.trackPublications.values()) {
      const t = pub.track; if (!pub.isSubscribed || !t || !t.mediaStreamTrack) continue;
      const isScreen = t.source === Track.Source.ScreenShare || t.source === Track.Source.ScreenShareAudio;
      const target = isScreen ? slot.screenStream : slot.camStream;
      const set = isScreen ? want.screen : want.cam;
      set.add(t.mediaStreamTrack.id);
      if (!target.getTracks().some(x => x.id === t.mediaStreamTrack.id)) target.addTrack(t.mediaStreamTrack);
    }
    // 移除已不在订阅里的轨（复用同一个 MediaStream 对象，避免 srcObject 反复重设导致闪断）
    for (const x of slot.camStream.getTracks()) if (!want.cam.has(x.id)) slot.camStream.removeTrack(x);
    for (const x of slot.screenStream.getTracks()) if (!want.screen.has(x.id)) slot.screenStream.removeTrack(x);
    this.emit('peer-media', {
      peerId: p.identity,
      camStream: slot.camStream.getTracks().length ? slot.camStream : null,
      screenStream: slot.screenStream.getTracks().length ? slot.screenStream : null,
    });
    this._emitState(p);
  }

  _emitState(p) {
    this.emit('peer-state', {
      peerId: p.identity,
      micOn: p.isMicrophoneEnabled, camOn: p.isCameraEnabled, sharing: p.isScreenShareEnabled,
    });
  }

  // room metadata 变化 -> 下发主持人策略 + 入会选项
  _applyMeta(metadata) {
    if (!metadata) return;
    let meta; try { meta = JSON.parse(metadata); } catch { return; }
    if (meta.policy) { this.policy = meta.policy; this.emit('policy', { policy: meta.policy }); }
    this.emit('meeting-options', { startAt: meta.startAt || null, maxParticipants: meta.maxParticipants || null });
  }

  _reportState() {
    this.micOn = !!this.room?.localParticipant?.isMicrophoneEnabled;
    this.camOn = !!this.room?.localParticipant?.isCameraEnabled;
    this.sharing = !!this.room?.localParticipant?.isScreenShareEnabled;
    this.emit('self-state', { micOn: this.micOn, camOn: this.camOn, sharing: this.sharing });
    this._pushLocalMedia();
  }

  // 把本端摄像头/麦克风轨组织成 localStream，供自己那格预览（沿用 meeting.js 的 me.camStream 渲染）
  _pushLocalMedia() {
    const lp = this.room?.localParticipant; if (!lp) return;
    const cam = lp.getTrackPublication(Track.Source.Camera)?.track?.mediaStreamTrack;
    const mic = lp.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
    const want = new Set([cam?.id, mic?.id].filter(Boolean));
    for (const x of this.localStream.getTracks()) if (!want.has(x.id)) this.localStream.removeTrack(x);
    for (const t of [cam, mic]) if (t && !this.localStream.getTracks().some(x => x.id === t.id)) this.localStream.addTrack(t);
    this.emit('local-media', { stream: this.localStream });
  }

  // ---------------- 本端媒体控制 ----------------
  async enableMic() { if (!this.policy.allowMic && !this.isHost) return; try { await this.room.localParticipant.setMicrophoneEnabled(true); this._reportState(); } catch (e) { this.emit('media-error', { message: '开麦失败：' + e.message }); } }
  disableMic() { this.room?.localParticipant?.setMicrophoneEnabled(false).then(() => this._reportState()); }
  async enableCamera() { if (!this.policy.allowCam && !this.isHost) return; try { await this.room.localParticipant.setCameraEnabled(true); this._reportState(); } catch (e) { this.emit('media-error', { message: '开摄像头失败：' + e.message }); } }
  disableCamera() { this.room?.localParticipant?.setCameraEnabled(false).then(() => this._reportState()); }

  async startScreenShare() {
    try {
      await this.room.localParticipant.setScreenShareEnabled(true, { audio: true });
      this.sharing = true; this._reportState();
      const t = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack;
      if (t) { const s = new MediaStream([t]); this.emit('local-screen', { stream: s }); }
    } catch (e) { if (e && e.name !== 'NotAllowedError') this.emit('media-error', { message: '屏幕共享失败：' + e.message }); }
  }
  async stopScreenShare() {
    try { await this.room.localParticipant.setScreenShareEnabled(false); } catch {}
    this.sharing = false; this._reportState(); this.emit('local-screen-stop', {});
  }

  // 演示专用：发布一条【静音】音轨作为麦克风 —— 让麦克风显示「打开」但不采集本机真实声音。
  async publishSilentMic(mediaStreamTrack) {
    try {
      this._silentMicPub = await this.room.localParticipant.publishTrack(mediaStreamTrack, { source: Track.Source.Microphone, name: 'mic' });
      this.micOn = true; this._reportState();
    } catch (e) { this.emit('media-error', { message: '静音麦克风发布失败：' + ((e && e.message) || e) }); }
  }
  async unpublishSilentMic() {
    try { if (this._silentMicPub && this._silentMicPub.track) await this.room.localParticipant.unpublishTrack(this._silentMicPub.track); } catch {}
    this._silentMicPub = null;
    this.micOn = !!this.room?.localParticipant?.isMicrophoneEnabled; this._reportState();
  }

  // ---------------- 聊天（data channel）----------------
  sendChat(text) {
    // 载荷内带上发送者 id/name（DataReceived 的 participant 参数在某些版本为空）
    const payload = new TextEncoder().encode(JSON.stringify({ t: 'chat', text, id: this.selfId, name: this._name }));
    try { this.room?.localParticipant?.publishData(payload, { reliable: true }); } catch {}
  }
  setMeetingName(name) {
    // LiveKit 入会后不便改 name；用 data 广播让他人更新显示，本端自更新
    this._name = name;
    const payload = new TextEncoder().encode(JSON.stringify({ t: 'rename', name, id: this.selfId }));
    try { this.room?.localParticipant?.publishData(payload, { reliable: true }); } catch {}
    this.emit('self-renamed', { name });
  }

  // ---------------- 主持人管控（走后端 RoomServiceClient，权威）----------------
  async _moderate(action, target, extra = {}) {
    try {
      await fetch(API_BASE + '/api/livekit/moderate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this._appToken}` },
        body: JSON.stringify({ meetingId: this.meetingId, action, target, ...extra }),
      });
    } catch (e) { this.emit('server-error', { message: '操作失败：' + e.message }); }
  }
  hostMute(target) { this._moderate('mute', target); }
  hostCamOff(target) { this._moderate('cam-off', target); }
  hostKick(target) { this._moderate('kick', target); }
  hostStopShare(target) { this._moderate('stop-share', target); }
  hostMuteAll() { this._moderate('mute-all'); }
  hostSetPolicy(patch) { this._moderate('set-policy', null, { patch }); }        // TODO：完整策略下发（metadata）
  hostSetMeetingOptions(opts) { this._moderate('set-options', null, { opts }); } // TODO

  leave() {
    try { this.room?.disconnect(); } catch {}
    for (const t of this.localStream.getTracks()) { try { t.stop(); } catch {} }
  }
}
