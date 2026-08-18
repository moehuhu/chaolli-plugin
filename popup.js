const ORIGIN = "https://chaoli.club";
const SITE_ORIGINS = ["*://chaoli.club/*", "*://*.chaoli.club/*"];

const statusEl = document.getElementById("status");
const contentEl = document.getElementById("content");
const refreshBtn = document.getElementById("refresh-btn");

function showStatus(message, type = "error") {
  statusEl.hidden = !message;
  statusEl.textContent = message || "";
  statusEl.classList.toggle("info", type === "info");
}

function absolutize(url) {
  if (!url) return url;
  const value = url.trim();
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

function looksLikeLogin(html, finalUrl) {
  if (finalUrl && /user\/login|user\/join/i.test(finalUrl)) return true;
  return (
    /name=["']username["']/i.test(html) &&
    /name=["']password["']/i.test(html)
  );
}

function sanitizeAndPrepare(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc
    .querySelectorAll("script, iframe, object, embed, link, meta, style")
    .forEach((el) => el.remove());

  doc.querySelectorAll("*").forEach((el) => {
    [...el.attributes].forEach((attr) => {
      if (attr.name.toLowerCase().startsWith("on")) {
        el.removeAttribute(attr.name);
      }
    });
    const href = el.getAttribute("href");
    if (href && href.trim().toLowerCase().startsWith("javascript:")) {
      el.removeAttribute("href");
    }
  });

  doc.querySelectorAll("[href], [src]").forEach((el) => {
    for (const attr of ["href", "src"]) {
      if (el.hasAttribute(attr)) {
        el.setAttribute(attr, absolutize(el.getAttribute(attr)));
      }
    }
  });

  doc.querySelectorAll("a").forEach((a) => {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  });

  const notifications =
    doc.querySelector(".notificationsList, ul.list, #body-content") ||
    doc.body;
  return notifications.innerHTML.trim();
}

const TYPE_LABELS = {
  "notification-post": "关注更新",
  "notification-mention": "提及",
  "notification-groupChange": "用户组"
};

function hashHue(text) {
  let hash = 0;
  for (const char of text) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return hash;
}

function enhanceNotifications() {
  const items = [...contentEl.querySelectorAll("li")];
  if (!items.length) return;

  const listItems = items.filter((item) => item.id !== "viewAllNotifications");
  const viewAll = items.find((item) => item.id === "viewAllNotifications");
  const list = document.createElement("ul");
  list.className = "notification-list";

  listItems.forEach((item) => {
    item.querySelectorAll("i.fa").forEach((icon) => icon.remove());

    const typeClass = [...item.classList].find((name) =>
      name.startsWith("notification-")
    );
    const time = item.querySelector("small.time");
    if (time && typeClass && TYPE_LABELS[typeClass] && !time.querySelector(".type-tag")) {
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

    list.appendChild(item);
  });

  contentEl.replaceChildren(list);
  if (viewAll) {
    const footer = document.createElement("div");
    footer.id = "viewAllNotifications";
    footer.append(...viewAll.childNodes);
    contentEl.appendChild(footer);
  }
}

async function ensureSiteAccess() {
  try {
    const already = await chrome.permissions.contains({ origins: SITE_ORIGINS });
    if (already) return true;
    return await chrome.permissions.request({ origins: SITE_ORIGINS });
  } catch {
    return false;
  }
}

async function loadNotifications() {
  showStatus("");
  contentEl.innerHTML = `
    <div class="skeleton" aria-hidden="true">
      <div class="skeleton-row"></div>
      <div class="skeleton-row"></div>
      <div class="skeleton-row"></div>
    </div>
  `;

  try {
    const allowed = await ensureSiteAccess();
    if (!allowed) {
      throw new Error("PERMISSION");
    }

    const result = await chrome.runtime.sendMessage({
      type: "FETCH_NOTIFICATIONS"
    });

    if (!result) {
      throw new Error("FETCH_FAILED");
    }
    if (result.error === "NO_TAB") {
      throw new Error("NO_TAB");
    }
    if (result.error === "LOGIN") {
      throw new Error("LOGIN");
    }
    if (!result.ok) {
      throw new Error(result.status ? `HTTP_${result.status}` : result.error || "FETCH_FAILED");
    }

    const html = result.html || "";
    if (!html.trim() || looksLikeLogin(html, result.url)) {
      throw new Error("LOGIN");
    }

    if (/sorry, you have been blocked/i.test(html)) {
      throw new Error("BLOCKED");
    }

    const prepared = sanitizeAndPrepare(html);
    if (!prepared) {
      contentEl.innerHTML = `<p class="empty">暂时没有通知。</p>`;
      return;
    }

    contentEl.innerHTML = prepared;
    enhanceNotifications();
  } catch (error) {
    const code = error && error.message;
    if (code === "PERMISSION") {
      showStatus("需要允许扩展访问 chaoli.club，才能读取登录 cookie。");
      contentEl.innerHTML = `
        <p class="empty">
          请点击扩展图标旁的「网站访问权限」，选择「在 chaoli.club 上」或「在所有网站上」。
        </p>
      `;
      return;
    }
    if (code === "NO_TAB") {
      showStatus("无法读取通知。请先登录一次 chaoli.club，之后关闭标签页也可以继续查看。", "info");
      contentEl.innerHTML = `
        <p class="empty">
          <a href="https://chaoli.club/" target="_blank" rel="noopener noreferrer">打开超理论坛</a>
        </p>
      `;
      return;
    }
    if (code === "LOGIN") {
      showStatus("未检测到登录状态。请先在浏览器中登录 chaoli.club，登录后关闭标签页也可以继续查看通知。");
      contentEl.innerHTML = `
        <p class="empty">
          <a href="https://chaoli.club/" target="_blank" rel="noopener noreferrer">前往登录超理论坛</a>
        </p>
      `;
      return;
    }
    if (code === "BLOCKED") {
      showStatus("请求被 Cloudflare 拦截。请先在普通标签页打开 chaoli.club，完成验证后再刷新。");
    } else if (String(code).startsWith("HTTP_")) {
      showStatus(`读取通知失败（${code.replace("HTTP_", "HTTP ")}）。`);
    } else {
      showStatus("读取通知失败，请确认已登录并可以访问 chaoli.club。");
    }
    contentEl.innerHTML = `<p class="empty">无法显示通知内容。</p>`;
  }
}

refreshBtn.addEventListener("click", () => {
  loadNotifications();
});

loadNotifications();
