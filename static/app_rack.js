/* ============================================================
   模块:机柜布设(工具箱里的一个标签页,纯前端,数据存在浏览器本地)
   功能思路参考 bruce609685-collab/RackDraw(Apache-2.0),本模块为 JS 独立重新实现。
   - 19 英寸机柜按 U 位显示(1U 在最底部,和实物一致)
   - 从左侧设备目录拖拽(或点一下)放进机柜;已放的设备可拖动换位
   - 同一 U 内可多设备横向混排(全宽 / 1/2 宽 / 1/3 宽)
   - 自定义设备可存入"我的设备";导出 PNG 布局图、Markdown 布设表
   ============================================================ */
const RACK_KEY = "wdmp_rack_v1";
const RACK_UH = 26;      // 每 U 的显示高度(px)
const RACK_COLS = 6;     // 一 U 横向切成 6 份:全宽=6,1/2 宽=3,1/3 宽=2
const RACK_UNITS_OPTS = [6, 9, 12, 18, 22, 27, 32, 37, 42, 47];
const RACK_WIDTHS = [{ w: 6, label: "全宽" }, { w: 3, label: "1/2宽" }, { w: 2, label: "1/3宽" }];
const RACK_CAT_COLOR = {
  "网络": "#0f9bb0", "配线": "#5b6779", "录像存储": "#13315c",
  "服务器": "#2b6cb0", "电源": "#d98a1f", "其它": "#7a8699",
};
const RACK_PRESETS = [
  { cat: "网络", name: "24口交换机", u: 1, w: 6 },
  { cat: "网络", name: "48口交换机", u: 1, w: 6 },
  { cat: "网络", name: "核心交换机", u: 2, w: 6 },
  { cat: "网络", name: "路由器", u: 1, w: 6 },
  { cat: "网络", name: "防火墙", u: 1, w: 6 },
  { cat: "网络", name: "光纤收发器", u: 1, w: 2 },
  { cat: "网络", name: "无线AC控制器", u: 1, w: 6 },
  { cat: "配线", name: "24口网络配线架", u: 1, w: 6 },
  { cat: "配线", name: "光纤配线架(ODF)", u: 1, w: 6 },
  { cat: "配线", name: "理线架", u: 1, w: 6 },
  { cat: "配线", name: "盲板", u: 1, w: 6 },
  { cat: "录像存储", name: "NVR 1U", u: 1, w: 6 },
  { cat: "录像存储", name: "NVR 2U", u: 2, w: 6 },
  { cat: "录像存储", name: "磁盘阵列 4U", u: 4, w: 6 },
  { cat: "录像存储", name: "解码器", u: 1, w: 6 },
  { cat: "服务器", name: "1U 服务器", u: 1, w: 6 },
  { cat: "服务器", name: "2U 服务器", u: 2, w: 6 },
  { cat: "服务器", name: "4U 服务器", u: 4, w: 6 },
  { cat: "服务器", name: "KVM/键盘显示器", u: 1, w: 6 },
  { cat: "电源", name: "PDU 电源排插", u: 1, w: 6 },
  { cat: "电源", name: "UPS 2U", u: 2, w: 6 },
  { cat: "电源", name: "UPS 3U", u: 3, w: 6 },
  { cat: "电源", name: "风扇单元", u: 1, w: 6 },
  { cat: "其它", name: "门禁控制器", u: 1, w: 3 },
  { cat: "其它", name: "广播功放", u: 2, w: 6 },
];

let RACK = { name: "机柜1", units: 42, items: [], mine: [], uid: 0 };
let RACK_SEL = 0;
let RACK_DRAG = null;

function rackLoad() {
  try {
    const raw = localStorage.getItem(RACK_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.items)) RACK = Object.assign({ name: "机柜1", units: 42, items: [], mine: [], uid: 0 }, d);
    }
  } catch (e) {}
  RACK.uid = Math.max(RACK.uid || 0, ...RACK.items.map((i) => i.id), 0);
}
function rackSave() {
  try { localStorage.setItem(RACK_KEY, JSON.stringify(RACK)); } catch (e) {}
}

