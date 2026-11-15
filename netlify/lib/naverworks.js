// 네이버웍스 API (서비스 계정 JWT 인증, 게시판 읽기 전용)
const crypto = require('crypto');

// 공개돼도 되는 식별값 (비밀 아님)
const CLIENT_ID = process.env.NW_CLIENT_ID || '5nwQaAE6kJlBqh5mSaYh';
const SERVICE_ACCOUNT = process.env.NW_SERVICE_ACCOUNT || 'icfhf.serviceaccount@insidergram.company';
const API = 'https://www.worksapis.com/v1.0';

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function privateKey() {
  let k = process.env.NW_PRIVATE_KEY || '';
  if (k.includes('\\n')) k = k.replace(/\\n/g, '\n');
  if (!k.includes('BEGIN')) {
    // 줄바꿈 없이 붙여넣은 경우 복원
    const body = k.replace(/\s+/g, '');
    k = '-----BEGIN PRIVATE KEY-----\n' + body.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
  }
  return k;
}

let cached = null;
async function accessToken() {
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  if (!process.env.NW_CLIENT_SECRET || !process.env.NW_PRIVATE_KEY) {
    throw new Error('네이버웍스 인증키(NW_CLIENT_SECRET, NW_PRIVATE_KEY)가 Netlify에 설정되지 않았습니다.');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: CLIENT_ID, sub: SERVICE_ACCOUNT, iat: now, exp: now + 3600 }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(header + '.' + claims);
  const sig = signer.sign(privateKey()).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const assertion = header + '.' + claims + '.' + sig;

  const form = new URLSearchParams({
    assertion,
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: CLIENT_ID,
    client_secret: process.env.NW_CLIENT_SECRET,
    scope: 'board.read'
  });
  const res = await fetch('https://auth.worksmobile.com/oauth2/v2.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error('네이버웍스 토큰 발급 실패: ' + (data.error_description || data.error || res.status));
  }
  cached = { token: data.access_token, exp: Date.now() + (Number(data.expires_in || 3600) * 1000) };
  return cached.token;
}

async function get(path) {
  const token = await accessToken();
  const res = await fetch(API + path, { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`네이버웍스 API 오류 ${res.status} ${path}: ${data.description || data.code || ''}`);
  return data;
}

async function listBoards() {
  const out = [];
  let cursor = '';
  for (let i = 0; i < 10; i++) {
    const d = await get('/boards?count=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    out.push(...(d.boards || []));
    cursor = d.responseMetaData && d.responseMetaData.nextCursor;
    if (!cursor) break;
  }
  return out;
}

async function listPosts(boardId, cursor) {
  return get(`/boards/${encodeURIComponent(boardId)}/posts?count=40` + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
}

async function getPost(boardId, postId) {
  return get(`/boards/${encodeURIComponent(boardId)}/posts/${encodeURIComponent(postId)}`);
}

module.exports = { listBoards, listPosts, getPost, accessToken };
