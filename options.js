let settings = {};

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  settings = await chrome.storage.local.get(null);
  applyTheme(settings.theme || 'light');
  loadSettings();
  bindEvents();
}

function loadSettings() {
  const mins = settings.autoSuspendMinutes || 30;
  document.getElementById('range-minutes').value = mins;
  document.getElementById('range-display').textContent = mins;
  updateHoursDisplay(mins);

  renderWhitelist(settings.whitelist || []);

  document.getElementById('stats-count').textContent = settings.suspendCount || 0;

  // Theme toggle — default is light, so checked = dark
  const isDark = (settings.theme || 'light') === 'dark';
  document.getElementById('theme-toggle').checked = isDark;
  document.getElementById('theme-label').textContent = isDark ? '🌙 Dark' : '☀️ Light';
}

function updateHoursDisplay(mins) {
  const el = document.getElementById('range-hours-display');
  if (mins >= 60) {
    const h = Math.floor(mins / 60), m = mins % 60;
    el.textContent = `(${h}h${m > 0 ? ' ' + m + 'm' : ''})`;
  } else {
    el.textContent = '';
  }
}

function renderWhitelist(list) {
  const el = document.getElementById('whitelist-items');
  el.textContent = '';
  if (!list.length) {
    const empty = document.createElement('span');
    empty.className = 'whitelist-empty';
    empty.textContent = 'No domains whitelisted yet.';
    el.appendChild(empty);
    return;
  }
  list.forEach((domain, i) => {
    const item = document.createElement('div');
    item.className = 'whitelist-item';

    const span = document.createElement('span');
    span.textContent = domain;

    const btn = document.createElement('button');
    btn.className = 'remove';
    btn.dataset.index = i;
    btn.title = 'Remove';
    btn.textContent = '\u00D7';
    btn.addEventListener('click', async () => {
      settings.whitelist.splice(parseInt(btn.dataset.index), 1);
      await chrome.storage.local.set({ whitelist: settings.whitelist });
      renderWhitelist(settings.whitelist);
    });

    item.appendChild(span);
    item.appendChild(btn);
    el.appendChild(item);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

// ─── Bind all events AFTER settings loaded ────────────────────────────────────
function bindEvents() {
  // Range slider
  document.getElementById('range-minutes').addEventListener('input', e => {
    const v = parseInt(e.target.value);
    document.getElementById('range-display').textContent = v;
    updateHoursDisplay(v);
  });

  // Add to whitelist
  document.getElementById('btn-add-whitelist').addEventListener('click', addWhitelistEntry);
  document.getElementById('whitelist-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addWhitelistEntry();
  });

  // Save settings
  document.getElementById('btn-save').addEventListener('click', async () => {
    settings.autoSuspendMinutes = parseInt(document.getElementById('range-minutes').value);
    settings.whitelist = settings.whitelist || [];
    await chrome.storage.local.set(settings);
    const msg = document.getElementById('saved-msg');
    msg.classList.add('show');
    setTimeout(() => msg.classList.remove('show'), 2500);
  });

  // Reset to defaults
  document.getElementById('btn-reset-stats').addEventListener('click', async () => {
    if (!confirm('Reset settings to defaults?')) return;
    settings.suspendCount = 0;
    settings.autoSuspendMinutes = 30;
    await chrome.storage.local.set({ suspendCount: 0, autoSuspendMinutes: 30 });
    loadSettings();
  });

  // Theme toggle — checked = dark, unchecked = light
  document.getElementById('theme-toggle').addEventListener('change', async (e) => {
    const theme = e.target.checked ? 'dark' : 'light';
    settings.theme = theme;
    applyTheme(theme);
    document.getElementById('theme-label').textContent = e.target.checked ? '🌙 Dark' : '☀️ Light';
    await chrome.storage.local.set({ theme });
  });
}

function addWhitelistEntry() {
  const input = document.getElementById('whitelist-input');
  const raw = input.value.trim().toLowerCase();
  if (!raw) return;
  let domain = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!domain) return;
  if (!settings.whitelist) settings.whitelist = [];
  if (!settings.whitelist.includes(domain)) {
    settings.whitelist.push(domain);
    renderWhitelist(settings.whitelist);
  }
  input.value = '';
}

document.addEventListener('DOMContentLoaded', init);