function rackColor(cat) { return RACK_CAT_COLOR[cat] || RACK_CAT_COLOR["其它"]; }
function rackWidthLabel(w) { return (RACK_WIDTHS.find((x) => x.w === w) || RACK_WIDTHS[0]).label; }

// 判断设备 it 放到 (start, col) 是否越界或和别的设备重叠
function rackFits(it, start, col, ignoreId) {
  if (start < 1 || start + it.u - 1 > RACK.units || col < 0 || col + it.w > RACK_COLS) return false;
  return !RACK.items.some((o) => o.id !== ignoreId
    && o.start <= start + it.u - 1 && start <= o.start + o.u - 1
    && o.col < col + it.w && col < o.col + o.w);
}
// 自上而下找第一个放得下的位置
function rackFindFree(u, w) {
  for (let s = RACK.units - u + 1; s >= 1; s--) {
    for (let c = 0; c + w <= RACK_COLS; c += w) {
      if (rackFits({ u, w }, s, c, 0)) return { start: s, col: c };
    }
  }
  return null;
}
function rackUsedU() {
  const used = new Set();
  RACK.items.forEach((o) => { for (let k = 0; k < o.u; k++) used.add(o.start + k); });
  return used.size;
}

function renderRackTool() {
  rackLoad();
  RACK_SEL = 0;
  const body = document.getElementById("toolboxBody");
  const cats = [...new Set(RACK_PRESETS.map((p) => p.cat))];
  body.innerHTML = `
    <div class="rack-layout">
      <div class="card panel rack-catalog">
        <div class="rack-h">设备目录 <span class="rack-tip">拖到机柜里,或点一下自动放入</span></div>
        ${cats.map((c) => `
          <div class="rack-cat"><span class="rack-dot" style="background:${rackColor(c)}"></span>${c}</div>
          ${RACK_PRESETS.map((p, i) => p.cat === c ? rackCatalogItem("p", i, p) : "").join("")}
        `).join("")}
        <div class="rack-cat"><span class="rack-dot" style="background:var(--ink)"></span>我的设备</div>
        <div id="rackMine"></div>
        <div class="rack-custom">
          <input id="rcName" placeholder="自定义设备名称">
          <div class="rack-row">
            <input id="rcU" type="number" inputmode="numeric" min="1" max="20" value="1" title="高度(U)">
            <select id="rcW">${RACK_WIDTHS.map((x) => `<option value="${x.w}">${x.label}</option>`).join("")}</select>
            <select id="rcCat">${Object.keys(RACK_CAT_COLOR).map((c) => `<option>${c}</option>`).join("")}</select>
          </div>
          <button class="btn btn-outline btn-sm" onclick="rackAddMine()">保存到"我的设备"</button>
        </div>
      </div>
      <div class="rack-main">
        <div class="toolbar" style="flex-wrap:wrap;">
          <input id="rackName" value="${escapeHTML(RACK.name)}" style="width:140px" title="机柜名称">
          <select id="rackUnits" title="机柜高度">${RACK_UNITS_OPTS.map((n) => `<option value="${n}" ${n === RACK.units ? "selected" : ""}>${n}U</option>`).join("")}</select>
          <div class="fill"></div>
          <button class="btn btn-outline btn-sm" onclick="rackExportPNG()">导出PNG</button>
          <button class="btn btn-outline btn-sm" onclick="rackExportMD(false)">导出Markdown</button>
          <button class="btn btn-outline btn-sm" onclick="rackExportMD(true)">复制Markdown</button>
          <button class="btn btn-danger btn-sm" onclick="rackClear()">清空</button>
        </div>
        <div id="rackStats" class="stat-row"></div>
        <div id="rackSel"></div>
        <div class="rack-frame"><div class="rack-wrap" id="rackWrap"></div></div>
        <p class="rack-tip" style="margin-top:8px">数据只保存在当前浏览器里(不上传服务器)。点设备可编辑/微调位置,Delete 键删除选中设备。</p>
      </div>
    </div>
  `;
  document.getElementById("rackName").addEventListener("change", (e) => {
    RACK.name = e.target.value.trim() || "机柜1"; rackSave();
  });
  document.getElementById("rackUnits").addEventListener("change", (e) => {
    const n = parseInt(e.target.value);
    const top = Math.max(0, ...RACK.items.map((o) => o.start + o.u - 1));
    if (n < top) { toast(`已有设备占到第 ${top}U,不能缩小到 ${n}U`, "err"); e.target.value = RACK.units; return; }
    RACK.units = n; rackSave(); rackPaint();
  });
  rackPaint();
}

