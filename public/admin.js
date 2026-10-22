
'use strict';
const form = document.getElementById('admin-login');
const passwordInput = document.getElementById('admin-password');
const status = document.getElementById('admin-status');
const dataPanel = document.getElementById('admin-data');
const rows = document.getElementById('admin-rows');
let password = '';
function clear() {
  password = ''; passwordInput.value = ''; rows.replaceChildren();
  dataPanel.hidden = true; form.hidden = false;
}
async function load() {
  rows.replaceChildren(); dataPanel.hidden = true;
  status.textContent = '조회 중입니다…';
  try {
    const response = await fetch('/api/admin/attendees', {cache:'no-store',headers:{Authorization:'Bearer ' + password}});
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '조회에 실패했습니다.');
    for (const attendee of data.attendees) {
      const tr = document.createElement('tr');
      for (const value of [attendee.name, attendee.contact || '미입력']) {
        const td = document.createElement('td'); td.textContent = value; tr.append(td);
      }
      rows.append(tr);
    }
    form.hidden = true; dataPanel.hidden = false;
    status.textContent = `참석자 ${data.attendees.length}명`;
  } catch(error) { clear(); status.textContent = error.message; }
}
form.addEventListener('submit', event => {
  event.preventDefault(); password = passwordInput.value; passwordInput.value = ''; load();
});
document.getElementById('admin-refresh').addEventListener('click', load);
document.getElementById('admin-logout').addEventListener('click', () => {clear();status.textContent='로그아웃했습니다.';});
window.addEventListener('pagehide', clear);
