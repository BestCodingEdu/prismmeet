import { nanoid } from 'nanoid';
import { store } from './store.js';

/**
 * In-memory room/signaling state for mesh WebRTC.
 * A "room" mirrors a persisted meeting (meetings table) but holds live peers.
 */
const rooms = new Map(); // meetingId -> Room

function getRoom(meetingId) {
  let room = rooms.get(meetingId);
  if (!room) {
    const meeting = store.getMeeting(meetingId);
    room = {
      id: meetingId,
      title: meeting?.title || '快速会议',
      hostUserId: meeting?.hostUserId ?? null,
      startAt: meeting?.startAt || null,                 // 计划开始时间(epoch ms)，未到则不允许入会
      maxParticipants: meeting?.maxParticipants || null, // 人数上限，满员则拒绝非主持人入会
      // 默认：参会者不允许开麦克风/摄像头/聊天弹幕（主持人豁免，可在会中手动放开）
      policy: { allowMic: false, allowCam: false, allowDanmu: false, locked: false },
      sharerId: null, // 单人共享：当前正在共享(屏幕/应用/视频)的 peerId；null=无人共享
      peers: new Map(), // peerId -> peer
    };
    rooms.set(meetingId, room);
  }
  return room;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, exceptPeerId = null) {
  for (const p of room.peers.values()) {
    if (p.peerId !== exceptPeerId) send(p.ws, obj);
  }
}

function publicPeer(p) {
  return { peerId: p.peerId, userId: p.userId, name: p.name, avatar: p.avatar || null, micOn: p.micOn, camOn: p.camOn, sharing: p.sharing, isHost: p.isHost };
}

export function handleConnection(ws, user, meetingId) {
  const room = getRoom(meetingId);
  const peerId = nanoid(10);
  const isHost = room.hostUserId != null && user.uid === room.hostUserId;

  const peer = {
    peerId, ws, userId: user.uid, name: user.name,
    avatar: store.getUserById(user.uid)?.avatar || null,
    micOn: false, camOn: false, sharing: false, isHost,
  };

  // Reject if locked (and not host)
  if (room.policy.locked && !isHost) {
    send(ws, { type: 'error', code: 'locked', message: '会议已被主持人锁定，无法加入' });
    ws.close();
    return;
  }

  // 计划开始时间未到 —— 仅【参会者】不能入会；主持人不受限（开始时间由主持人在会中设置，自己先进去准备）
  if (room.startAt && Date.now() < room.startAt && !isHost) {
    send(ws, { type: 'error', code: 'not-started', message: '会议尚未开始', startAt: room.startAt });
    ws.close();
    return;
  }

  // 人数已达上限 —— 拒绝新的参会者（主持人豁免，保证不会被挡在自己会议门外）
  if (room.maxParticipants && room.peers.size >= room.maxParticipants && !isHost) {
    send(ws, { type: 'error', code: 'full', message: '会议已达人数上限', max: room.maxParticipants });
    ws.close();
    return;
  }

  room.peers.set(peerId, peer);

  // Tell the newcomer about current state + existing peers
  send(ws, {
    type: 'joined',
    self: peerId,
    isHost,
    title: room.title,
    policy: room.policy,
    startAt: room.startAt || null,             // 当前会议设置（主持人用于回显设置面板）
    maxParticipants: room.maxParticipants || null,
    peers: [...room.peers.values()].filter(p => p.peerId !== peerId).map(publicPeer),
  });

  // Notify existing peers — they will initiate the WebRTC offer toward the newcomer
  broadcast(room, { type: 'peer-joined', peer: publicPeer(peer) }, peerId);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handleMessage(room, peer, msg);
  });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;       // close/error 可能都触发，确保只清理一次
    cleanedUp = true;
    room.peers.delete(peerId);
    if (room.sharerId === peerId) room.sharerId = null; // 共享者离开 -> 释放共享锁
    broadcast(room, { type: 'peer-left', peerId });
    if (room.peers.size === 0) rooms.delete(meetingId);
  };
  ws.on('close', cleanup);
  // error 时强制 terminate：既触发 close→cleanup，又确保 socket 真正关闭，
  // 让客户端 onclose 能感知并重连（避免"服务端已移除、客户端却以为还在"的单边僵尸）
  ws.on('error', () => { try { ws.terminate(); } catch {} cleanup(); });
}