function rackCatalogItem(kind, idx, p) {
  return `<div class="rack-cat-item" draggable="true" style="border-left-color:${rackColor(p.cat)}"
      ondragstart="rackDragStart(event,'${kind}',${idx})" ondragend="rackDragEnd()" onclick="rackQuickAdd('${kind}',${idx})">
      <span>${escapeHTML(p.name)}</span><span class="rack-meta">${p.u}U · ${rackWidthLabel(p.w)}</span>
      ${kind === "m" ? `<button class="rack-x" title="从我的设备删除" onclick="event.stopPropagation();rackDelMine(${idx})">&times;</button>` : ""}
    </div>`;
}

function rackPaintMine() {
  const el = document.getElementById("rackMine");
  if (!el) return;
  el.innerHTML = RACK.mine.length
    ? RACK.mine.map((p, i) => rackCatalogItem("m", i, p)).join("")
    : `<div class="rack-tip" style="padding:2px 0 6px">暂无,在下方添加</div>`;
}

function rackPaint() {
  rackPaintMine();
  const used = rackUsedU();
  document.getElementById("rackStats").innerHTML = `
    <div class="stat-box"><div class="v">${RACK.items.length}</div><div class="l">设备数量</div></div>
    <div class="stat-box"><div class="v">${used}/${RACK.units}U</div><div class="l">已占用</div></div>
    <div class="stat-box"><div class="v">${Math.round(used / RACK.units * 100)}%</div><div class="l">U位利用率</div></div>`;

  const labels = [];
  for (let u = RACK.units; u >= 1; u--) labels.push(`<div style="height:${RACK_UH}px">${u}</div>`);
  document.getElementById("rackWrap").innerHTML = `
    <div class="rack-nums">${labels.join("")}</div>
    <div class="rack-body" id="rackBody" style="height:${RACK.units * RACK_UH}px">
      ${RACK.items.map((o) => `
        <div class="rack-item ${o.id === RACK_SEL ? "sel" : ""}" draggable="true" data-id="${o.id}"
          style="left:${o.col / RACK_COLS * 100}%;width:${o.w / RACK_COLS * 100}%;top:${(RACK.units - (o.start + o.u - 1)) * RACK_UH}px;height:${o.u * RACK_UH}px;background:${rackColor(o.cat)}"
          title="${escapeHTML(o.name)}(${o.start}${o.u > 1 ? "-" + (o.start + o.u - 1) : ""}U)">
          <span>${escapeHTML(o.name)}</span></div>`).join("")}
      <div class="rack-ghost" id="rackGhost" style="display:none"></div>
    </div>
    <div class="rack-nums">${labels.join("")}</div>`;

  const bodyEl = document.getElementById("rackBody");
  bodyEl.querySelectorAll(".rack-item").forEach((el) => {
    const id = parseInt(el.dataset.id);
    el.addEventListener("click", () => { RACK_SEL = id; rackPaint(); });
    el.addEventListener("dragstart", (e) => {
      const o = RACK.items.find((x) => x.id === id);
      RACK_DRAG = { id, u: o.u, w: o.w };
      e.dataTransfer.setData("text/plain", "move");
      e.dataTransfer.effectAllowed = "move";
    });
    el.addEventListener("dragend", rackDragEnd);
  });
  bodyEl.addEventListener("dragover", (e) => {
    if (!RACK_DRAG) return;
    e.preventDefault();
    const pos = rackCalcPos(e, RACK_DRAG);
    const ok = rackFits(RACK_DRAG, pos.start, pos.col, RACK_DRAG.id || 0);
    const g = document.getElementById("rackGhost");
    g.style.display = "block";
    g.style.left = pos.col / RACK_COLS * 100 + "%";
    g.style.width = RACK_DRAG.w / RACK_COLS * 100 + "%";
    g.style.top = (RACK.units - (pos.start + RACK_DRAG.u - 1)) * RACK_UH + "px";
    g.style.height = RACK_DRAG.u * RACK_UH + "px";
    g.className = "rack-ghost " + (ok ? "ok" : "bad");
  });
  bodyEl.addEventListener("dragleave", (e) => {
    if (e.target === bodyEl) document.getElementById("rackGhost").style.display = "none";
  });
  bodyEl.addEventListener("drop", (e) => {
    if (!RACK_DRAG) return;
    e.preventDefault();
    const d = RACK_DRAG;
    const pos = rackCalcPos(e, d);
    rackDragEnd();
    if (!rackFits(d, pos.start, pos.col, d.id || 0)) { toast("该位置已被占用或超出机柜", "err"); return; }
    if (d.id) {
      const o = RACK.items.find((x) => x.id === d.id);
      o.start = pos.start; o.col = pos.col;
    } else {
      const it = { id: ++RACK.uid, name: d.name, cat: d.cat, u: d.u, w: d.w, start: pos.start, col: pos.col, note: "" };
      RACK.items.push(it); RACK_SEL = it.id;
    }
    rackSave(); rackPaint();
  });
  rackPaintSel();
}

