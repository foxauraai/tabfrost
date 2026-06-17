// TabFrost Popup Script

let allTabs = [];
let settings = {};
let currentFilter = 'all';

const $ = id => document.getElementById(id);

async function init() {
  // Kick off storage + tabs fetches in parallel — biggest single win
  const [stor, tabsResult] = await Promise.all([
    chrome.storage.local.get(null),
    fetchTabsDirect()
  ]);

  settings = stor;
  document.documentElement.setAttribute('data-theme', settings.theme || 'light');
  updateToggle();

  if (tabsResult) {
    allTabs = tabsResult;
    renderTabs();
    updateFreezeCount();
  } else {
    $('tab-list').innerHTML = '<div class="empty-state"><div class="icon">⚠️</div>Could not load tabs.<br>Try reopening the popup.</div>';
  }

  updateStats();
  setupEvents();
}

// Query tabs directly from the popup instead of a background sendMessage round-trip.
// This avoids the IPC overhead that makes Firefox popups feel sluggish.
async function fetchTabsDirect() {
  try {
    const [allTabsRaw, activeTabs] = await Promise.all([
      chrome.tabs.query({ currentWindow: true }),
      chrome.tabs.query({ active: true, currentWindow: true })
    ]);
    const activeId = activeTabs[0]?.id;
    const now = Date.now();

    // Get idle times from background via a single message (just the activity map)
    let activityMap = {};
    try {
      const res = await chrome.runtime.sendMessage({ action: 'getActivityMap' });
      if (res?.activityMap) activityMap = res.activityMap;
    } catch {}

    return allTabsRaw.map(tab => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl,
      discarded: tab.discarded,
      pinned: tab.pinned,
      active: tab.id === activeId,
      idleMs: activityMap[tab.id] ? now - activityMap[tab.id] : null
    }));
  } catch {
    return null;
  }
}

async function loadTabs() {
  const result = await fetchTabsDirect();
  if (!result) {
    $('tab-list').innerHTML = '<div class="empty-state"><div class="icon">⚠️</div>Could not load tabs.<br>Try reopening the popup.</div>';
    return;
  }
  allTabs = result;
  renderTabs();
  updateFreezeCount();
}

function updateStats() {
  const activeReal = allTabs.filter(t => !t.discarded).length;
  const suspended = allTabs.filter(t => t.discarded).length;
  $('stat-active').textContent = activeReal;
  $('stat-suspended').textContent = suspended;
}

function updateFreezeCount() {
  const freezable = allTabs.filter(t =>
    !t.discarded && !t.active && !t.pinned && !isWhitelisted(t.url)
  ).length;
  $('freeze-count').textContent = freezable;
}

function isWhitelisted(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    const wl = settings.whitelist || [];
    return wl.some(w => host === w || host.endsWith('.' + w));
  } catch { return false; }
}

function formatIdle(ms) {
  if (!ms) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m idle`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m idle`;
}

