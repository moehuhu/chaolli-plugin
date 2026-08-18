const NOTIFICATIONS_PATH = "/index.php/?p=settings/notifications.view/1";

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
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
    }).catch((error) => finish(error));
  });
}

async function findChaoliTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://chaoli.club/*", "https://www.chaoli.club/*"]
  });
  return tabs.find((tab) => tab.id && !tab.discarded) || tabs[0] || null;
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "FETCH_NOTIFICATIONS") {
    return;
  }

  (async () => {
    const tab = await findChaoliTab();
    if (!tab) {
      return { ok: false, error: "NO_TAB" };
    }
    return await fetchFromTab(tab);
  })()
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
