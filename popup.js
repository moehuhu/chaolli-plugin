const ORIGIN = "https://chaoli.club";
const SITE_ORIGINS = ["*://chaoli.club/*", "*://*.chaoli.club/*"];
const ALL_NOTIFICATIONS_URL = `${ORIGIN}/index.php/settings/notifications`;

const TYPE_LABELS = {
  post: "关注更新",
  mention: "提及",
  groupChange: "用户组"
};

const SKELETON = `
  <div class="skeleton" aria-hidden="true">
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>
  </div>
`;

const statusEl = document.getElementById("status");
const contentEl = document.getElementById("content");
const refreshBtn = document.getElementById("refresh-btn");

function showStatus(message, type = "error") {
  statusEl.hidden = !message;
  statusEl.textContent = message || "";
  statusEl.classList.toggle("info", type === "info");
}

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

// Only used for notification types we have no template for; keeps the server's
// markup out of the DOM while still showing its wording.
function plainText(html) {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.body.querySelectorAll("script, style, template").forEach((el) => el.remove());
  return doc.body.textContent.replace(/\s+/g, " ").trim();
}

function siteUrl(path, fallback) {
  try {
    const url = new URL(path, `${ORIGIN}/`);
    return url.origin === ORIGIN ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function relativeTime(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";

  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 30 * 86400) return `${Math.floor(diff / 86400)} 天前`;

  return new Date(seconds * 1000).toLocaleDateString("zh-CN");
}

function hashHue(text) {
  let hash = 0;
  for (const char of text) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return hash;
}

function letterAvatar(name) {
  const span = element("span", "avatar", [...name][0] || "超");
  span.style.background = `hsl(${hashHue(name)} 36% 46%)`;
  return span;
}

function avatar(item, name) {
  const fallback = letterAvatar(name);
  if (!item.avatarFormat || !item.fromMemberId) return fallback;

  const img = element("img", "avatar");
  img.src = `${ORIGIN}/uploads/avatars/avatar_${item.fromMemberId}.${item.avatarFormat}`;
  img.alt = name;
  img.loading = "lazy";
  img.addEventListener("error", () => img.replaceWith(fallback), { once: true });
  return img;
}

function actionContent(item, name) {
  const title = item.data?.title;
  if (!title) return [plainText(item.body) || name];

  if (item.type === "post") {
    return [`${name} 更新于 `, element("strong", null, title)];
  }
  if (item.type === "mention") {
    return [`${name} 在 `, element("strong", null, title), " 中提到了你"];
  }
  return [plainText(item.body) || `${name} · ${title}`];
}

function notificationRow(item) {
  const name = (item.fromMemberName || "").trim() || "某位用户";

  const time = element("small", "time");
  if (TYPE_LABELS[item.type]) {
    time.append(element("span", "type-tag", TYPE_LABELS[item.type]));
  }
  time.append(relativeTime(item.time));

  const action = element("span", "action");
  action.append(...actionContent(item, name));

  const link = element("a");
  link.href = siteUrl(item.link, ALL_NOTIFICATIONS_URL);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.append(avatar(item, name), action, time);

  const row = element("li", `notification-${item.type || "other"}`);
  if (item.unread) row.classList.add("unread");
  row.append(link);
  return row;
}

function viewAllFooter() {
  const link = element("a", null, "查看全部通知");
  link.href = ALL_NOTIFICATIONS_URL;
  link.target = "_blank";
  link.rel = "noopener noreferrer";

  const footer = element("div");
  footer.id = "viewAllNotifications";
  footer.append(link);
  return footer;
}

// Returns the nodes to display, or null when the payload is not the expected shape.
function render(payload) {
  const results = payload?.results;
  if (!Array.isArray(results)) return null;
  if (!results.length) return [];

  const list = element("ul", "notification-list");
  for (const item of results) {
    list.append(notificationRow(item));
  }
  return [list, viewAllFooter()];
}

async function ensureSiteAccess(canPrompt) {
  try {
    if (await chrome.permissions.contains({ origins: SITE_ORIGINS })) return true;
    return canPrompt
      ? await chrome.permissions.request({ origins: SITE_ORIGINS })
      : false;
  } catch {
    return false;
  }
}

const ERROR_MESSAGES = {
  BLOCKED:
    "请求被 Cloudflare 拦截。请先在普通标签页打开 chaoli.club，完成验证后再刷新。",
  LOGIN:
    "未检测到登录状态。请先在浏览器中登录 chaoli.club，登录后关闭标签页也可以继续查看通知。"
};

function showError(code) {
  if (code === "PERMISSION") {
    showStatus("需要允许扩展访问 chaoli.club，才能读取登录 cookie。点击「刷新」授权。");
    contentEl.replaceChildren(
      element(
        "p",
        "empty",
        "也可以在扩展的网站访问权限设置中，允许访问 chaoli.club。"
      )
    );
    return;
  }

  if (code === "LOGIN") {
    showStatus(ERROR_MESSAGES.LOGIN);
    const link = element("a", null, "前往登录超理论坛");
    link.href = `${ORIGIN}/`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const empty = element("p", "empty");
    empty.append(link);
    contentEl.replaceChildren(empty);
    return;
  }

  if (code in ERROR_MESSAGES) {
    showStatus(ERROR_MESSAGES[code]);
  } else if (String(code).startsWith("HTTP_")) {
    showStatus(`读取通知失败（${code.replace("HTTP_", "HTTP ")}）。`);
  } else {
    showStatus("读取通知失败，请确认已登录并可以访问 chaoli.club。");
  }
  contentEl.replaceChildren(element("p", "empty", "无法显示通知内容。"));
}

async function loadNotifications({ canPrompt = false } = {}) {
  showStatus("");
  contentEl.innerHTML = SKELETON;

  if (!(await ensureSiteAccess(canPrompt))) {
    showError("PERMISSION");
    return;
  }

  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: "FETCH_NOTIFICATIONS" });
  } catch {
    showError("FETCH_FAILED");
    return;
  }

  if (!result?.ok) {
    showError(result?.error || "FETCH_FAILED");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(result.body);
  } catch {
    // The JSON endpoint served something else, which means we are not signed in.
    showError("LOGIN");
    return;
  }

  const nodes = render(payload);
  if (nodes === null) {
    showError("FETCH_FAILED");
    return;
  }
  if (!nodes.length) {
    contentEl.replaceChildren(element("p", "empty", "暂时没有通知。"));
    return;
  }
  contentEl.replaceChildren(...nodes);
}

refreshBtn.addEventListener("click", () => loadNotifications({ canPrompt: true }));

loadNotifications();
