// TabFrost Background Service Worker

const DEFAULT_SETTINGS = {
  autoSuspendMinutes: 30,
  whitelist: [],
  enabled: true,
  suspendCount: 0,
  theme: 'light'
};

// In-memory mirror of tabActivity — synced to session storage (Chrome) or
// local storage (Firefox, which doesn't support storage.session in MV3)
const tabActivity = {};

// ─── Persist / restore tabActivity ──────────────────────────────────────────

// storage.session survives SW restarts but clears on browser close (Chrome MV3).
// Firefox MV3 doesn't support storage.session, so we fall back to storage.local.
const activityStore = (() => {
  try {
    if (chrome.storage.session) return chrome.storage.session;
  } catch {}
  return chrome.storage.local;
})();

async function saveActivity() {
  try {
    await activityStore.set({ tabActivity: JSON.stringify(tabActivity) });
  } catch {}
}

async function loadActivity() {
  try {
    const saved = await activityStore.get('tabActivity');
    if (saved.tabActivity) {
      Object.assign(tabActivity, JSON.parse(saved.tabActivity));
    }
  } catch {}
}

// ─── Init ───────────────────────────────────────────────────────────────────

async function seedTabs() {
  const tabs = await chrome.tabs.query({});
  let changed = false;
  for (const tab of tabs) {
    if (!tabActivity[tab.id]) {
      tabActivity[tab.id] = Date.now();
      changed = true;
    }
  }
  if (changed) await saveActivity();
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(null);
  const settings = { ...DEFAULT_SETTINGS, ...existing };
  await chrome.storage.local.set(settings);
  await loadActivity();
  await seedTabs();
  scheduleAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadActivity();
  await seedTabs();
  scheduleAlarm();
});

// Restore activity on SW wake (covers restarts mid-session)
loadActivity();

// ─── Alarms ─────────────────────────────────────────────────────────────────

function scheduleAlarm() {
  chrome.alarms.clearAll(() => {
    chrome.alarms.create('checkTabs', { periodInMinutes: 1 });
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'checkTabs') {
    await loadActivity(); // re-sync in case SW restarted
    await autoSuspendCheck();
  }
});

// ─── Tab Activity Tracking ───────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  tabActivity[tabId] = Date.now();
  await saveActivity();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    tabActivity[tabId] = Date.now();
    await saveActivity();
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  delete tabActivity[tabId];
  await saveActivity();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  tabActivity[tab.id] = Date.now();
  await saveActivity();
});

// ─── Auto Suspend Logic ──────────────────────────────────────────────────────

async function autoSuspendCheck() {
  const settings = await chrome.storage.local.get(null);
  if (!settings.enabled) return;

  const thresholdMs = (settings.autoSuspendMinutes || 30) * 60 * 1000;
  const now = Date.now();

  // Seed any tabs that are still missing from tabActivity (e.g. after SW restart
  // if storage.session was lost). They'll be eligible on the next cycle.
  await seedTabs();

  // Get active tabs across ALL windows so we never suspend a focused tab
  const activeTabs = await chrome.tabs.query({ active: true });
  const activeIds = new Set(activeTabs.map(t => t.id));

  const allTabs = await chrome.tabs.query({});

  for (const tab of allTabs) {
    if (activeIds.has(tab.id)) continue;
    if (tab.discarded) continue;
    if (tab.pinned) continue;
    if (isWhitelisted(tab.url, settings.whitelist || [])) continue;
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) continue;

    const lastActive = tabActivity[tab.id];
    if (!lastActive) continue; // should not happen after seedTabs(), but guard

    const idle = now - lastActive;

    if (idle >= thresholdMs) {
      await suspendTab(tab.id);
    }
  }
}

function isWhitelisted(url, whitelist) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return whitelist.some(w => hostname === w || hostname.endsWith('.' + w));
  } catch {
    return false;
  }
}

async function suspendTab(tabId) {
  try {
    await chrome.tabs.discard(tabId);
    // Re-read count from storage right before writing to avoid race conditions
    const { suspendCount } = await chrome.storage.local.get('suspendCount');
    await chrome.storage.local.set({ suspendCount: (suspendCount || 0) + 1 });
  } catch {
    // Tab may have been closed or already discarded
  }
}

// ─── Message Handler (from popup) ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'suspendAll') {
    suspendAllTabs().then(count => sendResponse({ count }));
    return true;
  }
  if (msg.action === 'getTabsInfo') {
    loadActivity().then(() => getTabsInfo()).then(info => sendResponse(info));
    return true;
  }
  // Lightweight handler: popup queries tabs directly and only needs the activity map
  if (msg.action === 'getActivityMap') {
    loadActivity().then(() => sendResponse({ activityMap: { ...tabActivity } }));
    return true;
  }
  if (msg.action === 'suspendTab') {
    suspendTab(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === 'reloadTab') {
    chrome.tabs.reload(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === 'activateTab') {
    chrome.tabs.update(msg.tabId, { active: true }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function suspendAllTabs() {
  const settings = await chrome.storage.local.get(null);

  // Protect active tabs across all windows
  const activeTabs = await chrome.tabs.query({ active: true });
  const activeIds = new Set(activeTabs.map(t => t.id));

  const allTabs = await chrome.tabs.query({ currentWindow: true });
  let count = 0;

  for (const tab of allTabs) {
    if (activeIds.has(tab.id)) continue;
    if (tab.discarded) continue;
    if (tab.pinned) continue;
    if (isWhitelisted(tab.url, settings.whitelist || [])) continue;
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) continue;

    try {
      await chrome.tabs.discard(tab.id);
      count++;
    } catch {}
  }

  // Re-read from storage to avoid race with per-tab suspendTab calls
  const { suspendCount } = await chrome.storage.local.get('suspendCount');
  await chrome.storage.local.set({ suspendCount: (suspendCount || 0) + count });

  return count;
}

async function getTabsInfo() {
  const allTabs = await chrome.tabs.query({ currentWindow: true });
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeId = activeTabs[0]?.id;
  const now = Date.now();

  const tabs = allTabs.map(tab => {
    const lastActive = tabActivity[tab.id];
    const idleMs = lastActive ? now - lastActive : null;
    return {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl,
      discarded: tab.discarded,
      pinned: tab.pinned,
      active: tab.id === activeId,
      idleMs
    };
  });

  return { tabs };
}
