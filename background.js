const NOTIFICATIONS_PATH = "/index.php/?p=settings/notifications.view/1";
const NOTIFICATIONS_URL = `https://chaoli.club${NOTIFICATIONS_PATH}`;
const COOKIE_RULE_ID = 1001;

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

async function fetchFromTab(tab) {
  if (tab.discarded) {
    await chrome.tabs.reload(tab.id);
    await waitForTabComplete(tab.id);
  } else if (tab.status !== "complete") {
    await waitForTabComplete(tab.id);
  }

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (path) => {
      const response = await fetch(`${location.origin}${path}`, {
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
    args: [NOTIFICATIONS_PATH]
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

async function fetchWithStoredCookies() {
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
    const response = await fetch(NOTIFICATIONS_URL, {
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
}

async function fetchFromHiddenTab() {
  const tab = await chrome.tabs.create({
    url: "https://chaoli.club/",
    active: false
  });
  try {
    await waitForTabComplete(tab.id);
    return await fetchFromTab(tab);
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
    const fromTab = await fetchFromTab(existingTab);
    if (isUsableResult(fromTab)) return fromTab;
  }

  try {
    const fromCookies = await fetchWithStoredCookies();
    if (isUsableResult(fromCookies)) return fromCookies;
  } catch {
    // Fall through to a hidden tab.
  }

  return await fetchFromHiddenTab();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "FETCH_NOTIFICATIONS") {
    return;
  }

  fetchNotifications()
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        status: 0,
        error: error.message || "FETCH_FAILED"
      });
    });

  return true;
});
