'use strict';
const $ = (id) => document.getElementById(id);
const form = $('attend-form');
const nameInput = $('guest-name');
const status = $('status');
const list = $('guest-list');
const count = $('count');
const registerButton = $('register-button');
const cancelButton = $('cancel-button');
const refreshButton = $('refresh-button');
const myStorageKey = 'acorede_attendance_owner_v1';

function getMine() {
  try {
    const value = JSON.parse(localStorage.getItem(myStorageKey));
    if (value && typeof value.id === 'string' && typeof value.token === 'string') return value;
  } catch (_) {}
  return null;
}
function setMine(value) {
  try {
    if (value) localStorage.setItem(myStorageKey, JSON.stringify(value));
    else localStorage.removeItem(myStorageKey);
  } catch (_) {}
}
function message(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}
function uuidToken() {
  const buf = new Uint8Array(32);
  window.crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}
async function request(path, options) {
  const result = await fetch(path, { cache: 'no-store', ...options });
  const data = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(data.message || '잠시 후 다시 시도해주세요.');
  return data;
}
function updateMine(attendees) {
  const mine = getMine();
  const found = mine && attendees.find(a => a.id === mine.id);
  $('mine').hidden = !found;
  form.hidden = Boolean(found);
  if (found) $('my-name').textContent = found.name;
  else if (mine) setMine(null);
}
function draw(attendees) {
  count.textContent = String(attendees.length);
  list.replaceChildren();
  if (attendees.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '아직 등록된 참석자가 없습니다. 첫 번째로 이름을 남겨주세요.';
    list.append(empty);
  }
  const mine = getMine();
  for (const attendee of attendees) {
    const item = document.createElement('li');
    if (mine && attendee.id === mine.id) item.className = 'is-mine';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = attendee.name.slice(0, 1);
    avatar.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = attendee.name;
    item.append(avatar, name);
    list.append(item);
  }
  updateMine(attendees);
}
async function load({silent = false} = {}) {
  refreshButton.disabled = true;
  try {
    const data = await request('/api/attendees');
    draw(data.attendees || []);
    if (!silent) message('명단을 새로고침했습니다.');
  } catch (error) {
    if (!silent) message('명단을 가져오지 못했습니다. 다시 시도해주세요.', true);
    if (list.querySelector('.loading')) {
      const li = document.createElement('li');
      li.className = 'failure';
      li.textContent = '연결에 실패했습니다. 새로고침을 눌러 다시 시도해주세요.';
      list.replaceChildren(li);
    }
  } finally {
    refreshButton.disabled = false;
  }
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = nameInput.value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 20) return message('이름은 1~20자로 입력해주세요.', true);
  if (!/^[\p{L}\p{N} ._-]+$/u.test(name)) return message('이름에 사용할 수 없는 문자가 있습니다.', true);
  registerButton.disabled = true;
  message('등록 중입니다…');
  const token = uuidToken();
  try {
    const result = await request('/api/attendees', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({name, token})
    });
    setMine({id: result.id, token});
    nameInput.value = '';
    await load({silent: true});
    message('참석 등록이 완료되었습니다.');
  } catch (error) {
    message(error.message, true);
  } finally {
    registerButton.disabled = false;
  }
});
cancelButton.addEventListener('click', async () => {
  const mine = getMine();
  if (!mine || !window.confirm('참석 등록을 취소하시겠습니까?')) return;
  cancelButton.disabled = true;
  try {
    await request(`/api/attendees/${encodeURIComponent(mine.id)}`, {
      method: 'DELETE', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: mine.token})
    });
    setMine(null);
    await load({silent: true});
    message('등록이 취소되었습니다.');
  } catch(error) {
    message(error.message, true);
  } finally {
    cancelButton.disabled = false;
  }
});
refreshButton.addEventListener('click', () => load());
load({silent: true});
setInterval(() => { if (!document.hidden) load({silent: true}); }, 30000);
