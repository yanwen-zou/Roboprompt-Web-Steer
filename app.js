const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function normalizeServerUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("请输入服务地址，例如 http://127.0.0.1:8765（不含路径）");
  }
  return url.origin;
}
let savedServerUrl;
try { savedServerUrl = localStorage.getItem("webSteerServerUrl"); } catch (_) { /* storage may be disabled */ }
const defaultServerUrl = location.hostname.endsWith(".github.io") ? "http://127.0.0.1:8765" : location.origin;
let serverUrl;
try { serverUrl = normalizeServerUrl(new URLSearchParams(location.search).get("server") || (location.hostname.endsWith(".github.io") ? savedServerUrl : null) || defaultServerUrl); }
catch (_) { serverUrl = defaultServerUrl; }
const apiUrl = (path) => serverUrl + path;
const apiFetch = (path, options = {}) => fetch(apiUrl(path), { signal: AbortSignal.timeout(5000), ...options });
$("#serverUrl").value = serverUrl;
$("#connectionForm").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const nextUrl = normalizeServerUrl($("#serverUrl").value.trim());
    try { localStorage.setItem("webSteerServerUrl", nextUrl); } catch (_) { /* URL remains usable */ }
    const page = new URL(location.href);
    page.searchParams.set("server", nextUrl);
    location.assign(page.href);
  } catch (error) { $("#serverStatus").textContent = error.message; }
});

const state = {
  connected: false,
  sending: false,
  tool: "trajectory",
  ops: [],
  drawing: null,
  global: [0, 0, 0],
  effect: "long_term",
  source: "evo",
  observationSequence: 0,
  imageNatural: { width: 0, height: 0 },
};

const stage = $("#stage");
const image = $("#baseImage");
const canvas = $("#promptCanvas");
const ctx = canvas.getContext("2d");
let toastTimer;

function resizeCanvas() {
  const rect = stage.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  render();
}

function imageRect() {
  const box = stage.getBoundingClientRect();
  if (!state.imageNatural.width) return { x: 0, y: 0, width: box.width, height: box.height };
  const scale = Math.min(box.width / state.imageNatural.width, box.height / state.imageNatural.height);
  const width = state.imageNatural.width * scale;
  const height = state.imageNatural.height * scale;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

function pointerPoint(event) {
  const box = stage.getBoundingClientRect();
  const view = imageRect();
  const x = Math.max(view.x, Math.min(event.clientX - box.left, view.x + view.width));
  const y = Math.max(view.y, Math.min(event.clientY - box.top, view.y + view.height));
  return { x: (x - view.x) / view.width, y: (y - view.y) / view.height };
}

// Match eval_ui/render_utils.py and scripts/utils/draw_overlay.py:
// white -> RGB(255, 80, 0) trajectory, radius-6 orange point with radius-8 white border.
// Use the desktop UI's nominal 520px image height as a stable drawing coordinate
// system, so phone/desktop previews and exported model prompts keep the same size.
const PROMPT_REFERENCE_HEIGHT = 520;
function drawPromptOps(target, ops, width, height) {
  const scale = height / PROMPT_REFERENCE_HEIGHT;
  const referenceWidth = width / scale;
  const position = (point) => ({
    x: Math.max(0, Math.min(referenceWidth - 1, point.x * referenceWidth)),
    y: Math.max(0, Math.min(PROMPT_REFERENCE_HEIGHT - 1, point.y * PROMPT_REFERENCE_HEIGHT)),
  });
  const disk = (point, radius, color) => {
    target.fillStyle = color;
    target.beginPath(); target.arc(point.x, point.y, radius, 0, Math.PI * 2); target.fill();
  };
  target.save();
  target.scale(scale, scale);
  target.lineCap = "round"; target.lineJoin = "round";
  // The Python renderer stamps radius-1 disks along the line.
  target.lineWidth = 2;
  for (const op of ops) {
    if (op.type === "point" || op.points.length === 1) {
      const point = position(op.type === "point" ? op.point : op.points[0]);
      disk(point, 8, "#ffffff"); disk(point, 6, "#ff5000");
    } else {
      for (let i = 1; i < op.points.length; i++) {
        // The local renderer colors each segment by its index, not arc length.
        const t = (i - 1) / Math.max(op.points.length - 2, 1);
        const color = `rgb(255, ${Math.floor(255 * (1 - t) + 80 * t)}, ${Math.floor(255 * (1 - t))})`;
        const start = position(op.points[i - 1]), end = position(op.points[i]);
        target.strokeStyle = color;
        target.beginPath(); target.moveTo(start.x, start.y); target.lineTo(end.x, end.y); target.stroke();
        disk(start, 1, color); disk(end, 1, color);
      }
    }
  }
  target.restore();
}

function render() {
  const box = stage.getBoundingClientRect();
  ctx.clearRect(0, 0, box.width, box.height);
  const view = imageRect();
  ctx.save();
  ctx.beginPath(); ctx.rect(view.x, view.y, view.width, view.height); ctx.clip();
  ctx.translate(view.x, view.y);
  drawPromptOps(ctx, [...state.ops, ...(state.drawing ? [state.drawing] : [])], view.width, view.height);
  ctx.restore();
  updateSummary();
}

function beginDraw(event) {
  if (!state.imageNatural.width || state.tool === "global") return;
  canvas.setPointerCapture(event.pointerId);
  const point = pointerPoint(event);
  state.drawing = state.tool === "point" ? { type: "point", point } : { type: "trajectory", points: [point] };
  render();
}

function continueDraw(event) {
  if (!state.drawing || state.drawing.type !== "trajectory") return;
  const point = pointerPoint(event);
  const last = state.drawing.points.at(-1);
  if (Math.hypot(point.x - last.x, point.y - last.y) > .004) state.drawing.points.push(point);
  render();
}

function endDraw(event) {
  if (!state.drawing) return;
  if (state.drawing.type === "trajectory") {
    continueDraw(event);
    if (state.drawing.points.length < 2) state.drawing = { type: "point", point: state.drawing.points[0] };
  }
  state.ops.push(state.drawing); state.drawing = null; render(); updateButtons();
}

function updateSummary() {
  const lastTrajectory = [...state.ops].reverse().find((op) => op.type === "trajectory");
  let drag = [0, 0];
  if (lastTrajectory) {
    const a = lastTrajectory.points[0], b = lastTrajectory.points.at(-1);
    drag = [b.x - a.x, b.y - a.y];
  }
  $("#visualSummary").textContent = state.ops.length ? `${state.ops.length} 个标注` : "未设置";
  $("#dragSummary").textContent = `[${drag.map((v) => v.toFixed(2)).join(", ")}]`;
  $("#globalSummary").textContent = `[${state.global.map((v) => v.toFixed(2)).join(", ")}]`;
}

function updateButtons() {
  const online = state.connected && state.imageNatural.width > 0 && !state.sending;
  $("#undoButton").disabled = !state.ops.length;
  $("#clearButton").disabled = !state.ops.length;
  $("#sendButton").disabled = !online;
}

function setTool(tool) {
  state.tool = tool;
  $$(".tool").forEach((button) => {
    const active = button.dataset.tool === tool;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active);
  });
  stage.style.cursor = tool === "global" ? "default" : "crosshair";
  $("#drawHint").textContent = tool === "point" ? "单击画面以设置目标点" : tool === "global" ? "使用右侧滑杆设置全局动作" : "按住并拖动以绘制轨迹";
}

