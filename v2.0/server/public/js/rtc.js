// Mesh WebRTC client with "perfect negotiation". Emits DOM events on itself.
import { API_BASE, wsBase } from './api.js';

export class MeshClient extends EventTarget {
  constructor({ meetingId, token }) {
    super();
    this.meetingId = meetingId;
    this.token = token;
    this.ws = null;
    this.selfId = null;
    this.isHost = false;
    this.policy = { allowMic: false, allowCam: false, allowDanmu: false, locked: false }; // 默认禁参会者开麦/摄像头/弹幕(主持人豁免)；入会后以服务器下发为准
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

    this.localStream = new MediaStream(); // holds camera + mic tracks
    this.screenStream = null;
    this.micOn = false;
    this.camOn = false;
    this.sharing = false;

    this.peers = new Map(); // peerId -> { pc, polite, makingOffer, ignoreOffer, info, remoteTracks, meta }
    this.pendingMeta = {};  // peerId -> tracks, buffers meta that arrives before the peer is created
    this.trackKinds = new Map(); // local trackId -> 'camera'|'mic'|'screen'
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async connect() { await this._openWs(); }

  // 打开信令 ws；断开后(非主动离开)自动重连
  async _openWs() {
    try {
      const r = await fetch(API_BASE + '/api/ice').then(r => r.json());
      if (r.iceServers?.length) this.iceServers = r.iceServers;
    } catch {}
    const url = `${wsBase()}/ws?token=${encodeURIComponent(this.token)}&meetingId=${this.meetingId}`;
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => this._onMessage(JSON.parse(e.data));
    this.ws.onclose = () => {
      this.emit('close', {});
      if (!this._leaving) this._scheduleReconnect();
    };
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error('信令连接失败'));
    });
  }

  // 退避重连：断开后 1s,2s,4s…(上限10s)重试；重连=重新入会(新 peerId)+重建所有 PC，复用本地媒体
  _scheduleReconnect() {
    if (this._leaving || this._reconnectTimer) return;
    const attempt = (this._reconnectAttempts = (this._reconnectAttempts || 0) + 1);
    const delay = Math.min(1000 * 2 ** (attempt - 1), 10000);
    this.emit('reconnecting', { attempt, delay });
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._leaving) return;
      // 拆掉旧 PC（重连后服务器以新 peerId 重新下发 peers 并重建）
      for (const p of this.peers.values()) { try { clearTimeout(p._iceTimer); p.pc.close(); } catch {} }
      this.peers.clear();
      this.pendingMeta = {};
      try {
        await this._openWs();                       // 新 ws；'joined' 事件会重建 peers + 由 _createPeer 把本地轨加给新连接
        this._reconnectAttempts = 0;
        this.emit('reconnected', {});
        setTimeout(() => this._reapplyState(), 1000); // 恢复本端麦/摄像头状态
      } catch (e) {
        this._scheduleReconnect();                  // 失败继续退避
      }
    }, delay);
  }

  // 重连后恢复本端的麦克风/摄像头开关状态并上报
  _reapplyState() {
    try {
      const at = this.localStream.getAudioTracks()[0]; if (at) at.enabled = !!this.micOn;
      const vt = this.localStream.getVideoTracks()[0]; if (vt) vt.enabled = !!this.camOn;
      this._broadcastMeta();
      this._reportState();
    } catch {}
  }

  _send(obj) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }

  // ---------------- local media ----------------
  async _ensureMedia() {
    // Acquire camera + mic once (tracks start disabled). Safe to call repeatedly.
    if (this._mediaTried) return;
    this._mediaTried = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      for (const t of stream.getTracks()) {
        t.enabled = false;
        this.localStream.addTrack(t);
        this.trackKinds.set(t.id, t.kind === 'audio' ? 'mic' : 'camera');
      }
    } catch (e) {
      this.emit('media-error', { message: '无法访问摄像头/麦克风：' + e.message });
    }
    // add to existing peer connections
    for (const t of this.localStream.getTracks()) this._addTrackToAll(t, this.localStream);
    this._broadcastMetaSoon();
    this.emit('local-media', { stream: this.localStream });
  }

  _addTrackToAll(track, stream) {
    for (const p of this.peers.values()) {
      const already = p.pc.getSenders().some(s => s.track === track);
      if (!already) p.pc.addTrack(track, stream);
      this._tuneSender(p.pc, track);
    }
  }

  // 画质优化：给视频发送端设「清晰度优先级 + 码率上限」，避免编码器默认值把屏幕/演示视频压糊。
  // 屏幕/演示视频重细节(保分辨率)，摄像头重流畅。maxBitrate 是上限不是下限，拥塞控制仍按真实带宽自适应，不会压垮网络。
  _tuneSender(pc, track) {
    try {
      if (!track || track.kind !== 'video') return;
      const isScreen = this.trackKinds.get(track.id) === 'screen';
      try { track.contentHint = isScreen ? 'detail' : 'motion'; } catch {}
      const sender = pc.getSenders().find(s => s.track === track);
      if (!sender || !sender.getParameters) return;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = isScreen ? 3000000 : 1200000;
      params.degradationPreference = isScreen ? 'maintain-resolution' : 'balanced';
      Promise.resolve(sender.setParameters(params)).catch(() => {});
    } catch {}
  }

  async enableMic() {
    if (!this.policy.allowMic && !this.isHost) return;
    await this._ensureMedia();
    let t = this.localStream.getAudioTracks()[0];
    if (t) { t.enabled = true; this.micOn = true; this._reportState(); }
  }
  disableMic() {
    const t = this.localStream.getAudioTracks()[0];
    if (t) t.enabled = false;
    this.micOn = false; this._reportState();
  }
  async enableCamera() {
    if (!this.policy.allowCam && !this.isHost) return;
    await this._ensureMedia();
    let t = this.localStream.getVideoTracks()[0];
    if (t) { t.enabled = true; this.camOn = true; this._reportState(); }
  }
  disableCamera() {
    const t = this.localStream.getVideoTracks()[0];
    if (t) t.enabled = false;
    this.camOn = false; this._reportState();
  }

  async startScreenShare() {
    try {
      let s;
      const desk = (typeof window !== 'undefined') && window.PM_DESKTOP && window.PM_DESKTOP.pickSource;
      if (desk) {
        // Desktop app: pick source via IPC, then capture it directly (reliable in Electron)
        const choice = await window.PM_DESKTOP.pickSource();
        if (!choice || !choice.id) return; // user canceled
        s = await navigator.mediaDevices.getUserMedia({
          audio: choice.audio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
          video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: choice.id, maxFrameRate: 15 } },
        });
      } else {
        // Browser: native picker
        s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      }
      this.screenStream = s;
      const vt = s.getVideoTracks()[0];
      this.trackKinds.set(vt.id, 'screen');
      this._addTrackToAll(vt, s);
      const at = s.getAudioTracks()[0];
      if (at) { this.trackKinds.set(at.id, 'mic'); this._addTrackToAll(at, s); }
      vt.onended = () => this.stopScreenShare();
      this.sharing = true;
      this._broadcastMetaSoon();
      this._reportState();
      this.emit('local-screen', { stream: s });
    } catch (e) {
      console.warn('[screenshare] getDisplayMedia failed:', e.name, e.message);
      if (e && e.name !== 'NotAllowedError') this.emit('media-error', { message: '屏幕共享失败：' + e.message });
    }
  }
  stopScreenShare() {
    if (!this.screenStream) return;
    for (const t of this.screenStream.getTracks()) {
      for (const p of this.peers.values()) {
        const sender = p.pc.getSenders().find(s => s.track === t);
        if (sender) p.pc.removeTrack(sender);
      }
      t.stop();
      this.trackKinds.delete(t.id);
    }
    this.screenStream = null;
    this.sharing = false;
    this._reportState();
    this.emit('local-screen-stop', {});
  }

  _reportState() {
    this._send({ type: 'state', micOn: this.micOn, camOn: this.camOn, sharing: this.sharing });
    this.emit('self-state', { micOn: this.micOn, camOn: this.camOn, sharing: this.sharing });
  }
  _broadcastMeta() {
    const tracks = {};
    for (const [id, kind] of this.trackKinds) tracks[id] = kind;
    this._send({ type: 'meta', tracks });
  }
  // 声画稳定：轨道刚变化时，元数据(轨道类型)常比媒体轨晚到，接收端会先把屏幕轨错分类成摄像头、
  // 或迟迟不显示。这里立即广播一次，并在 400ms / 1500ms 各补一次，收窄「轨道先到、meta 后到」的竞争窗口。
  _broadcastMetaSoon() {
    this._broadcastMeta();
    clearTimeout(this._metaT1); this._metaT1 = setTimeout(() => this._broadcastMeta(), 400);
    clearTimeout(this._metaT2); this._metaT2 = setTimeout(() => this._broadcastMeta(), 1500);
  }

  // ---------------- chat ----------------
  sendChat(text) { this._send({ type: 'chat', text }); }

  // ---------------- meeting-scoped nickname ----------------
  setMeetingName(name) { this._send({ type: 'rename', name }); }

  // ---------------- host controls ----------------
  hostSetPolicy(patch) { if (this.isHost) this._send({ type: 'host', action: 'set-policy', ...patch }); }
  hostMute(target) { this._send({ type: 'host', action: 'mute', target }); }
  hostCamOff(target) { this._send({ type: 'host', action: 'cam-off', target }); }
  hostMuteAll() { this._send({ type: 'host', action: 'mute-all' }); }
  hostKick(target) { this._send({ type: 'host', action: 'kick', target }); }
  hostStopShare(target) { this._send({ type: 'host', action: 'stop-share', target }); }
  hostSetMeetingOptions({ startAt, maxParticipants } = {}) { if (this.isHost) this._send({ type: 'host', action: 'set-options', startAt: startAt ?? null, maxParticipants: maxParticipants ?? null }); }

  // ---------------- signaling handlers ----------------
  async _onMessage(msg) {
    switch (msg.type) {
      case 'joined': {
        this.selfId = msg.self;
        this.isHost = msg.isHost;
        this.policy = msg.policy;
        this.meetingOptions = { startAt: msg.startAt || null, maxParticipants: msg.maxParticipants || null };
        this.emit('joined', { selfId: msg.self, isHost: msg.isHost, title: msg.title, policy: msg.policy, peers: msg.peers, startAt: this.meetingOptions.startAt, maxParticipants: this.meetingOptions.maxParticipants });
        // Create peer connections FIRST so incoming offers/ICE/meta from already-present peers
        // (e.g. someone already sharing their screen) are not dropped. Acquire media in parallel.
        for (const info of msg.peers) this._createPeer(info);
        this._ensureMedia();
        break;
      }
      case 'peer-joined':
        this._createPeer(msg.peer);
        this.emit('peer-joined', { peer: msg.peer });
        this._broadcastMetaSoon(); // let the newcomer learn our track kinds (补发几次，防 meta 早于建连丢失)
        break;
      case 'peer-left':
        this._removePeer(msg.peerId);
        this.emit('peer-left', { peerId: msg.peerId });
        break;
      case 'signal':
        await this._onSignal(msg.from, msg.data);
        break;
      case 'meta': {
        const p = this.peers.get(msg.from);
        if (p) { p.meta = msg.tracks || {}; this._placeTracks(msg.from); }
        else { this.pendingMeta[msg.from] = msg.tracks || {}; } // buffer until peer exists
        break;
      }
      case 'peer-state':
        this.emit('peer-state', msg);
        break;
      case 'peer-renamed':
        this.emit('peer-renamed', { peerId: msg.peerId, name: msg.name });
        break;
      case 'self-renamed':
        this.emit('self-renamed', { name: msg.name });
        break;
      case 'self-state':
        this.micOn = msg.micOn; this.camOn = msg.camOn; this.sharing = msg.sharing;
        this.emit('self-state', msg);
        break;
      case 'policy':
        this.policy = msg.policy;
        this.emit('policy', { policy: msg.policy });
        break;
      case 'meeting-options':
        this.meetingOptions = { startAt: msg.startAt || null, maxParticipants: msg.maxParticipants || null };
        this.emit('meeting-options', this.meetingOptions);
        break;
      case 'forced':
        if (msg.action === 'mute') this.disableMic();
        if (msg.action === 'cam-off') this.disableCamera();
        if (msg.action === 'stopShare') this.stopScreenShare();
        this.emit('forced', { action: msg.action });
        break;
      case 'share-denied':
        // 竞态兜底：服务端拒绝本次共享(已有他人在共享) -> 撤回本地共享并提示
        this.stopScreenShare();
        this.emit('share-denied', { sharerId: msg.sharerId, sharerName: msg.sharerName || '' });
        break;
      case 'chat':
        this.emit('chat', msg);
        break;
      case 'kicked':
        this.emit('kicked', msg);
        this.ws.close();
        break;
      case 'error':
        // 终态拒绝(锁定/未开始/满员)：别再自动重连，交给上层提示并离开
        if (msg.code === 'locked' || msg.code === 'not-started' || msg.code === 'full') {
          this._leaving = true;
          this.emit('rejected', msg);
        } else {
          this.emit('server-error', msg);
        }
        break;
    }
  }

  _createPeer(info) {
    if (this.peers.get(info.peerId)) return;
    const polite = this.selfId > info.peerId; // deterministic & symmetric
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const p = { pc, polite, makingOffer: false, ignoreOffer: false, info, remoteTracks: new Map(), meta: {} };
    if (this.pendingMeta[info.peerId]) { p.meta = this.pendingMeta[info.peerId]; delete this.pendingMeta[info.peerId]; }
    this.peers.set(info.peerId, p);

    // 同一条 track 只 addTrack 一次：若某轨同时存在于 localStream 与 screenStream，
    // 重复 addTrack 会抛 InvalidAccessError 中断建连，导致新入会者收不到任何轨。
    const _added = new Set();
    for (const t of this.localStream.getTracks()) { if (!_added.has(t)) { pc.addTrack(t, this.localStream); _added.add(t); } }
    if (this.screenStream) for (const t of this.screenStream.getTracks()) { if (!_added.has(t)) { pc.addTrack(t, this.screenStream); _added.add(t); } }
    for (const t of _added) this._tuneSender(pc, t); // 画质优化：新建连时给视频轨设码率/清晰度优先级

    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        this._send({ type: 'signal', to: info.peerId, data: { description: pc.localDescription } });
      } catch (e) { console.warn('negotiation error', e); }
      finally { p.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this._send({ type: 'signal', to: info.peerId, data: { candidate } });
    };
    pc.ontrack = ({ track, streams }) => {
      p.remoteTracks.set(track.id, track);
      track.onended = () => { p.remoteTracks.delete(track.id); this._placeTracks(info.peerId); };
      // 弱网时视频轨会短暂 mute（停止收帧）→ 恢复时 unmute。监听它们强制刷新 UI，
      // 让画面在恢复后立刻重新显示，而不是停在头像/黑帧。轨道集合没变，故只刷新不换流（force）。
      track.onmute = () => this._placeTracks(info.peerId, true);
      track.onunmute = () => this._placeTracks(info.peerId, true);
      this._placeTracks(info.peerId);
    };
    pc.onconnectionstatechange = () => {
      this.emit('conn-state', { peerId: info.peerId, state: pc.connectionState });
      if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch {} }
    };
    // ICE 抖动恢复：disconnected 时媒体(音频)会停；给 4s 自愈，仍未恢复就重启 ICE
    // （restartIce 触发重新协商+重新收集候选，会用上 TURN 中继兜底，治"听着听着没声音了"）
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === 'failed') { try { pc.restartIce(); } catch {} }
      else if (st === 'disconnected') {
        clearTimeout(p._iceTimer);
        p._iceTimer = setTimeout(() => {
          if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
            try { pc.restartIce(); } catch {}
          }
        }, 4000);
      } else if (st === 'connected' || st === 'completed') {
        clearTimeout(p._iceTimer);
      }
    };
  }

  _removePeer(peerId) {
    const p = this.peers.get(peerId);
    if (p) { try { p.pc.close(); } catch {} this.peers.delete(peerId); }
  }

  async _onSignal(from, data) {
    const p = this.peers.get(from);
    if (!p) return;
    const pc = p.pc;
    try {
      if (data.description) {
        const offerCollision = data.description.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && offerCollision;
        if (p.ignoreOffer) return;
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          this._send({ type: 'signal', to: from, data: { description: pc.localDescription } });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); }
        catch (e) { if (!p.ignoreOffer) throw e; }
      }
    } catch (e) { console.warn('signal error', e); }
  }

  // Classify a peer's received tracks into camera/mic/screen and emit media event.
  // 声画稳定关键：轨道集合(按 id)没变就【复用上一次的 MediaStream 对象】，不重建、不重新 emit，
  // 避免 meeting.js 反复 `video.srcObject = 新流` 造成画面闪断、音频重新缓冲、声画错位。
  // force=true 时（如 mute/unmute）即使集合没变也 emit，但仍复用同一批流对象（只让 UI 重判可见性，不换流）。
  _placeTracks(peerId, force) {
    const p = this.peers.get(peerId);
    if (!p) return;
    const camStream = new MediaStream();
    const screenStream = new MediaStream();
    const camIds = [], screenIds = [];
    for (const [id, track] of p.remoteTracks) {
      const kind = p.meta[id] || (track.kind === 'audio' ? 'mic' : 'camera');
      if (kind === 'screen') { screenStream.addTrack(track); screenIds.push(track.id); }
      else { camStream.addTrack(track); camIds.push(track.id); }
    }
    const key = (arr) => arr.slice().sort().join(',');
    const camKey = key(camIds), screenKey = key(screenIds);
    const camChanged = camKey !== (p._camKey || '');
    const screenChanged = screenKey !== (p._screenKey || '');
    if (camChanged) { p._camStream = camStream.getTracks().length ? camStream : null; p._camKey = camKey; }
    if (screenChanged) { p._screenStream = screenStream.getTracks().length ? screenStream : null; p._screenKey = screenKey; }
    if (!camChanged && !screenChanged && !force) return; // 集合没变且非强制 -> 不打扰 UI，保持现有 srcObject
    this.emit('peer-media', { peerId, camStream: p._camStream || null, screenStream: p._screenStream || null });
  }

  leave() {
    this._leaving = true;                                  // 主动离开：禁止自动重连
    clearTimeout(this._reconnectTimer); this._reconnectTimer = null;
    try { this._send({ type: 'state', micOn: false, camOn: false, sharing: false }); } catch {}
    for (const p of this.peers.values()) { try { clearTimeout(p._iceTimer); p.pc.close(); } catch {} }
    this.peers.clear();
    for (const t of this.localStream.getTracks()) t.stop();
    if (this.screenStream) for (const t of this.screenStream.getTracks()) t.stop();
    try { this.ws.close(); } catch {}
  }
}
