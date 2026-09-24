// LiveKit 集成：签发加入房间的 JWT。会议号 = LiveKit room 名；我们的用户 = identity。
// 本地默认连 dev 服务器（devkey/secret, ws://127.0.0.1:7880）；线上用环境变量覆盖。
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { store } from './store.js';

// LIVEKIT_URL：客户端连的 ws/wss 地址（生产经 nginx TLS：wss://域名/pmlk）
// LIVEKIT_HTTP：后端 RoomServiceClient 用的内部 http 地址（生产直连本机 http://127.0.0.1:7880，不走 nginx）
export const LIVEKIT_URL = process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880';
const API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';
const HTTP_URL = process.env.LIVEKIT_HTTP || LIVEKIT_URL.replace(/^ws/, 'http');
const svc = new RoomServiceClient(HTTP_URL, API_KEY, API_SECRET);

// 生成加入 token。主持人拿 roomAdmin（可用服务端 API 静音/移出/改元数据）。
export async function createJoinToken({ meetingId, user, isHost }) {
  const at = new AccessToken(API_KEY, API_SECRET, {
    identity: String(user.uid),
    name: user.name || '',
    // participant metadata 会随参会者信息下发给房间内其他人；客户端 _peerInfo() 从这里读 isHost，
    // 用于在成员列表上显示「主持人」标记。不设的话远端看到的 isHost 恒为 false。
    metadata: JSON.stringify({ isHost: !!isHost }),
    ttl: '2h',
  });
  at.addGrant({
    room: String(meetingId),
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    roomAdmin: !!isHost,
  });
  return await at.toJwt();
}

// 会议策略/选项 -> 打包成 room metadata（客户端据此下发策略、入会限制）
function meetingMeta(m) {
  const policy = m.policy || { allowMic: false, allowCam: false, allowDanmu: false, locked: false };
  return { policy, startAt: m.startAt || null, maxParticipants: m.maxParticipants || null };
}
async function pushMeta(room, m) {
  try { await svc.updateRoomMetadata(String(room), JSON.stringify(meetingMeta(m))); }
  catch (e) { /* 房间可能尚未创建；新加入者会在 token 响应/连接后拿到 */ }
}

// 供路由使用：校验会议存在、入会限制（主持人豁免）、返回 { url, token, identity, isHost, policy, startAt, maxParticipants }
export async function issueToken({ meetingId, user }) {
  const room = String(meetingId);
  const m = store.getMeeting(room);
  if (!m) return { error: '会议不存在' };
  const isHost = m.hostUserId === user.uid;
  const meta = meetingMeta(m);
  if (!isHost) {
    if (meta.policy.locked) return { error: '会议已锁定，暂不可加入', code: 'locked' };
    if (meta.startAt && Date.now() < meta.startAt) return { error: '会议尚未开始', code: 'not-started', startAt: meta.startAt };
    if (meta.maxParticipants) {
      let n = 0; try { n = (await svc.listParticipants(room)).length; } catch {}
      if (n >= meta.maxParticipants) return { error: '会议人数已满', code: 'full' };
    }
  }
  const token = await createJoinToken({ meetingId, user, isHost });
  return { url: LIVEKIT_URL, token, identity: String(user.uid), isHost, ...meta };
}

// 主持人管控：仅主持人可操作。用 LiveKit RoomServiceClient 权威执行（静音/关摄像头/停共享/移出/全体静音）。
export async function moderate({ meetingId, user, action, target, patch, opts }) {
  const room = String(meetingId);
  const m = store.getMeeting(room);
  if (!m) return { error: '会议不存在' };
  if (m.hostUserId !== user.uid) return { error: '仅主持人可操作' };
  // LiveKit TrackSource 枚举：CAMERA=1, MICROPHONE=2, SCREEN_SHARE=3, SCREEN_SHARE_AUDIO=4（也可能是字符串名）。
  const WANT = { mic: [2, 'MICROPHONE', 'SOURCE_MICROPHONE'], cam: [1, 'CAMERA', 'SOURCE_CAMERA'], screen: [3, 4, 'SCREEN_SHARE', 'SCREEN_SHARE_AUDIO'] };
  const muteBySource = async (identity, src) => {
    const p = await svc.getParticipant(room, identity).catch(() => null);
    if (!p) return;
    const want = WANT[src];
    for (const t of (p.tracks || [])) {
      if (want.includes(t.source) || want.includes(String(t.source).toUpperCase())) {
        await svc.mutePublishedTrack(room, identity, t.sid, true).catch(() => {});
      }
    }
  };
  try {
    switch (action) {
      case 'kick': await svc.removeParticipant(room, target); break;
      case 'mute': await muteBySource(target, 'mic'); break;
      case 'cam-off': await muteBySource(target, 'cam'); break;
      case 'stop-share': await muteBySource(target, 'screen'); break;
      case 'mute-all': {
        const ps = await svc.listParticipants(room);
        for (const p of ps) { if (p.identity !== String(user.uid)) await muteBySource(p.identity, 'mic'); }
        break;
      }
      case 'set-policy': { const nm = store.setMeetingPolicy(room, patch || {}); await pushMeta(room, nm || m); break; }
      case 'set-options': { const nm = store.setMeetingOptions(room, opts || {}); await pushMeta(room, nm || m); break; }
      default: break;
    }
    return { ok: true };
  } catch (e) { return { error: e?.message || String(e) }; }
}
