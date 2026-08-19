const ORIGIN = "https://chaoli.club";
const SITE_ORIGINS = ["*://chaoli.club/*", "*://*.chaoli.club/*"];

const TYPE_LABELS = {
  "notification-post": "关注更新",
  "notification-mention": "提及",
  "notification-groupChange": "用户组"
};

const SKELETON = `
  <div class="skeleton" aria-hidden="true">
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>
  </div>
`;

const LOGIN_PROMPT = `
  <p class="empty">
    <a href="${ORIGIN}/" target="_blank" rel="noopener noreferrer">前往登录超理论坛</a>
  </p>
`;

const statusEl = document.getElementById("status");
const contentEl = document.getElementById("content");
const refreshBtn = document.getElementById("refresh-btn");

function showStatus(message, type = "error") {
  statusEl.hidden = !message;
  statusEl.textContent = message || "";
  statusEl.classList.toggle("info", type === "info");
}

function absolutize(url) {
  const value = (url || "").trim();
  if (!value) return url;
  if (
    /^(https?:|data:|blob:|mailto:|chrome-extension:)/i.test(value) ||
    value.startsWith("#")
  ) {
    return value;
  }
  if (value.startsWith("//")) return `https:${value}`;
  try {
    return new URL(value, `${ORIGIN}/`).toString();
  } catch {
    return value;
  }
}

function sanitize(doc) {
  doc
    .querySelectorAll("script, iframe, object, embed, link, meta, style")
    .forEach((el) => el.remove());

  for (const el of doc.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
      } else if (name === "href" || name === "src") {
        if (/^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
        else el.setAttribute(attr.name, absolutize(attr.value));
      }
    }
  }

  doc.querySelectorAll("a").forEach((a) => {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  });
}

function hashHue(text) {
  let hash = 0;
  for (const char of text) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return hash;
}

function decorate(item) {
  item.querySelectorAll("i.fa").forEach((icon) => icon.remove());

  const typeClass = [...item.classList].find((name) => TYPE_LABELS[name]);
  const time = item.querySelector("small.time");
  if (typeClass && time && !time.querySelector(".type-tag")) {
    const tag = document.createElement("span");
    tag.className = "type-tag";
    tag.textContent = TYPE_LABELS[typeClass];
    time.prepend(tag);
  }

  const letterAvatar = item.querySelector("span.avatar");
  if (letterAvatar && !letterAvatar.style.background) {
    const hue = hashHue(letterAvatar.textContent.trim() || "超");
    letterAvatar.style.background = `hsl(${hue} 36% 46%)`;
  }
}

// Returns the nodes to display, or null when the response holds no notifications.
function render(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  sanitize(doc);

  const root =
    doc.querySelector(".notificationsList, ul.list, #body-content") || doc.body;
  const items = [...root.querySelectorAll("li")];
  if (!items.length) {
    return root.innerHTML.trim() ? [...root.childNodes] : null;
  }

  const list = document.createElement("ul");
  list.className = "notification-list";
  const nodes = [list];

  for (const item of items) {
    if (item.id === "viewAllNotifications") {
      const footer = document.createElement("div");
      footer.id = "viewAllNotifications";
      footer.append(...item.childNodes);
      nodes.push(footer);
      continue;
    }
    decorate(item);
    list.appendChild(item);
  }

  return nodes;
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
    contentEl.innerHTML = `
      <p class="empty">
        也可以点击扩展图标旁的「网站访问权限」，选择「在 chaoli.club 上」或「在所有网站上」。
      </p>
    `;
    return;
  }

  if (code === "LOGIN") {
    showStatus(ERROR_MESSAGES.LOGIN);
    contentEl.innerHTML = LOGIN_PROMPT;
    return;
  }

  if (code in ERROR_MESSAGES) {
    showStatus(ERROR_MESSAGES[code]);
  } else if (String(code).startsWith("HTTP_")) {
    showStatus(`读取通知失败（${code.replace("HTTP_", "HTTP ")}）。`);
  } else {
    showStatus("读取通知失败，请确认已登录并可以访问 chaoli.club。");
  }
  contentEl.innerHTML = `<p class="empty">无法显示通知内容。</p>`;
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

  const nodes = render(result.html || "");
  if (!nodes) {
    contentEl.innerHTML = `<p class="empty">暂时没有通知。</p>`;
    return;
  }
  contentEl.replaceChildren(...nodes);
}

refreshBtn.addEventListener("click", () => loadNotifications({ canPrompt: true }));

loadNotifications();
