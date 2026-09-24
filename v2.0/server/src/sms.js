// SMS verification-code sender — Aliyun Dypnsapi SendSmsVerifyCode.
// 本服务器是 ESM，阿里云 SDK 是 CommonJS，用 createRequire 引入。
// 设计：验证码由 auth.js 本地生成(issueCode)，本模块仅负责"投递"，本地校验(checkCode) 不变，
//      完整复用现有限频/重试/PM_EXPOSE_CODE 测试 hook。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// 凭据：阿里云无 AK 模式优先，回退到环境变量 ALIBABA_CLOUD_ACCESS_KEY_ID / _SECRET。
// 这些放服务器 .env.secrets，勿入库/客户端/ git。
// 短信签名与模板号必须由部署方通过环境变量提供（签名需在阿里云控制台申请）。
const SIGN_NAME = process.env.SMS_SIGN_NAME || '';
const TEMPLATE_CODE = process.env.SMS_TEMPLATE_CODE || '';
const CODE_TTL_MIN = String(Math.round((Number(process.env.SMS_CODE_TTL_MS) || 600000) / 60000)); // 模板里 ${min}

let _client = null, _initErr = null;
function getClient() {
  if (_client || _initErr) return _client;
  try {
    const Dypnsapi = require('@alicloud/dypnsapi20170525').default;
    const OpenApi = require('@alicloud/openapi-client');
    const Credential = require('@alicloud/credentials').default;
    const credential = new Credential(); // 读取环境变量/凭据文件
    const config = new OpenApi.Config({ credential });
    config.endpoint = 'dypnsapi.aliyuncs.com';
    _client = new Dypnsapi(config);
  } catch (e) {
    _initErr = e;
    console.warn('[sms] Aliyun SDK 初始化失败（短信不可用）:', e.message);
  }
  return _client;
}

// 是否已具备真实发送能力（有 AK 凭据 + SDK 可加载）
export function smsEnabled() {
  if (!(process.env.ALIBABA_CLOUD_ACCESS_KEY_ID && process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET)) return false;
  if (!SIGN_NAME || !TEMPLATE_CODE) return false;   // 缺签名/模板等于没配置
  return !!getClient();
}

// 发送验证码短信。code 由 auth 本地生成并透传到模板变量 ${code}。
// 注：模板若被配置为阿里云自动生成验证码(##code##)，实际下发的码由响应的 Model.VerifyCode 回传。
export async function sendSmsCode(phone, code) {
  const client = getClient();
  if (!client) throw new Error('短信服务未配置');
  if (!SIGN_NAME || !TEMPLATE_CODE) throw new Error('未配置 SMS_SIGN_NAME / SMS_TEMPLATE_CODE');
  const Dypnsapi = require('@alicloud/dypnsapi20170525');
  const Util = require('@alicloud/tea-util');
  const req = new Dypnsapi.SendSmsVerifyCodeRequest({
    signName: SIGN_NAME,
    templateCode: TEMPLATE_CODE,
    phoneNumber: phone,
    templateParam: JSON.stringify({ code: String(code), min: CODE_TTL_MIN }),
  });
  const resp = await client.sendSmsVerifyCodeWithOptions(req, new Util.RuntimeOptions({}));
  const body = (resp && resp.body) || resp || {};
  // 阿里云成功: Code === 'OK' / success === true
  const ok = body.code === 'OK' || body.Code === 'OK' || body.success === true || body.Success === true;
  if (!ok) throw new Error(body.message || body.Message || '短信发送失败');
  // 若模板是阿里云"自动生成验证码"(##code##)模式，响应回传 Model.VerifyCode = 实际下发的码；
  // 用它作为权威校验码，兼容 ${code}(用我们的码) 与 ##code##(用阿里云的码) 两种模板配置。
  const model = body.Model || body.model || {};
  const sentCode = model.VerifyCode || model.verifyCode || String(code);
  return { body, sentCode: String(sentCode) };
}