let refreshing = false;
async function refreshState() {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await apiFetch("/api/state");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    $("#serverStatus").textContent = data.connected ? "服务已连接，机器人在线" : "服务已连接，等待机器人客户端";
    const acknowledged = Number(data.acknowledged_prompt_sequence || 0);
    const submitted = Number(data.prompt_sequence || 0);
    $("#deliverySummary").textContent = submitted === 0 ? "等待 Prompt" : acknowledged >= submitted ? `#${submitted} 已用于推理` : `#${submitted} 等待 Client`;
    if (!data.connected) return setOffline();
    state.connected = true;
    const sequence = data.observation.sequence;
    if (sequence !== state.observationSequence) {
      state.observationSequence = sequence;
      const stamp = `?v=${sequence}`;
      image.src = apiUrl(`/api/observation/base${stamp}`);
      if (data.image_keys.includes("wrist")) {
        $("#wristImage").src = apiUrl(`/api/observation/wrist${stamp}`);
        $(".wrist-view").classList.add("live");
        $("#wristState").textContent = "LIVE";
      } else {
        $(".wrist-view").classList.remove("live");
        $("#wristState").textContent = "OFFLINE";
      }
      $("#frameId").textContent = data.observation.frame_id ?? String(sequence).padStart(6, "0");
      const received = data.observation.received_at * 1000;
      $("#latency").textContent = `${Math.round(Math.max(0, Date.now() - received))} ms`;
    }
    $("#connectionDot").classList.add("live");
    $("#connectionText").textContent = "CLIENT CONNECTED";
    $(".camera-label span").classList.add("live");
    updateButtons();
  } catch (_) {
    setOffline();
    $("#serverStatus").textContent = "无法连接：检查服务地址、允许的网站来源及浏览器本地网络权限";
  } finally { refreshing = false; }
}

function setOffline() {
  state.connected = false;
  $("#connectionDot").classList.remove("live");
  $("#connectionText").textContent = "WAITING FOR CLIENT";
  $("#sendButton").disabled = true;
}

