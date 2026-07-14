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

const commandNode = document.querySelector("#agentCommand code");
if (commandNode) {
  commandNode.textContent = `node device-agent.js --url "${monitorUrl}" --user "数据用户ID" --device "设备ID" --token "一次性令牌" --once`;
}

let copyTimer = null;
for (const button of document.querySelectorAll("[data-copy-target]")) {
  button.addEventListener("click", async () => {
    const target = document.querySelector(`#${CSS.escape(button.dataset.copyTarget)}`);
    const text = target?.textContent?.trim() || "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showCopyStatus("已复制");
    } catch {
      showCopyStatus("复制失败，请手动选择命令");
    }
  });
}

function showCopyStatus(message) {
  const status = document.querySelector("#copyStatus");
  if (!status) return;
  clearTimeout(copyTimer);
  status.textContent = message;
  status.classList.add("is-visible");
  copyTimer = setTimeout(() => status.classList.remove("is-visible"), 2200);
}