function rackCalcPos(e, d) {
  const r = document.getElementById("rackBody").getBoundingClientRect();
  const row = Math.floor((e.clientY - r.top) / RACK_UH);
  let start = RACK.units - row - d.u + 1;          // 鼠标所在行作为设备最上面一格
  start = Math.max(1, Math.min(RACK.units - d.u + 1, start));
  let col = Math.floor((e.clientX - r.left) / r.width * RACK_COLS / d.w) * d.w;
  col = Math.max(0, Math.min(RACK_COLS - d.w, col));
  return { start, col };
}

function rackDragStart(e, kind, idx) {
  const p = kind === "p" ? RACK_PRESETS[idx] : RACK.mine[idx];
  RACK_DRAG = { id: 0, name: p.name, cat: p.cat, u: p.u, w: p.w };
  e.dataTransfer.setData("text/plain", p.name);
  e.dataTransfer.effectAllowed = "copy";
}
function rackDragEnd() {
  RACK_DRAG = null;
  const g = document.getElementById("rackGhost");
  if (g) g.style.display = "none";
}

function rackQuickAdd(kind, idx) {
  const p = kind === "p" ? RACK_PRESETS[idx] : RACK.mine[idx];
  const pos = rackFindFree(p.u, p.w);
  if (!pos) { toast("机柜里没有足够的空位了", "err"); return; }
  const it = { id: ++RACK.uid, name: p.name, cat: p.cat, u: p.u, w: p.w, start: pos.start, col: pos.col, note: "" };
  RACK.items.push(it); RACK_SEL = it.id;
  rackSave(); rackPaint();
}

function rackAddMine() {
  const name = document.getElementById("rcName").value.trim();
  const u = parseInt(document.getElementById("rcU").value) || 0;
  if (!name) { toast("请填写设备名称", "err"); return; }
  if (u < 1 || u > 20) { toast("高度应在 1~20U", "err"); return; }
  RACK.mine.push({ name, u, w: parseInt(document.getElementById("rcW").value), cat: document.getElementById("rcCat").value });
  document.getElementById("rcName").value = "";
  rackSave(); rackPaintMine();
  toast("已保存到我的设备");
}
function rackDelMine(i) { RACK.mine.splice(i, 1); rackSave(); rackPaintMine(); }