function exportPromptImage() {
  const output = document.createElement("canvas");
  output.width = state.imageNatural.width; output.height = state.imageNatural.height;
  const out = output.getContext("2d");
  out.drawImage(image, 0, 0, output.width, output.height);
  drawPromptOps(out, state.ops, output.width, output.height);
  return output.toDataURL("image/png");
}

function buildPayload() {
  const trajectories = state.ops.filter((op) => op.type === "trajectory");
  const last = trajectories.at(-1);
  const drag = last ? [last.points.at(-1).x - last.points[0].x, last.points.at(-1).y - last.points[0].y] : [0, 0];
  const visual = state.ops.length > 0;
  const global = state.global.some((v) => Math.abs(v) > 1e-6);
  const mode = visual && global ? "combined" : global ? "global" : last ? "trajectory" : "point";
  const width = state.imageNatural.width, height = state.imageNatural.height;
  const drawOps = state.ops.map((op) => op.type === "point"
    ? { type: "point", point_hw: [op.point.y * height, op.point.x * width], point_xy_normalized: [op.point.x, op.point.y] }
    : { type: "trajectory", points_hw: op.points.map((p) => [p.y * height, p.x * width]), points_xy_normalized: op.points.map((p) => [p.x, p.y]) });
  return {
    mode, observation_sequence: state.observationSequence,
    prompt_image: visual ? exportPromptImage() : null,
    draw_ops: drawOps, prompt_2d_drag: drag, prompt_global_motion: state.global,
    prompt_effect_mode: state.effect, prompt_phase1_source: state.source,
    phase2_steps: Number($("#stepsInput").value),
  };
}

async function sendPrompt() {
  if ($("#sendButton").disabled) return;
  state.sending = true;
  $("#sendButton").disabled = true;
  try {
    const response = await apiFetch("/api/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildPayload()) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "发送失败");
    showToast(`Prompt #${data.sequence} 已发送`);
  } catch (error) { showToast(error.message, true); }
  finally { state.sending = false; updateButtons(); }
}

function showToast(message, error = false) {
  const toast = $("#toast"); toast.textContent = message; toast.classList.toggle("error", error); toast.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

canvas.addEventListener("pointerdown", beginDraw);
canvas.addEventListener("pointermove", continueDraw);
canvas.addEventListener("pointerup", endDraw);
canvas.addEventListener("pointercancel", () => { state.drawing = null; render(); });
image.addEventListener("load", () => {
  state.imageNatural = { width: image.naturalWidth, height: image.naturalHeight };
  stage.dataset.empty = "false"; resizeCanvas(); updateButtons();
});
$$(".tool").forEach((button) => button.addEventListener("click", () => setTool(button.dataset.tool)));
$("#undoButton").addEventListener("click", () => { state.ops.pop(); render(); updateButtons(); });
$("#clearButton").addEventListener("click", () => { state.ops = []; render(); updateButtons(); });
$("#zeroAxes").addEventListener("click", () => $$(".axis-control input").forEach((input) => { input.value = 0; input.dispatchEvent(new Event("input")); }));
$$(".axis-control input").forEach((input, axis) => input.addEventListener("input", () => {
  state.global[axis] = Number(input.value); input.closest(".axis-control").querySelector("output").value = `${state.global[axis] >= 0 ? "+" : ""}${state.global[axis].toFixed(2)}`; updateSummary();
}));
$$(".segmented button").forEach((button) => button.addEventListener("click", () => {
  const group = button.closest(".segmented"); group.querySelectorAll("button").forEach((item) => item.classList.remove("selected")); button.classList.add("selected");
  if (group.dataset.setting === "effect") state.effect = button.dataset.value; else state.source = button.dataset.value;
}));
$("#stepsInput").addEventListener("input", (event) => { $("#stepsOutput").value = Number(event.target.value).toFixed(1); });
$("#sendButton").addEventListener("click", sendPrompt);
window.addEventListener("resize", resizeCanvas);
window.addEventListener("keydown", (event) => {
  if (event.target.closest("input, textarea, select, form")) return;
  if (event.key === "Enter" && !$("#sendButton").disabled) sendPrompt();
  if (event.key === "0") $("#zeroAxes").click();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); $("#undoButton").click(); }
});
setInterval(() => { $("#clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false }); }, 1000);
// Poll across origins; the same-origin UI can additionally use SSE for faster updates.
if (serverUrl === location.origin) {
  try { const events = new EventSource(apiUrl("/api/events")); events.onmessage = refreshState; } catch (_) { /* polling remains active */ }
}
setInterval(refreshState, 1000);
refreshState(); resizeCanvas();
