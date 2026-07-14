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
for (const button of document.querySelectorAll("[data-copy-target]")) {
  button.addEventListener("click", async () => {
    const target = document.querySelector(`#${CSS.escape(button.dataset.copyTarget)}`);
    const text = target?.textContent?.trim() || "";
    if (!text) return;
    try {
      await copyText(text);
      showCopyStatus("已复制");
    } catch {
      showCopyStatus("复制失败，请手动选择命令");
    }
  });
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
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

function showCopyStatus(message) {
  const status = document.querySelector("#copyStatus");
  if (!status) return;
  clearTimeout(copyTimer);
  status.textContent = message;
  status.classList.add("is-visible");
  copyTimer = setTimeout(() => status.classList.remove("is-visible"), 2200);
}