function handleMessage(room, peer, msg) {
  switch (msg.type) {
    case 'signal': {
      // Relay WebRTC offer/answer/ICE to a specific peer
      const target = room.peers.get(msg.to);
      if (target) send(target.ws, { type: 'signal', from: peer.peerId, data: msg.data });
      break;
    }
    case 'state': {
      // Enforce policy server-side for non-host
      if (!peer.isHost) {
        if (msg.micOn && !room.policy.allowMic) msg.micOn = false;
        if (msg.camOn && !room.policy.allowCam) msg.camOn = false;
      }
      if (typeof msg.micOn === 'boolean') peer.micOn = msg.micOn;
      if (typeof msg.camOn === 'boolean') peer.camOn = msg.camOn;
      // 单人共享：服务端权威判定。开始共享时若已有他人在共享则拒绝；停止时释放锁。
      if (typeof msg.sharing === 'boolean') {
        if (msg.sharing) {
          if (room.sharerId && room.sharerId !== peer.peerId && room.peers.has(room.sharerId)) {
            peer.sharing = false;
            const cur = room.peers.get(room.sharerId);
            send(peer.ws, { type: 'share-denied', sharerId: room.sharerId, sharerName: cur ? cur.name : '' });
          } else {
            room.sharerId = peer.peerId;
            peer.sharing = true;
          }
        } else {
          peer.sharing = false;
          if (room.sharerId === peer.peerId) room.sharerId = null;
        }
      }
      broadcast(room, { type: 'peer-state', peerId: peer.peerId, micOn: peer.micOn, camOn: peer.camOn, sharing: peer.sharing }, peer.peerId);
      // echo back the (possibly corrected) state so client UI stays in sync
      send(peer.ws, { type: 'self-state', micOn: peer.micOn, camOn: peer.camOn, sharing: peer.sharing });
      break;
    }
    case 'meta': {
      // Relay track metadata (trackId -> 'camera'|'mic'|'screen') so peers can place tracks
      broadcast(room, { type: 'meta', from: peer.peerId, tracks: msg.tracks || {} }, peer.peerId);
      break;
    }
    case 'rename': {
      // meeting-scoped temporary nickname (does NOT change the account)
      const name = String(msg.name || '').trim().slice(0, 24);
      if (!name) return;
      peer.name = name;
      broadcast(room, { type: 'peer-renamed', peerId: peer.peerId, name }, peer.peerId);
      send(peer.ws, { type: 'self-renamed', name });
      break;
    }
    case 'chat': {
      if (!peer.isHost && !room.policy.allowDanmu) {
        send(peer.ws, { type: 'error', code: 'danmu-off', message: '主持人已关闭聊天/弹幕' });
        return;
      }
      const text = String(msg.text || '').slice(0, 500);
      if (!text.trim()) return;
      broadcast(room, { type: 'chat', from: peer.peerId, name: peer.name, text, ts: Date.now() });
      break;
    }
    case 'host': {
      if (!peer.isHost) return; // only host
      handleHostAction(room, peer, msg);
      break;
    }
  }
}

function handleHostAction(room, host, msg) {
  switch (msg.action) {
    case 'set-policy': {
      const p = room.policy;
      if (typeof msg.allowMic === 'boolean') p.allowMic = msg.allowMic;
      if (typeof msg.allowCam === 'boolean') p.allowCam = msg.allowCam;
      if (typeof msg.allowDanmu === 'boolean') p.allowDanmu = msg.allowDanmu;
      if (typeof msg.locked === 'boolean') p.locked = msg.locked;
      broadcast(room, { type: 'policy', policy: p });
      // Enforce immediately on non-host peers
      for (const peer of room.peers.values()) {
        if (peer.isHost) continue;
        if (!p.allowMic && peer.micOn) forceMedia(room, peer, 'mute');
        if (!p.allowCam && peer.camOn) forceMedia(room, peer, 'cam-off');
      }
      break;
    }
    case 'mute': {
      const t = room.peers.get(msg.target);
      if (t && !t.isHost) forceMedia(room, t, 'mute');
      break;
    }
    case 'cam-off': {
      const t = room.peers.get(msg.target);
      if (t && !t.isHost) forceMedia(room, t, 'cam-off');
      break;
    }
    case 'mute-all': {
      for (const peer of room.peers.values()) {
        if (!peer.isHost && peer.micOn) forceMedia(room, peer, 'mute');
      }
      break;
    }
    case 'stop-share': {
      // 主持人停止某人的共享（可停任何人，含联席主持人）
      const t = room.peers.get(msg.target);
      if (t) {
        t.sharing = false;
        if (room.sharerId === t.peerId) room.sharerId = null;
        send(t.ws, { type: 'forced', action: 'stopShare' });
        broadcast(room, { type: 'peer-state', peerId: t.peerId, micOn: t.micOn, camOn: t.camOn, sharing: false }, t.peerId);
      }
      break;
    }
    case 'kick': {
      const t = room.peers.get(msg.target);
      if (t && !t.isHost) {
        send(t.ws, { type: 'kicked', message: '你已被主持人移出会议' });
        t.ws.close();
      }
      break;
    }
    case 'set-options': {
      // 主持人在会中设置「参会开始时间」「人数上限」。仅影响【之后参会者】的入会判定，不踢已在会中的人。
      const t = Number(msg.startAt);
      room.startAt = (Number.isFinite(t) && t > Date.now()) ? t : null;
      const c = Number(msg.maxParticipants);
      room.maxParticipants = (Number.isFinite(c) && c >= 1) ? Math.floor(c) : null;
      store.setMeetingOptions(room.id, { startAt: room.startAt, maxParticipants: room.maxParticipants });
      broadcast(room, { type: 'meeting-options', startAt: room.startAt, maxParticipants: room.maxParticipants });
      break;
    }
  }
}

function forceMedia(room, peer, action) {
  if (action === 'mute') peer.micOn = false;
  if (action === 'cam-off') peer.camOn = false;
  send(peer.ws, { type: 'forced', action });
  broadcast(room, { type: 'peer-state', peerId: peer.peerId, micOn: peer.micOn, camOn: peer.camOn, sharing: peer.sharing }, peer.peerId);
}