function renderTabs() {
  const list = $('tab-list');
  list.textContent = '';

  let filtered = allTabs;
  if (currentFilter === 'active') filtered = allTabs.filter(t => !t.discarded);
  if (currentFilter === 'suspended') filtered = allTabs.filter(t => t.discarded);

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<div class="icon">🧊</div>No tabs in this view';
    list.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();

  filtered.forEach(tab => {
    const whitelisted = isWhitelisted(tab.url);
    const idleStr = formatIdle(tab.idleMs);

    const item = document.createElement('div');
    item.className = 'tab-item';
    if (tab.active) item.classList.add('is-active');
    if (tab.discarded) item.classList.add('is-suspended');

    // Favicon
    if (tab.favIconUrl) {
      const img = document.createElement('img');
      img.className = 'tab-favicon';
      img.src = tab.favIconUrl;
      img.addEventListener('error', function() {
        const plc = document.createElement('div');
        plc.className = 'tab-favicon-placeholder';
        plc.textContent = '\uD83C\uDF10';
        this.replaceWith(plc);
      });
      item.appendChild(img);
    } else {
      const plc = document.createElement('div');
      plc.className = 'tab-favicon-placeholder';
      plc.textContent = '\uD83C\uDF10';
      item.appendChild(plc);
    }

    // Info
    const info = document.createElement('div');
    info.className = 'tab-info';

    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = tab.title || 'Untitled';
    title.title = tab.title || tab.url || '';
    info.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'tab-meta';

    if (tab.active) {
      const b = document.createElement('span');
      b.className = 'tab-badge active';
      b.textContent = '\u25CF Active';
      meta.appendChild(b);
    }
    if (tab.discarded) {
      const b = document.createElement('span');
      b.className = 'tab-badge suspended';
      b.textContent = '\u2744 Frozen';
      meta.appendChild(b);
    }
    if (tab.pinned) {
      const b = document.createElement('span');
      b.className = 'tab-badge pinned';
      b.textContent = '\uD83D\uDCCC';
      meta.appendChild(b);
    }
    if (whitelisted) {
      const b = document.createElement('span');
      b.className = 'tab-badge';
      b.style.cssText = 'background:rgba(129,140,248,0.15);color:#818cf8';
      b.textContent = '\u2713 Safe';
      meta.appendChild(b);
    }
    if (idleStr) {
      const s = document.createElement('span');
      s.className = 'tab-idle';
      s.textContent = idleStr;
      meta.appendChild(s);
    }

    info.appendChild(meta);
    item.appendChild(info);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'tab-actions';

    if (!tab.active) {
      if (tab.discarded) {
        const btn = document.createElement('button');
        btn.className = 'tab-action-btn';
        btn.dataset.action = 'reload';
        btn.dataset.tabId = tab.id;
        btn.title = 'Reload tab';
        btn.textContent = '\u25B6';
        actions.appendChild(btn);
      } else if (!tab.pinned && !whitelisted) {
        const btn = document.createElement('button');
        btn.className = 'tab-action-btn danger';
        btn.dataset.action = 'suspend';
        btn.dataset.tabId = tab.id;
        btn.title = 'Freeze tab';
        btn.textContent = '\u2744';
        actions.appendChild(btn);
      }
    }
    const activate = document.createElement('button');
    activate.className = 'tab-action-btn';
    activate.dataset.action = 'activate';
    activate.dataset.tabId = tab.id;
    activate.title = 'Switch to tab';
    activate.textContent = '\u2197';
    actions.appendChild(activate);

    item.appendChild(actions);
    frag.appendChild(item);
  });

  list.appendChild(frag);
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function suspendTab(tabId) {
  await chrome.runtime.sendMessage({ action: 'suspendTab', tabId });
  showToast('❄️ Tab frozen');
  settings = await chrome.storage.local.get(null);
  await loadTabs();
  updateStats();
}

async function reloadTab(tabId) {
  await chrome.runtime.sendMessage({ action: 'reloadTab', tabId });
  showToast('▶ Tab reloaded');
  await loadTabs();
  updateStats();
}

async function activateTab(tabId) {
  await chrome.runtime.sendMessage({ action: 'activateTab', tabId });
  window.close();
}

document.getElementById('tab-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const tabId = parseInt(btn.dataset.tabId);
  const action = btn.dataset.action;
  if (action === 'suspend') suspendTab(tabId);
  else if (action === 'reload') reloadTab(tabId);
  else if (action === 'activate') activateTab(tabId);
});

async function freezeAll() {
  const btn = $('btn-freeze-all');
  btn.style.opacity = '0.6';
  btn.style.pointerEvents = 'none';
  const result = await chrome.runtime.sendMessage({ action: 'suspendAll' });
  const count = result?.count ?? 0;
  showToast(`❄️ Froze ${count} tab${count !== 1 ? 's' : ''}!`);
  settings = await chrome.storage.local.get(null);
  await loadTabs();
  updateStats();
  btn.style.opacity = '';
  btn.style.pointerEvents = '';
}

function updateToggle() {
  const toggle = $('toggle-enabled');
  const label = $('toggle-label');
  const on = settings.enabled !== false;
  toggle.className = 'toggle' + (on ? ' on' : '');
  label.textContent = on ? 'ON' : 'OFF';
}

function setupEvents() {
  $('toggle-enabled').addEventListener('click', async () => {
    settings.enabled = !settings.enabled;
    await chrome.storage.local.set({ enabled: settings.enabled });
    updateToggle();
  });

  $('btn-freeze-all').addEventListener('click', freezeAll);

  $('btn-settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.dataset.filter;
      renderTabs();
    });
  });
}

function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

document.addEventListener('DOMContentLoaded', init);
