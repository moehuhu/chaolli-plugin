const NOTIFICATIONS_PATH = "/index.php/?p=settings/notifications.view/1";
const NOTIFICATION_CHECK_PATH = "/index.php/?p=settings/notificationCheck.ajax";
const NOTIFICATIONS_URL = `https://chaoli.club${NOTIFICATIONS_PATH}`;
const NOTIFICATION_CHECK_URL = `https://chaoli.club${NOTIFICATION_CHECK_PATH}`;
const COOKIE_RULE_ID = 1001;
const CHECK_ALARM_NAME = "notificationCheck";
const CHECK_INTERVAL_MINUTES = 1;

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error);
      else resolve();
    };

    const timer = setTimeout(() => finish(new Error("TIMEOUT")), timeoutMs);

    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") {
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") finish();
      })
      .catch((error) => finish(error));
  });
}

async function findChaoliTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://chaoli.club/*", "https://www.chaoli.club/*"]
  });
  return tabs.find((tab) => tab.id && !tab.discarded) || tabs[0] || null;
}

function isUsableResult(result) {
  const html = result?.html || "";
  if (!result?.ok || !html.trim()) return false;
  if (/sorry, you have been blocked/i.test(html)) return false;
  if (/user\/login|user\/join/i.test(result.url || "")) return false;
  if (/name=["']username["']/i.test(html) && /name=["']password["']/i.test(html)) {
    return false;
  }
  return true;
}

async function fetchFromTab(tab, path = NOTIFICATIONS_PATH) {
  if (tab.discarded) {
    await chrome.tabs.reload(tab.id);
    await waitForTabComplete(tab.id);
  } else if (tab.status !== "complete") {
    await waitForTabComplete(tab.id);
  }

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (requestPath) => {
      const response = await fetch(`${location.origin}${requestPath}`, {
        method: "GET",
        credentials: "include",
        cache: "no-store"
      });
      return {
        ok: response.ok,
        status: response.status,
        url: response.url,
        html: await response.text()
      };
    },
    args: [path]
  });

  if (!injection || injection.result == null) {
    throw new Error("FETCH_FAILED");
  }
  return injection.result;
}

async function getChaoliCookies() {
  const stores = await chrome.cookies.getAllCookieStores();
  const queries = [];

  for (const store of stores) {
    queries.push(
      chrome.cookies.getAll({
        domain: "chaoli.club",
        storeId: store.id,
        partitionKey: {}
      }),
      chrome.cookies.getAll({
        domain: "chaoli.club",
        storeId: store.id
      })
    );
  }

  queries.push(chrome.cookies.getAll({ domain: "chaoli.club", partitionKey: {} }));
  queries.push(chrome.cookies.getAll({ domain: "chaoli.club" }));

  const groups = await Promise.all(
    queries.map((request) => request.catch(() => []))
  );
  const cookies = new Map();
  for (const cookie of groups.flat()) {
    const partition = cookie.partitionKey?.topLevelSite || "";
    cookies.set(
      `${cookie.name}|${cookie.domain}|${cookie.path}|${partition}|${cookie.storeId}`,
      cookie
    );
  }
  return [...cookies.values()];
}

async function buildCookieHeader() {
  const cookies = await getChaoliCookies();
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

let cookieFetchQueue = Promise.resolve();

async function fetchWithStoredCookies(url = NOTIFICATIONS_URL) {
  const run = async () => {
    const cookieHeader = await buildCookieHeader();
    if (!cookieHeader) {
      return { ok: false, status: 0, html: "" };
    }

    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [COOKIE_RULE_ID],
      addRules: [
        {
          id: COOKIE_RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Cookie", operation: "set", value: cookieHeader },
              { header: "Referer", operation: "set", value: "https://chaoli.club/" }
            ]
          },
          condition: {
            initiatorDomains: [chrome.runtime.id],
            requestDomains: ["chaoli.club", "www.chaoli.club"],
            resourceTypes: ["xmlhttprequest", "other"]
          }
        }
      ]
    });

    try {
      const response = await fetch(url, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "follow"
      });
      return {
        ok: response.ok,
        status: response.status,
        url: response.url,
        html: await response.text()
      };
    } finally {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [COOKIE_RULE_ID]
      });
    }
  };

  const pending = cookieFetchQueue.then(run, run);
  cookieFetchQueue = pending.then(
    () => {},
    () => {}
  );
  return pending;
}