function rackPaintSel() {
  const el = document.getElementById("rackSel");
  const o = RACK.items.find((x) => x.id === RACK_SEL);
  if (!o) { el.innerHTML = ""; return; }
  el.innerHTML = `
    <div class="card panel rack-selpanel">
      <input id="rsName" value="${escapeHTML(o.name)}" style="width:170px" title="设备名称">
      <label>高度 <input id="rsU" type="number" inputmode="numeric" min="1" max="20" value="${o.u}" style="width:60px">U</label>
      <select id="rsW">${RACK_WIDTHS.map((x) => `<option value="${x.w}" ${x.w === o.w ? "selected" : ""}>${x.label}</option>`).join("")}</select>
      <input id="rsNote" value="${escapeHTML(o.note || "")}" placeholder="备注/IP/编号" style="width:150px">
      <span class="rack-tip">位置 ${o.start}${o.u > 1 ? "-" + (o.start + o.u - 1) : ""}U</span>
      <button class="btn btn-outline btn-sm" onclick="rackNudge(1,0)" title="上移1U">&uarr;</button>
      <button class="btn btn-outline btn-sm" onclick="rackNudge(-1,0)" title="下移1U">&darr;</button>
      <button class="btn btn-outline btn-sm" onclick="rackNudge(0,-1)" title="左移">&larr;</button>
      <button class="btn btn-outline btn-sm" onclick="rackNudge(0,1)" title="右移">&rarr;</button>
      <button class="btn btn-danger btn-sm" onclick="rackDelSel()">删除</button>
    </div>`;
  const apply = () => {
    const u = parseInt(document.getElementById("rsU").value) || 0;
    const w = parseInt(document.getElementById("rsW").value);
    const t = { u, w };
    if (u < 1 || u > 20) { toast("高度应在 1~20U", "err"); rackPaint(); return; }
    let col = Math.floor(o.col / w) * w;                    // 宽度变化后对齐到新的格子
    if (u !== o.u || w !== o.w) {
      if (!rackFits(t, o.start, col, o.id)) { toast("改动后和其它设备冲突或超出机柜", "err"); rackPaint(); return; }
    }
    o.name = document.getElementById("rsName").value.trim() || o.name;
    o.note = document.getElementById("rsNote").value.trim();
    o.u = u; o.w = w; o.col = col;
    rackSave(); rackPaint();
  };
  ["rsName", "rsU", "rsW", "rsNote"].forEach((id) => document.getElementById(id).addEventListener("change", apply));
}

function rackNudge(dStart, dCol) {
  const o = RACK.items.find((x) => x.id === RACK_SEL);
  if (!o) return;
  const ns = o.start + dStart, nc = o.col + dCol * o.w;
  if (!rackFits(o, ns, nc, o.id)) { toast("那边放不下", "err"); return; }
  o.start = ns; o.col = nc; rackSave(); rackPaint();
}
function rackDelSel() {
  RACK.items = RACK.items.filter((x) => x.id !== RACK_SEL);
  RACK_SEL = 0; rackSave(); rackPaint();
}
function rackClear() {
  if (!RACK.items.length) return;
  if (!confirm("确认清空当前机柜里的所有设备?(「我的设备」不受影响)")) return;
  RACK.items = []; RACK_SEL = 0; rackSave(); rackPaint();
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Delete" || CUR_VIEW !== "toolbox" || TOOLBOX_TAB !== "rack" || !RACK_SEL) return;
  if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
  rackDelSel();
});

