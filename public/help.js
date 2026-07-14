"use strict";

const monitorBasePath = window.location.pathname
  .replace(/\/help(?:\.html)?\/?$/, "")
  .replace(/\/$/, "");
const monitorUrl = `${window.location.origin}${monitorBasePath}`;
const monitorUrlNode = document.querySelector("#currentMonitorUrl");
if (monitorUrlNode) monitorUrlNode.textContent = monitorUrl;

const transportWarning = document.querySelector("#transportWarning");
const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
if (transportWarning && window.location.protocol !== "https:" && !isLocalHost) {
  transportWarning.hidden = false;
}

let copyTimer = null;
const copyButtonTimers = new WeakMap();
for (const button of document.querySelectorAll("[data-copy-target]")) {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copyTarget || "");
    const text = target?.textContent?.trim() || "";
    if (!text) return;
    try {
      await copyText(text);
      showCopyStatus("已复制");
      showButtonStatus(button, "已复制");
    } catch {
      showCopyStatus("复制失败，请手动选择命令");
      showButtonStatus(button, "请手动复制");
    }
  });
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // HTTP 或浏览器权限限制时继续使用兼容复制方式。
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy failed");
}

function showButtonStatus(button, message) {
  const originalLabel = button.dataset.originalLabel || button.textContent;
  button.dataset.originalLabel = originalLabel;
  button.textContent = message;
  clearTimeout(copyButtonTimers.get(button));
  copyButtonTimers.set(button, setTimeout(() => {
    button.textContent = originalLabel;
  }, 1800));
}

function showCopyStatus(message) {
  const status = document.querySelector("#copyStatus");
  if (!status) return;
  clearTimeout(copyTimer);
  status.textContent = message;
  status.classList.add("is-visible");
  copyTimer = setTimeout(() => status.classList.remove("is-visible"), 2200);
}