async function fetchFromHiddenTab() {
  const tab = await chrome.tabs.create({
    url: "https://chaoli.club/",
    active: false
  });
  try {
    await waitForTabComplete(tab.id);
    return await fetchFromTab(tab, NOTIFICATIONS_PATH);
  } finally {
    try {
      if (tab.id) await chrome.tabs.remove(tab.id);
    } catch {
      // Tab may already be gone.
    }
  }
}

async function fetchNotifications() {
  const existingTab = await findChaoliTab();
  if (existingTab) {
    const fromTab = await fetchFromTab(existingTab, NOTIFICATIONS_PATH);
    if (isUsableResult(fromTab)) return fromTab;
  }

  try {
    const fromCookies = await fetchWithStoredCookies(NOTIFICATIONS_URL);
    if (isUsableResult(fromCookies)) return fromCookies;
  } catch {
    // Fall through to a hidden tab.
  }

  return await fetchFromHiddenTab();
}

function parseNotificationCheck(result) {
  const text = (result?.html || "").trim();
  if (!text) return null;
  if (/sorry, you have been blocked/i.test(text)) return null;
  if (text.startsWith("<") || /name=["']username["']/i.test(text)) return null;
  try {
    const data = JSON.parse(text);
    const count = Number(data?.count);
    if (!Number.isFinite(count)) return null;
    data.count = count;
    return data;
  } catch {
    return null;
  }
}

async function fetchNotificationCheck() {
  const existingTab = await findChaoliTab();
  if (existingTab) {
    try {
      const fromTab = await fetchFromTab(existingTab, NOTIFICATION_CHECK_PATH);
      const data = parseNotificationCheck(fromTab);
      if (data) return data;
    } catch {
      // Fall through to cookie-based fetch.
    }
  }

  try {
    const fromCookies = await fetchWithStoredCookies(NOTIFICATION_CHECK_URL);
    return parseNotificationCheck(fromCookies);
  } catch {
    return null;
  }
}

function badgeTextForCount(count) {
  if (!count || count <= 0) return "";
  return count > 99 ? "99+" : String(count);
}

async function updateBadge(count) {
  const text = badgeTextForCount(count);
  await chrome.action.setBadgeText({ text });
  if (text) {
    await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: "#ffffff" });
    }
  }
}

async function pollNotificationCount() {
  try {
    const data = await fetchNotificationCheck();
    if (!data) return;
    if (!data.userId) {
      await updateBadge(0);
      return;
    }
    await updateBadge(data.count);
  } catch {
    // Keep the last badge on transient failures.
  }
}

async function ensureCheckAlarm() {
  const existing = await chrome.alarms.get(CHECK_ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(CHECK_ALARM_NAME, {
      periodInMinutes: CHECK_INTERVAL_MINUTES
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(CHECK_ALARM_NAME, {
    periodInMinutes: CHECK_INTERVAL_MINUTES
  });
  pollNotificationCount();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(CHECK_ALARM_NAME, {
    periodInMinutes: CHECK_INTERVAL_MINUTES
  });
  pollNotificationCount();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM_NAME) {
    pollNotificationCount();
  }
});

ensureCheckAlarm();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "FETCH_NOTIFICATIONS") {
    return;
  }

  fetchNotifications()
    .then((result) => {
      sendResponse(result);
      pollNotificationCount();
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        status: 0,
        error: error.message || "FETCH_FAILED"
      });
    });

  return true;
});
