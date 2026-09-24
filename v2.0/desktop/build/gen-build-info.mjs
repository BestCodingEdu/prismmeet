// 打包前生成 build-info.json —— 给每个构建一个唯一 ID。
// main.js 用它决定 userData 目录（见 setupUserData）：构建 ID 变了就换新目录，
// 于是「重新下载/升级后不复用旧用户数据、必须重新登录」这个需求由目录本身保证，
// 不依赖任何客户端逻辑去"猜"是否升级过。
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// 形如 2.0.1-20260923T031500Z：可读、可排序，且是合法的目录名
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const buildId = `${version}-${stamp}`;

const info = { buildId, version, builtAt: new Date().toISOString() };
writeFileSync(join(root, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log('[build-info]', buildId);
