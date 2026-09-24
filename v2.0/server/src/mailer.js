import nodemailer from 'nodemailer';

// 发件人地址由部署方通过 SMTP_FROM 提供；未提供时退回 SMTP_USER。
const FROM = process.env.SMTP_FROM || process.env.SMTP_USER || '';
let transport = null;

function getTransport() {
  if (transport) return transport;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.qq.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transport;
}

export const mailEnabled = () => !!getTransport();

export async function sendCodeMail(to, code, purpose) {
  const t = getTransport();
  if (!t) throw new Error('邮件服务未配置');
  const title = purpose === 'reset' ? '重置密码' : '注册验证';
  const html = `
  <div style="max-width:480px;margin:0 auto;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;border:1px solid #eef0f3;border-radius:14px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#2b6fff,#2bb7ff);padding:22px 26px;color:#fff">
      <div style="font-size:20px;font-weight:700">PrismMeet 棱镜会议</div>
    </div>
    <div style="padding:26px">
      <p style="font-size:15px;color:#1c2026;margin:0 0 14px">你好，你正在进行 <b>${title}</b>。验证码：</p>
      <div style="font-size:34px;font-weight:700;letter-spacing:8px;color:#2b6fff;background:#f4f8ff;border-radius:10px;text-align:center;padding:16px 0;margin:8px 0 18px">${code}</div>
      <p style="font-size:13px;color:#8a9099;margin:0">验证码 <b>10 分钟</b>内有效，请勿向他人泄露。若非你本人操作，请忽略此邮件。</p>
    </div>
    <div style="padding:14px 26px;background:#fafbfc;color:#9aa0a6;font-size:12px;border-top:1px solid #eef0f3">© PrismMeet · 免费开源远程会议</div>
  </div>`;
  await t.sendMail({
    from: FROM, to,
    subject: `【PrismMeet】${title}验证码：${code}`,
    text: `你的 PrismMeet ${title}验证码是 ${code}，10 分钟内有效，请勿泄露。`,
    html,
  });
}
