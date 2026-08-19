const ORIGIN = "https://chaoli.club";
const NOTIFICATIONS_URL = `${ORIGIN}/index.php/?p=settings/notifications.view/1`;
const NOTIFICATION_CHECK_URL = `${ORIGIN}/index.php/?p=settings/notificationCheck.ajax`;
const COOKIE_RULE_ID = 1001;
const CHECK_ALARM_NAME = "notificationCheck";
const CHECK_INTERVAL_MINUTES = 1;

const BLOCKED_PATTERN = /sorry, you have been blocked/i;
const LOGIN_URL_PATTERN = /user\/login|user\/join/i;

function looksLikeLoginPage(html) {
  return (
    /name=["']username["']/i.test(html) && /name=["']password["']/i.test(html)
  );
}

function classify(response, body) {
  if (BLOCKED_PATTERN.test(body)) return { ok: false, error: "BLOCKED" };
  if (!response.ok) return { ok: false, error: `HTTP_${response.status}` };
  if (LOGIN_URL_PATTERN.test(response.url) || looksLikeLoginPage(body)) {
    return { ok: false, error: "LOGIN" };
  }
  if (!body.trim()) return { ok: false, error: "FETCH_FAILED" };
  return { ok: true, html: body, url: response.url };
}

async function buildCookieHeader(url) {
  const cookies = await chrome.cookies.getAll({ url });
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function withCookieRule(cookieHeader, task) {
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
            { header: "Referer", operation: "set", value: `${ORIGIN}/` }
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
    return await task();
  } finally {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [COOKIE_RULE_ID]
    });
  }
}

// The session rule is global, so requests must not overlap.
let requestQueue = Promise.resolve();

function serialize(task) {
  const pending = requestQueue.then(task, task);
  requestQueue = pending.then(
    () => {},
    () => {}
  );
  return pending;
}

function fetchSite(url) {
  return serialize(async () => {
    const cookieHeader = await buildCookieHeader(url);
    if (!cookieHeader) return { ok: false, error: "LOGIN" };

    return withCookieRule(cookieHeader, async () => {
      const response = await fetch(url, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "follow"
      });
      return classify(response, await response.text());
    });
  });
}

// null means "unknown" (keep the current badge); a number is authoritative.
async function fetchNotificationCount() {
  try {
    const result = await fetchSite(NOTIFICATION_CHECK_URL);
    if (!result.ok) return result.error === "LOGIN" ? 0 : null;

    const data = JSON.parse(result.html);
    if (!data?.userId) return 0;
    const count = Number(data.count);
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

async function updateBadge(count) {
  const text = count > 0 ? (count > 99 ? "99+" : String(count)) : "";
  await chrome.action.setBadgeText({ text });
  if (!text) return;

  await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  }
}

async function pollNotificationCount() {
  const count = await fetchNotificationCount();
  if (count !== null) await updateBadge(count);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM_NAME) pollNotificationCount();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "FETCH_NOTIFICATIONS") return;

  fetchSite(NOTIFICATIONS_URL)
    .then((result) => {
      sendResponse(result);
      pollNotificationCount();
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error?.message || "FETCH_FAILED" });
    });

  return true;
});

// Runs on every service-worker wake-up, which covers install and browser start.
(async () => {
  if (!(await chrome.alarms.get(CHECK_ALARM_NAME))) {
    await chrome.alarms.create(CHECK_ALARM_NAME, {
      periodInMinutes: CHECK_INTERVAL_MINUTES
    });
  }
  await pollNotificationCount();
})();