/* ---------------- 导出 ---------------- */
function rackDownload(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function rackFileName() { return (RACK.name || "机柜").replace(/[\\/:*?"<>|]/g, "_"); }

function rackExportMD(copyOnly) {
  const list = RACK.items.slice().sort((a, b) => (b.start + b.u) - (a.start + a.u) || a.col - b.col);
  const esc = (s) => String(s || "").replace(/\|/g, "\\|");
  let md = `# ${RACK.name}(${RACK.units}U)\n\n已占用 ${rackUsedU()}/${RACK.units}U,设备 ${list.length} 台\n\n| U位 | 设备 | 高度 | 宽度 | 备注 |\n|---|---|---|---|---|\n`;
  md += list.map((o) => `| ${o.start}${o.u > 1 ? "-" + (o.start + o.u - 1) : ""}U | ${esc(o.name)} | ${o.u}U | ${rackWidthLabel(o.w)} | ${esc(o.note)} |`).join("\n") + "\n";
  if (copyOnly) {
    if (navigator.clipboard) navigator.clipboard.writeText(md).then(() => toast("Markdown 已复制"), () => toast("复制失败,请改用导出", "err"));
    else toast("当前环境不支持复制,请改用导出", "err");
    return;
  }
  rackDownload(new Blob([md], { type: "text/markdown;charset=utf-8" }), rackFileName() + ".md");
}

function rackExportPNG() {
  const S = 2, UH = RACK_UH * S, X0 = 56 * S, RW = 460 * S, TOP = 56 * S;
  const cv = document.createElement("canvas");
  cv.width = X0 + RW + 56 * S;
  cv.height = TOP + RACK.units * UH + 28 * S;
  const c = cv.getContext("2d");
  const font = '"PingFang SC","Microsoft YaHei",sans-serif';
  c.fillStyle = "#fff"; c.fillRect(0, 0, cv.width, cv.height);
  c.fillStyle = "#0b2545"; c.font = `bold ${18 * S}px ${font}`; c.textBaseline = "middle"; c.textAlign = "left";
  c.fillText(`${RACK.name}(${RACK.units}U)`, X0, 26 * S);
  c.font = `${11 * S}px ${font}`; c.fillStyle = "#5b6779";
  c.fillText(`设备 ${RACK.items.length} 台 · 已占用 ${rackUsedU()}/${RACK.units}U`, X0, 44 * S);
  c.fillStyle = "#eef0f4"; c.fillRect(X0, TOP, RW, RACK.units * UH);
  c.font = `${10 * S}px ${font}`;
  for (let u = RACK.units; u >= 1; u--) {
    const y = TOP + (RACK.units - u) * UH;
    c.strokeStyle = "#cfd4dc"; c.lineWidth = 1; c.strokeRect(X0, y, RW, UH);
    c.fillStyle = "#5b6779"; c.textAlign = "right"; c.fillText(String(u), X0 - 8 * S, y + UH / 2);
    c.textAlign = "left"; c.fillText(String(u), X0 + RW + 8 * S, y + UH / 2);
  }
  c.strokeStyle = "#0b2545"; c.lineWidth = 3 * S; c.strokeRect(X0, TOP, RW, RACK.units * UH);
  c.font = `${12 * S}px ${font}`; c.textAlign = "center";
  RACK.items.forEach((o) => {
    const x = X0 + o.col / RACK_COLS * RW, w = o.w / RACK_COLS * RW;
    const y = TOP + (RACK.units - (o.start + o.u - 1)) * UH, h = o.u * UH;
    c.fillStyle = rackColor(o.cat); c.fillRect(x + S, y + S, w - 2 * S, h - 2 * S);
    c.fillStyle = "#fff";
    let t = o.name;
    while (t.length > 1 && c.measureText(t).width > w - 10 * S) t = t.slice(0, -1);
    if (t !== o.name) t += "…";
    c.fillText(t, x + w / 2, y + h / 2);
  });
  cv.toBlob((b) => b && rackDownload(b, rackFileName() + ".png"), "image/png");
}
