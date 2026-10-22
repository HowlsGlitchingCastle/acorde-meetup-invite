'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const root = path.join(__dirname, 'public');
const localFile = path.join(__dirname, 'data', 'attendees.json');
const databaseUrl = process.env.DATABASE_URL;
const isHosted = process.env.NODE_ENV === 'production' || process.env.REQUIRE_DATABASE === 'true';
const PORT = Number(process.env.PORT || 3000);
let pool;
let memoryCache = [];
let writeQueue = Promise.resolve();
const ipLimits = new Map();

function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function keyName(name) { return name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ko-KR'); }
function validateName(name) {
  if (typeof name !== 'string') return null;
  const cleaned = name.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 1 || cleaned.length > 20) return null;
  if (!/^[\p{L}\p{M}]+(?:[ ·'’-][\p{L}\p{M}]+)*$/u.test(cleaned)) return null;
  return cleaned;
}
function validateContact(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') return null;
  const contact = value.trim();
  if (contact.length > 80 || /[\x00-\x1f\x7f]/.test(contact)) return null;
  return contact;
}
function adminAuthorized(req) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 16) return false;
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || auth.length > 1024) return false;
  return crypto.timingSafeEqual(Buffer.from(hashToken(password), 'hex'), Buffer.from(hashToken(auth.slice(7)), 'hex'));
}
function validToken(token) { return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token); }
function json(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  let length = 0; let chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 2048) throw Object.assign(new Error('요청 크기 초과'), {status:413});
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch(_) { throw Object.assign(new Error('잘못된 요청입니다.'), {status:400}); }
}
function sameOrigin(req) {
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; }
  catch(_) { return false; }
}
function clientAddress(req) {
  // Reverse proxy 환경에서는 원격 사용자의 전달된 주소로 요청 빈도를 구분합니다.
  // 주소 헤더를 사용할 수 없을 경우에는 연결 주소를 사용합니다.
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length < 512) {
    const first = forwarded.split(',')[0].trim();
    if (/^[a-fA-F0-9:.]{2,45}$/.test(first)) return first;
  }
  return req.socket.remoteAddress || 'unknown';
}
function tooMany(ip) {
  const now = Date.now();
  const state = ipLimits.get(ip) || [];
  const recent = state.filter(t => now - t < 60_000);
  if (recent.length >= 7) return true;
  recent.push(now);
  ipLimits.set(ip, recent);
  if (ipLimits.size > 2000) { for (const [k,v] of ipLimits) if (now - v[v.length - 1] > 60_000) ipLimits.delete(k); }
  return false;
}
async function init() {
  if (isHosted && !databaseUrl) throw new Error('호스팅 시 DATABASE_URL 환경 변수가 필요합니다. Render 환경변수를 확인하세요.');
  if (databaseUrl) {
    const { Pool } = require('pg');
    pool = new Pool({connectionString:databaseUrl, max:5, connectionTimeoutMillis:6000});
    await pool.query(`CREATE TABLE IF NOT EXISTS acorede_attendees (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(20) NOT NULL,
      name_key VARCHAR(100) NOT NULL UNIQUE,
      token_hash CHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query("ALTER TABLE acorede_attendees ADD COLUMN IF NOT EXISTS contact VARCHAR(80) NOT NULL DEFAULT ''");
    console.log('PostgreSQL 준비 완료');
  } else {
    await fs.mkdir(path.dirname(localFile), {recursive:true});
    try { memoryCache = JSON.parse(await fs.readFile(localFile, 'utf8')); }
    catch(error) { if(error.code !== 'ENOENT') throw error; }
    console.warn('개발용 JSON 파일 사용 중. 공개 배포는 PostgreSQL 연결이 필요합니다.');
  }
}
async function persist() {
  writeQueue = writeQueue.then(async () => {
    const tmp = localFile + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(memoryCache), {encoding:'utf8', mode:0o600});
    await fs.rename(tmp, localFile);
  });
  return writeQueue;
}
async function all() {
  if (pool) {
    const {rows} = await pool.query('SELECT id::text AS id, name FROM acorede_attendees ORDER BY created_at ASC, id ASC LIMIT 250');
    return rows;
  }
  return memoryCache.map(({id, name}) => ({id,name}));
}
async function register(name, token, contact) {
  const nameKey = keyName(name);
  if(pool) {
    try {
      const result = await pool.query('INSERT INTO acorede_attendees (name, name_key, token_hash, contact) VALUES ($1,$2,$3,$4) RETURNING id::text AS id', [name,nameKey,hashToken(token),contact]);
      return result.rows[0].id;
    } catch (error) {
      if(error.code === '23505') throw Object.assign(new Error('이미 등록된 이름입니다. 이미 참석 등록되었는지 확인해주세요.'), {status:409});
      throw error;
    }
  }
  if (memoryCache.some(p => p.nameKey === nameKey)) throw Object.assign(new Error('이미 등록된 이름입니다. 이미 참석 등록되었는지 확인해주세요.'), {status:409});
  const id = crypto.randomUUID();
  memoryCache.push({id,name,nameKey,contact,tokenHash:hashToken(token)});
  await persist();
  return id;
}
async function unregister(id, token) {
  if(pool) {
    if (!/^\d{1,19}$/.test(id)) return false;
    const result = await pool.query('DELETE FROM acorede_attendees WHERE id = $1 AND token_hash = $2', [id,hashToken(token)]);
    return result.rowCount > 0;
  }
  const idx = memoryCache.findIndex(p => p.id === id && p.tokenHash === hashToken(token));
  if(idx === -1) return false;
  memoryCache.splice(idx,1);
  await persist();
  return true;
}
async function staticFile(req, res, pathname) {
  const files = {
    '/': ['index.html','text/html; charset=utf-8'],
    '/index.html': ['index.html','text/html; charset=utf-8'],
    '/style.css': ['style.css','text/css; charset=utf-8'],
    '/admin': ['admin.html','text/html; charset=utf-8'],
    '/admin.js': ['admin.js','text/javascript; charset=utf-8'],
    '/app.js': ['app.js','text/javascript; charset=utf-8'],
    '/invitation.webp': ['invitation.webp','image/webp'],
  };
  const target = files[pathname];
  if (!target || req.method !== 'GET') return json(res,404,{message:'페이지를 찾을 수 없습니다.'});
  const content = await fs.readFile(path.join(root, target[0]));
  res.writeHead(200, {
    'Content-Type': target[1],
    'Content-Length': content.length,
    'Cache-Control': pathname === '/invitation.webp' ? 'public, max-age=86400' : 'no-cache',
    'X-Content-Type-Options':'nosniff',
    'X-Frame-Options':'DENY',
    'Referrer-Policy':'strict-origin-when-cross-origin',
    'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'",
  });
  res.end(content);
}
async function handle(req,res) {
  try {
    const parsed = new URL(req.url, 'http://localhost');
    const url = parsed.pathname;
    if(url === '/health' && req.method === 'GET') return json(res,200,{ok:true,db:pool?'postgres':'local'});
    if (url === '/api/admin/attendees' && req.method === 'GET') {
      if (tooMany('admin:' + clientAddress(req))) return json(res,429,{message:'요청이 너무 많습니다. 잠시 후 다시 시도해주세요.'});
      if (!adminAuthorized(req)) return json(res,401,{message:'관리자 비밀번호를 확인해주세요. 관리자 비밀번호는 서버에 16자 이상으로 설정되어야 합니다.'});
      const attendees = pool
        ? (await pool.query('SELECT id::text AS id, name, contact FROM acorede_attendees ORDER BY created_at ASC, id ASC LIMIT 250')).rows
        : memoryCache.map(({id,name,contact}) => ({id,name,contact:contact || ''}));
      return json(res,200,{attendees});
    }
    if(url === '/api/attendees') {
      if(req.method === 'GET') return json(res,200,{attendees:await all()});
      if(req.method === 'POST') {
        if(!sameOrigin(req)) return json(res,403,{message:'허용되지 않은 요청입니다.'});
        if(tooMany(clientAddress(req))) return json(res,429,{message:'요청이 너무 많습니다. 잠시 후 다시 시도해주세요.'});
        const body = await readBody(req);
        const name = validateName(body.name);
        const contact = validateContact(body.contact);
        if (contact === null) return json(res,400,{message:'연락처를 80자 이내로 입력해주세요.'});
        if(!name) return json(res,400,{message:'별명 대신 이름을 1~20자로 입력해주세요. 숫자와 특수문자는 사용할 수 없습니다.'});
        if(!validToken(body.token)) return json(res,400,{message:'잘못된 인증 정보입니다.'});
        const current = await all();
        if(current.length >= 250) return json(res,403,{message:'등록 가능한 인원을 초과했습니다.'});
        const id = await register(name,body.token,contact);
        return json(res,201,{id,name});
      }
      return json(res,405,{message:'지원하지 않는 요청입니다.'});
    }
    if (url.startsWith('/api/attendees/') && req.method === 'DELETE') {
      if(!sameOrigin(req)) return json(res,403,{message:'허용되지 않은 요청입니다.'});
      if(tooMany(clientAddress(req))) return json(res,429,{message:'요청이 너무 많습니다. 잠시 후 다시 시도해주세요.'});
      const id = url.slice('/api/attendees/'.length);
      const body = await readBody(req);
      if(!validToken(body.token)) return json(res,400,{message:'잘못된 인증 정보입니다.'});
      const removed = await unregister(id,body.token);
      if(!removed) return json(res,403,{message:'해당 기기에서 등록한 참석 정보만 취소할 수 있습니다.'});
      return json(res,200,{ok:true});
    }
    return staticFile(req,res,url);
  }catch(error) {
    console.error('요청 처리 실패:', error.code || error.status || 'unknown');
    return json(res,error.status||500,{message:error.status?error.message:'서버 오류가 발생했습니다.'});
  }
}
init().then(() => {
  const server = http.createServer(handle);
  server.listen(PORT,'0.0.0.0', () => console.log(`http://localhost:${PORT}`));
}).catch(error => {console.error('시작 실패:',error.message);process.exit(1);});
