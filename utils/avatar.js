import fs from 'fs';
import path from 'path';
import axios from 'axios';
import ColorThief from 'colorthief';

/**
 * 通用获取用户头像 Base64 + 主色
 * @param {Object} e - 消息事件对象
 * @param {String} [defaultColor='#ffdd57'] - 默认主色
 * @returns {Promise<{avatarBase64: string, mainColor: string}>}
 */
export async function getAvatarInfo(e, defaultColor = '#ffdd57') {
  // 1. 获取用户标识（兼容 QQBot / oicq / 其他）
  const isQQbot = e.bot?.version?.name === 'QQBot';
  const openid = e.raw?.author?.user_openid || e.raw?.sender?.user_openid || e.user_id;

  // 2. 获取头像 URL
  const avatarUrl = isQQbot
    ? `https://thirdqq.qlogo.cn/qqapp/102080069/${openid}/640`
    : `http://q1.qlogo.cn/g?b=qq&nk=${e.user_id}&s=640`;

  // 3. 下载头像到临时文件
  const avatarPath = await downloadAvatar(avatarUrl, e.user_id);

  let mainColor = defaultColor;
  let avatarBase64 = '';

  if (avatarPath) {
    avatarBase64 = `data:image/png;base64,${fs.readFileSync(avatarPath).toString('base64')}`;

    // 尝试提取主色
    try {
      const rgb = await ColorThief.getColor(avatarPath);
      mainColor = rgbToHex(rgb);
    } catch (err) {
      console.warn('[AvatarInfo] 提取头像主色失败，使用默认颜色', err);
    }
  }

  return { avatarBase64, mainColor };
}

/**
 * 下载头像到临时路径
 * @param {string} url
 * @param {string|number} userId
 * @returns {Promise<string>} 本地文件路径
 */
async function downloadAvatar(url, userId) {
  try {
    const tmpDir = path.resolve(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const avatarPath = path.resolve(tmpDir, `avatar_${userId}.png`);
    const res = await axios.get(url, { responseType: 'arraybuffer' });
    fs.writeFileSync(avatarPath, Buffer.from(res.data, 'binary'));
    return avatarPath;
  } catch (err) {
    console.warn('[AvatarInfo] 下载头像失败', err);
    return '';
  }
}

/**
 * RGB 转 Hex
 * @param {number[]} rgb - [r,g,b]
 */
function rgbToHex(rgb) {
  return '#' + rgb.map(x => x.toString(16).padStart(2, '0')).join('');
}
