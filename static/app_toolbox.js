/* ============================================================
   模块:工具箱(纯前端计算工具,不依赖后端/数据库)
   ============================================================ */
let TOOLBOX_TAB = "ip";
const TOOLBOX_TABS = [
  { id: "ip", label: "IP规划", sub: "CIDR / 拆分 / 可用地址" },
  { id: "bandwidth", label: "带宽评估", sub: "码流合计 vs 上联" },
  { id: "storage", label: "存储估算", sub: "录像容量 / 硬盘" },
  { id: "poe", label: "PoE预算", sub: "功耗 vs 交换机" },
  { id: "raid", label: "RAID容量", sub: "有效容量速算" },
  { id: "optical", label: "光衰预算", sub: "链路损耗核算" },
  { id: "voltage", label: "压降计算", sub: "末端电压是否够用" },
  { id: "ups", label: "UPS续航", sub: "应急电源续航估算" },
  { id: "awg", label: "线规换算", sub: "AWG / mm² / 长度单位" },
  { id: "tray", label: "桥架填充率", sub: "线槽截面利用率" },
  { id: "catcheck", label: "网线测距", sub: "是否超过100米" },
  { id: "fov", label: "镜头视场角", sub: "焦距 / 覆盖范围" },
  { id: "cable", label: "线材粗算", sub: "网线箱数 / 预留" },
  { id: "password", label: "密码生成", sub: "设备激活强密码" },
  { id: "rtsp", label: "RTSP编码", sub: "特殊字符URL编码" },
];

async function renderToolboxView() {
  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="page-head">
      <h1>工具箱</h1>
      <span class="sub">弱电工程常用速算工具,纯本地计算,不联网也能用</span>
    </div>
    <div class="toolbar" style="flex-wrap:wrap;">
      ${TOOLBOX_TABS.map((t) => `
        <button class="btn ${TOOLBOX_TAB === t.id ? "btn-primary" : "btn-outline"} btn-sm" onclick="switchToolboxTab('${t.id}')">
          ${t.label}
        </button>
      `).join("")}
    </div>
    <div id="toolboxBody"></div>
  `;
  renderToolboxTabBody();
}

function switchToolboxTab(id) {
  TOOLBOX_TAB = id;
  renderToolboxView();
}

function renderToolboxTabBody() {
  const renderers = {
    ip: renderIPTool,
    bandwidth: renderBandwidthTool,
    storage: renderStorageTool,
    poe: renderPoETool,
    raid: renderRAIDTool,
    optical: renderOpticalTool,
    voltage: renderVoltageTool,
    ups: renderUPSTool,
    awg: renderAWGTool,
    tray: renderTrayTool,
    catcheck: renderCatCheckTool,
    fov: renderFOVTool,
    cable: renderCableTool,
    password: renderPasswordTool,
    rtsp: renderRTSPTool,
  };
  (renderers[TOOLBOX_TAB] || renderIPTool)();
}

function toolboxStatColor(pct) {
  if (pct > 100) return "var(--red)";
  if (pct >= 85) return "var(--amber)";
  return "var(--green)";
}

/* ============================================================
   1. IP规划(CIDR / 子网掩码 / 拆分 / 可用地址)
   ============================================================ */
function ipToInt(ip) {
  const parts = String(ip).trim().split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
function intToIp(int) {
  return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join(".");
}
function maskIntToPrefix(maskInt) {
  let bits = 0;
  for (let i = 31; i >= 0; i--) {
    if ((maskInt >>> i) & 1) bits++;
    else break;
  }
  const rebuilt = prefixToMaskInt(bits);
  return rebuilt === maskInt ? bits : null;
}
function prefixToMaskInt(prefix) {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

function parseIPInput(str) {
  str = (str || "").trim();
  if (!str) return null;
  let m = str.match(/^([\d.]+)\s*\/\s*(\d{1,2})$/);
  if (m) {
    const ipInt = ipToInt(m[1]);
    const prefix = parseInt(m[2]);
    if (ipInt === null || prefix < 0 || prefix > 32) return null;
    return { ipInt, prefix };
  }
  m = str.match(/^([\d.]+)[\s,]+([\d.]+)$/);
  if (m) {
    const ipInt = ipToInt(m[1]);
    const maskInt = ipToInt(m[2]);
    if (ipInt === null || maskInt === null) return null;
    const prefix = maskIntToPrefix(maskInt);
    if (prefix === null) return null;
    return { ipInt, prefix };
  }
  return null;
}

function analyzeCIDR(ipInt, prefix) {
  const mask = prefixToMaskInt(prefix);
  const network = (ipInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const total = Math.pow(2, 32 - prefix);
  let usable, first, last;
  if (prefix >= 31) {
    usable = prefix === 32 ? 1 : 2;
    first = network;
    last = broadcast;
  } else {
    usable = total - 2;
    first = network + 1;
    last = broadcast - 1;
  }
  return {
    normalized: intToIp(network) + "/" + prefix,
    network: intToIp(network), broadcast: intToIp(broadcast),
    mask: intToIp(mask), wildcard: intToIp(~mask >>> 0),
    usable, first: intToIp(first), last: intToIp(last),
    gateway: intToIp(first), networkInt: network, prefix,
  };
}

function copyText(text) {
  if (navigator.clipboard) navigator.clipboard.writeText(text);
  toast(`已复制: ${text}`);
}

let IP_ADDR_COUNT = 20;
let IP_SPLIT_PREFIX = null;

function renderIPTool() {
  const body = document.getElementById("toolboxBody");
  body.innerHTML = `
    <div class="card panel">
      <p style="color:var(--text-dim);font-size:13px;margin:0 0 12px;">输入 CIDR 网段(如 192.168.20.0/24)或"IP 掩码"(如 192.168.20.5 255.255.255.0),立刻给出网络地址、可用地址范围、建议网关,可继续拆分子网。</p>
      <div class="toolbar">
        <input type="text" id="ipInput" class="grow mono" placeholder="192.168.20.0/24" value="192.168.20.0/24" style="flex:2;">
      </div>
      <div id="ipResultArea"></div>
    </div>
  `;
  document.getElementById("ipInput").addEventListener("input", paintIPResult);
  IP_SPLIT_PREFIX = null;
  paintIPResult();
}

function paintIPResult() {
  const area = document.getElementById("ipResultArea");
  const val = document.getElementById("ipInput").value;
  const parsed = parseIPInput(val);
  if (!parsed) {
    area.innerHTML = `<p style="color:var(--red);font-size:13px;margin-top:10px;">格式不识别,请输入 "IP/前缀"(如 192.168.20.0/24)或 "IP 掩码"(如 192.168.20.5 255.255.255.0)</p>`;
    return;
  }
  const r = analyzeCIDR(parsed.ipInt, parsed.prefix);
  if (IP_SPLIT_PREFIX === null || IP_SPLIT_PREFIX <= r.prefix) IP_SPLIT_PREFIX = Math.min(r.prefix + 1, 32);

  area.innerHTML = `
    <div class="stat-row" style="margin-top:14px;">
      <div class="stat-box"><div class="v mono" style="font-size:16px;">${r.normalized}</div><div class="l">规范化</div></div>
      <div class="stat-box"><div class="v mono" style="font-size:16px;">${r.network}</div><div class="l">网络地址</div></div>
      <div class="stat-box"><div class="v mono" style="font-size:16px;">${r.broadcast}</div><div class="l">广播地址</div></div>
      <div class="stat-box"><div class="v mono" style="font-size:16px;">${r.mask}</div><div class="l">子网掩码</div></div>
      <div class="stat-box"><div class="v mono" style="font-size:16px;">${r.wildcard}</div><div class="l">反掩码</div></div>
    </div>
    <div class="stat-row">
      <div class="stat-box"><div class="v">${fmtNum(r.usable)}</div><div class="l">可用主机</div></div>
      <div class="stat-box"><div class="v mono" style="font-size:16px;">${r.first}</div><div class="l">首地址</div></div>
      <div class="stat-box"><div class="v mono" style="font-size:16px;">${r.last}</div><div class="l">末地址</div></div>
      <div class="stat-box" style="background:rgba(30,142,90,0.08);border-color:var(--green);">
        <div class="v mono" style="font-size:16px;color:var(--green);">${r.gateway}</div><div class="l">建议网关</div>
      </div>
    </div>

    <div class="card panel" style="margin-top:16px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
        <b style="font-size:14px;">可用地址示例(前 <span id="ipAddrCountLabel">${IP_ADDR_COUNT}</span> 个)</b>
        <button class="btn btn-outline btn-sm" onclick="adjustIPAddrCount(-10)">-10</button>
        <button class="btn btn-outline btn-sm" onclick="adjustIPAddrCount(10)">+10</button>
        <div class="fill"></div>
        <button class="btn btn-outline btn-sm" id="ipCopyListBtn">复制列表</button>
      </div>
      <div id="ipAddrList" style="display:flex;flex-wrap:wrap;gap:6px;"></div>
    </div>

    <div class="card panel" style="margin-top:16px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
        <b style="font-size:14px;">拆分子网</b>
        <span style="color:var(--text-dim);font-size:12.5px;">拆成 /</span>
        <button class="btn btn-outline btn-sm" onclick="adjustSplitPrefix(-1)">－</button>
        <span class="mono" style="min-width:20px;text-align:center;">${IP_SPLIT_PREFIX}</span>
        <button class="btn btn-outline btn-sm" onclick="adjustSplitPrefix(1)">＋</button>
      </div>
      <div id="ipSplitList" style="display:flex;flex-wrap:wrap;gap:8px;"></div>
      <p style="color:var(--text-dim);font-size:12px;margin:10px 0 0;">点击地址或子网可复制;规划监控网时常用 /24、/23、/22。</p>
    </div>
  `;

  const addrList = document.getElementById("ipAddrList");
  const n = Math.min(IP_ADDR_COUNT, r.usable);
  let addrs = [];
  for (let i = 0; i < n; i++) addrs.push(intToIp(r.networkInt + 1 + i));
  addrList.innerHTML = addrs.map((a) => `<span class="tag tag-idle mono" style="cursor:pointer;" onclick="copyText('${a}')">${a}</span>`).join("");
  document.getElementById("ipCopyListBtn").addEventListener("click", () => copyText(addrs.join("\n")));

  const splitList = document.getElementById("ipSplitList");
  if (IP_SPLIT_PREFIX <= r.prefix) {
    splitList.innerHTML = `<span style="color:var(--red);font-size:13px;">拆分后的前缀必须比当前(/${r.prefix})更大</span>`;
  } else {
    const count = Math.pow(2, IP_SPLIT_PREFIX - r.prefix);
    const size = Math.pow(2, 32 - IP_SPLIT_PREFIX);
    const maxShow = Math.min(count, 64);
    let items = [];
    for (let i = 0; i < maxShow; i++) {
      items.push(intToIp(r.networkInt + i * size) + "/" + IP_SPLIT_PREFIX);
    }
    splitList.innerHTML = items.map((s) => `<span class="tag tag-ok mono" style="cursor:pointer;" onclick="copyText('${s}')">${s}</span>`).join("")
      + (count > maxShow ? `<span style="color:var(--text-dim);font-size:12.5px;">仅显示前 ${maxShow} 个,共 ${count} 个子网</span>` : "");
  }
}

function adjustIPAddrCount(delta) {
  IP_ADDR_COUNT = Math.max(5, Math.min(500, IP_ADDR_COUNT + delta));
  paintIPResult();
}
function adjustSplitPrefix(delta) {
  IP_SPLIT_PREFIX = Math.max(1, Math.min(32, (IP_SPLIT_PREFIX || 25) + delta));
  paintIPResult();
}

/* ============================================================
   2. 带宽评估(码流合计 vs 上联带宽)
   ============================================================ */
const BW_PRESETS = [
  { label: "自定义", mbps: null },
  { label: "200万 1080P · H.265(约3Mbps)", mbps: 3 },
  { label: "200万 1080P · H.264(约5Mbps)", mbps: 5 },
  { label: "400万 · H.265(约5Mbps)", mbps: 5 },
  { label: "800万 4K · H.265(约10Mbps)", mbps: 10 },
  { label: "800万 4K · H.264(约16Mbps)", mbps: 16 },
];
let BW_GROUPS = [{ count: 16, presetIdx: 1, mbps: 3 }];
let BW_UPLINK = 100;

function renderBandwidthTool() {
  const body = document.getElementById("toolboxBody");
  body.innerHTML = `
    <div class="card panel">
      <p style="color:var(--text-dim);font-size:13px;margin:0 0 12px;">按不同分辨率/编码分组录入路数和单路码流,自动合计总码流并与上联带宽比较。</p>
      <div id="bwGroupsArea"></div>
      <button class="btn btn-outline btn-sm" id="bwAddGroupBtn" style="margin-top:8px;">+ 添加一组</button>
      <div style="margin-top:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <label style="font-size:13px;color:var(--text-dim);">上联带宽(Mbps)</label>
        <input type="number" id="bwUplink" value="${BW_UPLINK}" style="width:120px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;">
      </div>
      <div id="bwResultArea"></div>
    </div>
  `;
  document.getElementById("bwAddGroupBtn").addEventListener("click", () => {
    BW_GROUPS.push({ count: 1, presetIdx: 1, mbps: 3 });
    paintBandwidthGroups();
  });
  document.getElementById("bwUplink").addEventListener("input", (e) => {
    BW_UPLINK = parseFloat(e.target.value) || 0;
    paintBandwidthResult();
  });
  paintBandwidthGroups();
}

function paintBandwidthGroups() {
  const area = document.getElementById("bwGroupsArea");
  area.innerHTML = BW_GROUPS.map((g, i) => `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
      <input type="number" min="0" class="mono" style="width:80px;padding:8px;border:1px solid var(--line);border-radius:6px;" placeholder="路数" value="${g.count}" onchange="updateBwGroup(${i},'count',this.value)">
      <span style="color:var(--text-dim);font-size:12.5px;">路 ×</span>
      <select style="padding:8px;border:1px solid var(--line);border-radius:6px;min-width:220px;" onchange="updateBwGroup(${i},'presetIdx',this.value)">
        ${BW_PRESETS.map((p, pi) => `<option value="${pi}" ${g.presetIdx === pi ? "selected" : ""}>${p.label}</option>`).join("")}
      </select>
      <input type="number" min="0" step="0.1" class="mono" style="width:90px;padding:8px;border:1px solid var(--line);border-radius:6px;" placeholder="Mbps" value="${g.mbps}" onchange="updateBwGroup(${i},'mbps',this.value)">
      <span style="color:var(--text-dim);font-size:12.5px;">Mbps/路</span>
      ${BW_GROUPS.length > 1 ? `<button class="btn btn-danger btn-sm" onclick="removeBwGroup(${i})">删除</button>` : ""}
    </div>
  `).join("");
  paintBandwidthResult();
}

function updateBwGroup(idx, field, val) {
  const g = BW_GROUPS[idx];
  if (field === "count") g.count = parseFloat(val) || 0;
  else if (field === "mbps") g.mbps = parseFloat(val) || 0;
  else if (field === "presetIdx") {
    g.presetIdx = parseInt(val);
    const preset = BW_PRESETS[g.presetIdx];
    if (preset.mbps !== null) g.mbps = preset.mbps;
    paintBandwidthGroups();
    return;
  }
  paintBandwidthResult();
}
function removeBwGroup(idx) {
  BW_GROUPS.splice(idx, 1);
  paintBandwidthGroups();
}

function paintBandwidthResult() {
  const area = document.getElementById("bwResultArea");
  const total = BW_GROUPS.reduce((s, g) => s + g.count * g.mbps, 0);
  const totalCameras = BW_GROUPS.reduce((s, g) => s + g.count, 0);
  const pct = BW_UPLINK > 0 ? (total / BW_UPLINK) * 100 : 0;
  const color = toolboxStatColor(pct);
  area.innerHTML = `
    <div class="stat-row" style="margin-top:14px;">
      <div class="stat-box"><div class="v">${fmtNum(totalCameras)}</div><div class="l">设备总路数</div></div>
      <div class="stat-box"><div class="v">${fmtNum(total)}</div><div class="l">总码流(Mbps)</div></div>
      <div class="stat-box"><div class="v">${fmtNum(BW_UPLINK)}</div><div class="l">上联带宽(Mbps)</div></div>
      <div class="stat-box"><div class="v" style="color:${color}">${pct.toFixed(0)}%</div><div class="l">带宽利用率</div></div>
      <div class="stat-box"><div class="v" style="color:${BW_UPLINK - total >= 0 ? "var(--green)" : "var(--red)"}">${fmtNum(BW_UPLINK - total)}</div><div class="l">${BW_UPLINK - total >= 0 ? "剩余余量" : "超出(Mbps)"}</div></div>
    </div>
    ${progressBar(pct, color)}
    ${pct > 100 ? `<p style="color:var(--red);font-size:13px;margin-top:8px;">⚠ 总码流已超出上联带宽,建议降低码流、启用子码流或增加上联带宽。</p>` : pct >= 85 ? `<p style="color:var(--amber);font-size:13px;margin-top:8px;">带宽利用率较高,建议预留余量以应对突发码流。</p>` : ""}
  `;
}

/* ============================================================
   3. 存储估算(录像容量 / 硬盘)
   ============================================================ */
function renderStorageTool() {
  const body = document.getElementById("toolboxBody");
  body.innerHTML = `
    <div class="card panel">
      <p style="color:var(--text-dim);font-size:13px;margin:0 0 12px;">按路数、单路码流、存储天数估算总容量需求,并给出建议硬盘数量(容量按 1TB=1000GB 计算,贴近硬盘标称容量)。</p>
      <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:640px;">
        <div class="field"><label>录像路数</label><input type="number" id="stCount" value="32" class="mono"></div>
        <div class="field"><label>单路码流(Mbps)</label><input type="number" id="stMbps" value="4" step="0.1" class="mono"></div>
        <div class="field"><label>存储天数</label><input type="number" id="stDays" value="30" class="mono"></div>
        <div class="field"><label>单盘容量(TB)</label><input type="number" id="stDiskTB" value="8" step="0.1" class="mono"></div>
        <div class="field grid1"><label>格式化/预留损耗(%)</label><input type="number" id="stLoss" value="9" step="1" class="mono"></div>
      </div>
      <div id="stResultArea"></div>
    </div>
  `;
  ["stCount", "stMbps", "stDays", "stDiskTB", "stLoss"].forEach((id) => {
    document.getElementById(id).addEventListener("input", paintStorageResult);
  });
  paintStorageResult();
}

function paintStorageResult() {
  const count = parseFloat(document.getElementById("stCount").value) || 0;
  const mbps = parseFloat(document.getElementById("stMbps").value) || 0;
  const days = parseFloat(document.getElementById("stDays").value) || 0;
  const diskTB = parseFloat(document.getElementById("stDiskTB").value) || 0;
  const lossPct = parseFloat(document.getElementById("stLoss").value) || 0;

  const perChannelPerDayGB = (mbps * 1000000 * 86400) / 8 / 1e9;
  const totalGB = perChannelPerDayGB * days * count;
  const totalTB = totalGB / 1000;
  const effectiveDiskTB = diskTB * (1 - lossPct / 100);
  const diskCount = effectiveDiskTB > 0 ? Math.ceil(totalTB / effectiveDiskTB) : 0;

  const area = document.getElementById("stResultArea");
  area.innerHTML = `
    <div class="stat-row" style="margin-top:14px;">
      <div class="stat-box"><div class="v">${fmtNum(perChannelPerDayGB)}</div><div class="l">单路日容量(GB)</div></div>
      <div class="stat-box"><div class="v">${fmtNum(totalGB)}</div><div class="l">总容量需求(GB)</div></div>
      <div class="stat-box"><div class="v">${fmtNum(totalTB)}</div><div class="l">总容量需求(TB)</div></div>
      <div class="stat-box" style="background:rgba(15,155,176,0.08);border-color:var(--cyan);">
        <div class="v" style="color:var(--cyan)">${diskCount}</div><div class="l">建议硬盘数量</div>
      </div>
    </div>
    <p style="color:var(--text-dim);font-size:12.5px;margin-top:8px;">按每块盘扣除 ${lossPct}% 格式化/预留损耗后的有效容量 ${fmtNum(effectiveDiskTB)}TB 计算。如需组 RAID,请结合"RAID容量"工具计算冗余后的可用空间。</p>
  `;
}

/* ============================================================
   4. PoE预算(功耗 vs 交换机)
   ============================================================ */
const POE_PRESETS = [
  { label: "自定义", watt: null },
  { label: "802.3af(约15.4W)", watt: 15.4 },
  { label: "802.3at / PoE+(约30W)", watt: 30 },
  { label: "802.3bt Type3(约60W)", watt: 60 },
  { label: "802.3bt Type4(约90W)", watt: 90 },
];
let POE_GROUPS = [{ count: 16, presetIdx: 1, watt: 15.4 }];
let POE_BUDGET = 250;

function renderPoETool() {
  const body = document.getElementById("toolboxBody");
  body.innerHTML = `
    <div class="card panel">
      <p style="color:var(--text-dim);font-size:13px;margin:0 0 12px;">按设备分组录入数量和单个功耗,自动合计总功耗并与交换机 PoE 总预算比较。</p>
      <div id="poeGroupsArea"></div>
      <button class="btn btn-outline btn-sm" id="poeAddGroupBtn" style="margin-top:8px;">+ 添加一组</button>
      <div style="margin-top:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <label style="font-size:13px;color:var(--text-dim);">交换机PoE总预算(W)</label>
        <input type="number" id="poeBudget" value="${POE_BUDGET}" style="width:120px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;">
      </div>
      <div id="poeResultArea"></div>
    </div>
  `;
  document.getElementById("poeAddGroupBtn").addEventListener("click", () => {
    POE_GROUPS.push({ count: 1, presetIdx: 1, watt: 15.4 });
    paintPoEGroups();
  });
  document.getElementById("poeBudget").addEventListener("input", (e) => {
    POE_BUDGET = parseFloat(e.target.value) || 0;
    paintPoEResult();
  });
  paintPoEGroups();
}

function paintPoEGroups() {
  const area = document.getElementById("poeGroupsArea");
  area.innerHTML = POE_GROUPS.map((g, i) => `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
      <input type="number" min="0" class="mono" style="width:80px;padding:8px;border:1px solid var(--line);border-radius:6px;" placeholder="数量" value="${g.count}" onchange="updatePoEGroup(${i},'count',this.value)">
      <span style="color:var(--text-dim);font-size:12.5px;">个 ×</span>
      <select style="padding:8px;border:1px solid var(--line);border-radius:6px;min-width:200px;" onchange="updatePoEGroup(${i},'presetIdx',this.value)">
        ${POE_PRESETS.map((p, pi) => `<option value="${pi}" ${g.presetIdx === pi ? "selected" : ""}>${p.label}</option>`).join("")}
      </select>
      <input type="number" min="0" step="0.1" class="mono" style="width:90px;padding:8px;border:1px solid var(--line);border-radius:6px;" placeholder="W" value="${g.watt}" onchange="updatePoEGroup(${i},'watt',this.value)">
      <span style="color:var(--text-dim);font-size:12.5px;">W/个</span>
      ${POE_GROUPS.length > 1 ? `<button class="btn btn-danger btn-sm" onclick="removePoEGroup(${i})">删除</button>` : ""}
    </div>
  `).join("");
  paintPoEResult();
}

function updatePoEGroup(idx, field, val) {
  const g = POE_GROUPS[idx];
  if (field === "count") g.count = parseFloat(val) || 0;
  else if (field === "watt") g.watt = parseFloat(val) || 0;
  else if (field === "presetIdx") {
    g.presetIdx = parseInt(val);
    const preset = POE_PRESETS[g.presetIdx];
    if (preset.watt !== null) g.watt = preset.watt;
    paintPoEGroups();
    return;
  }
  paintPoEResult();
}
function removePoEGroup(idx) {
  POE_GROUPS.splice(idx, 1);
  paintPoEGroups();
}

function paintPoEResult() {
  const area = document.getElementById("poeResultArea");
  const total = POE_GROUPS.reduce((s, g) => s + g.count * g.watt, 0);
  const totalDevices = POE_GROUPS.reduce((s, g) => s + g.count, 0);
  const pct = POE_BUDGET > 0 ? (total / POE_BUDGET) * 100 : 0;
  const color = toolboxStatColor(pct);
  area.innerHTML = `
    <div class="stat-row" style="margin-top:14px;">
      <div class="stat-box"><div class="v">${fmtNum(totalDevices)}</div><div class="l">设备总数</div></div>
      <div class="stat-box"><div class="v">${fmtNum(total)}</div><div class="l">总功耗(W)</div></div>
      <div class="stat-box"><div class="v">${fmtNum(POE_BUDGET)}</div><div class="l">交换机预算(W)</div></div>
      <div class="stat-box"><div class="v" style="color:${color}">${pct.toFixed(0)}%</div><div class="l">预算利用率</div></div>
      <div class="stat-box"><div class="v" style="color:${POE_BUDGET - total >= 0 ? "var(--green)" : "var(--red)"}">${fmtNum(POE_BUDGET - total)}</div><div class="l">${POE_BUDGET - total >= 0 ? "剩余余量(W)" : "超出(W)"}</div></div>
    </div>
    ${progressBar(pct, color)}
    ${pct > 100 ? `<p style="color:var(--red);font-size:13px;margin-top:8px;">⚠ 总功耗已超出交换机 PoE 预算,可能导致部分端口无法供电,建议更换更大预算的交换机或分摊到多台交换机。</p>` : ""}
  `;
}

/* ============================================================
   5. RAID容量(有效容量速算)
   ============================================================ */
const RAID_LEVELS = [
  { id: "0", label: "RAID 0(无冗余)", minDisks: 2, calc: (n, cap) => n * cap },
  { id: "1", label: "RAID 1(镜像)", minDisks: 2, calc: (n, cap) => cap },
  { id: "5", label: "RAID 5(单盘容错)", minDisks: 3, calc: (n, cap) => (n - 1) * cap },
  { id: "6", label: "RAID 6(双盘容错)", minDisks: 4, calc: (n, cap) => (n - 2) * cap },
  { id: "10", label: "RAID 10(镜像+条带)", minDisks: 4, calc: (n, cap) => (n / 2) * cap, evenOnly: true },
];

function renderRAIDTool() {
  const body = document.getElementById("toolboxBody");
  body.innerHTML = `
    <div class="card panel">
      <p style="color:var(--text-dim);font-size:13px;margin:0 0 12px;">按硬盘数量、单盘容量、RAID级别速算有效可用容量(简化估算,不含条带对齐等细节损耗)。</p>
      <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:640px;">
        <div class="field"><label>硬盘数量</label><input type="number" id="rdCount" value="4" class="mono"></div>
        <div class="field"><label>单盘容量(TB)</label><input type="number" id="rdDiskTB" value="8" step="0.1" class="mono"></div>
        <div class="field grid1"><label>RAID级别</label>
          <select id="rdLevel">
            ${RAID_LEVELS.map((r) => `<option value="${r.id}">${r.label}</option>`).join("")}
          </select>
        </div>
      </div>
      <div id="rdResultArea"></div>
    </div>
  `;
  ["rdCount", "rdDiskTB", "rdLevel"].forEach((id) => {
    document.getElementById(id).addEventListener("input", paintRAIDResult);
    document.getElementById(id).addEventListener("change", paintRAIDResult);
  });
  paintRAIDResult();
}

function paintRAIDResult() {
  const n = parseInt(document.getElementById("rdCount").value) || 0;
  const cap = parseFloat(document.getElementById("rdDiskTB").value) || 0;
  const levelId = document.getElementById("rdLevel").value;
  const level = RAID_LEVELS.find((r) => r.id === levelId);
  const area = document.getElementById("rdResultArea");

  const rawTotal = n * cap;
  let warning = "";
  if (n < level.minDisks) {
    warning = `⚠ ${level.label} 至少需要 ${level.minDisks} 块盘,当前只有 ${n} 块,以下结果仅供参考`;
  } else if (level.evenOnly && n % 2 !== 0) {
    warning = `⚠ ${level.label} 通常要求偶数块盘,当前为 ${n} 块,结果按向下取整的镜像对计算`;
  }
  const effectiveN = level.evenOnly ? Math.floor(n / 2) * 2 : n;
  const usable = level.calc(effectiveN, cap);
  const overheadPct = rawTotal > 0 ? ((rawTotal - usable) / rawTotal) * 100 : 0;

  area.innerHTML = `
    <div class="stat-row" style="margin-top:14px;">
      <div class="stat-box"><div class="v">${fmtNum(rawTotal)}</div><div class="l">原始总容量(TB)</div></div>
      <div class="stat-box" style="background:rgba(15,155,176,0.08);border-color:var(--cyan);">
        <div class="v" style="color:var(--cyan)">${fmtNum(usable)}</div><div class="l">可用容量(TB)</div>
      </div>
      <div class="stat-box"><div class="v">${overheadPct.toFixed(0)}%</div><div class="l">冗余开销占比</div></div>
    </div>
    ${warning ? `<p style="color:var(--red);font-size:13px;margin-top:8px;">${warning}</p>` : ""}
  `;
}

/* ============================================================
   6. 光衰预算(链路损耗核算)
   ============================================================ */
const FIBER_PRESETS = [
  { label: "自定义", coef: null },
  { label: "单模 1310nm(约0.35dB/km)", coef: 0.35 },
  { label: "单模 1550nm(约0.25dB/km)", coef: 0.25 },
  { label: "多模 850nm(约3.0dB/km)", coef: 3.0 },
];

function renderOpticalTool() {
  const body = document.getElementById("toolboxBody");
  body.innerHTML = `
    <div class="card panel">
      <p style="color:var(--text-dim);font-size:13px;margin:0 0 12px;">按光纤长度、熔接点、活接头估算链路总损耗,并与光模块的光功率预算比较,判断链路是否有足够余量。</p>
      <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:680px;">
        <div class="field"><label>光纤长度(km)</label><input type="number" id="opLen" value="5" step="0.1" class="mono"></div>
        <div class="field"><label>光纤类型</label>
          <select id="opFiberPreset">
            ${FIBER_PRESETS.map((p, i) => `<option value="${i}" ${i === 1 ? "selected" : ""}>${p.label}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>衰减系数(dB/km)</label><input type="number" id="opCoef" value="0.35" step="0.01" class="mono"></div>
        <div class="field"><label>熔接点数量</label><input type="number" id="opSplice" value="2" class="mono"></div>
        <div class="field"><label>熔接损耗(dB/点)</label><input type="number" id="opSpliceLoss" value="0.1" step="0.01" class="mono"></div>
        <div class="field"><label>活接头(法兰)数量</label><input type="number" id="opConn" value="2" class="mono"></div>
        <div class="field"><label>插损(dB/个)</label><input type="number" id="opConnLoss" value="0.5" step="0.01" class="mono"></div>
        <div class="field"><label>系统安全余量(dB)</label><input type="number" id="opMargin" value="3" step="0.1" class="mono"></div>
        <div class="field grid1"><label>光模块光功率预算(dB)</label><input type="number" id="opBudget" value="15" step="0.1" class="mono"></div>
      </div>
      <p style="color:var(--text-dim);font-size:12px;margin-top:6px;">光模块预算 = 发射光功率(dBm) − 接收灵敏度(dBm),如不清楚可查模块规格书,常见单模模块约为 12~24dB。</p>
      <div id="opResultArea"></div>
    </div>
  `;
  document.getElementById("opFiberPreset").addEventListener("change", (e) => {
    const preset = FIBER_PRESETS[parseInt(e.target.value)];
    if (preset.coef !== null) document.getElementById("opCoef").value = preset.coef;
    paintOpticalResult();
  });
  ["opLen", "opCoef", "opSplice", "opSpliceLoss", "opConn", "opConnLoss", "opMargin", "opBudget"].forEach((id) => {
    document.getElementById(id).addEventListener("input", paintOpticalResult);
  });
  paintOpticalResult();
}

function paintOpticalResult() {
  const len = parseFloat(document.getElementById("opLen").value) || 0;
  const coef = parseFloat(document.getElementById("opCoef").value) || 0;
  const spliceCount = parseFloat(document.getElementById("opSplice").value) || 0;
  const spliceLoss = parseFloat(document.getElementById("opSpliceLoss").value) || 0;
  const connCount = parseFloat(document.getElementById("opConn").value) || 0;
  const connLoss = parseFloat(document.getElementById("opConnLoss").value) || 0;
  const margin = parseFloat(document.getElementById("opMargin").value) || 0;
  const budget = parseFloat(document.getElementById("opBudget").value) || 0;

  const fiberLoss = len * coef;
  const spliceTotal = spliceCount * spliceLoss;
  const connTotal = connCount * connLoss;
  const totalLoss = fiberLoss + spliceTotal + connTotal;
  const requiredBudget = totalLoss + margin;
  const remaining = budget - totalLoss - margin;
  const pass = remaining >= 0;

  const area = document.getElementById("opResultArea");
  area.innerHTML = `
    <div class="stat-row" style="margin-top:14px;">
      <div class="stat-box"><div class="v">${fmtNum(fiberLoss)}</div><div class="l">光纤衰减(dB)</div></div>
      <div class="stat-box"><div class="v">${fmtNum(spliceTotal)}</div><div class="l">熔接损耗(dB)</div></div>
      <div class="stat-box"><div class="v">${fmtNum(connTotal)}</div><div class="l">活接头损耗(dB)</div></div>
      <div class="stat-box"><div class="v"><b>${fmtNum(totalLoss)}</b></div><div class="l">链路总损耗(dB)</div></div>
    </div>
    <div class="stat-row">
      <div class="stat-box"><div class="v">${fmtNum(requiredBudget)}</div><div class="l">含安全余量所需预算(dB)</div></div>
      <div class="stat-box"><div class="v">${fmtNum(budget)}</div><div class="l">模块光功率预算(dB)</div></div>
      <div class="stat-box" style="background:${pass ? "rgba(30,142,90,0.08)" : "rgba(192,57,43,0.08)"};border-color:${pass ? "var(--green)" : "var(--red)"};">
        <div class="v" style="color:${pass ? "var(--green)" : "var(--red)"}">${fmtNum(remaining)}</div><div class="l">剩余余量(dB)</div>
      </div>
      <div class="stat-box">
        <div class="v"><span class="tag ${pass ? "tag-ok" : "tag-bad"}">${pass ? "通过" : "不通过"}</span></div><div class="l">链路预算判定</div>
      </div>
    </div>
    ${!pass ? `<p style="color:var(--red);font-size:13px;margin-top:8px;">⚠ 链路损耗加上安全余量已超出模块光功率预算,建议减少熔接/接头数量、更换低衰减光纤,或改用预算更高的光模块。</p>` : ""}
  `;
}

/* ============================================================
   7. 压降计算(末端电压是否够用)
   ============================================================ */
const VOLTAGE_PRESETS = [12, 24, 48];
const WIRE_AREA_PRESETS = [
  { label: "自定义", mm2: null },
  { label: "0.5 mm² (约AWG20)", mm2: 0.5 },
  { label: "0.75 mm² (约AWG18)", mm2: 0.75 },
  { label: "1.0 mm² (约AWG17)", mm2: 1.0 },
  { label: "1.5 mm² (约AWG15)", mm2: 1.5 },
  { label: "2.5 mm² (约AWG13)", mm2: 2.5 },
];

function renderVoltageTool() {
  const body = document.getElementById("toolboxBody");
  body.innerHTML = `
    <div class="card panel">
      <p style="color:var(--text-dim);font-size:13px;margin:0 0 12px;">摄像头/门禁等直流设备走线过长、线径太细时,末端电压会跌落导致设备不稳定。按供电电压、负载电流、单程距离、线径估算末端实际电压。</p>
      <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:640px;">
        <div class="field"><label>电源电压(V)</label>
          <select id="vdVoltagePreset">
            ${VOLTAGE_PRESETS.map((v) => `<option value="${v}">${v}V</option>`).join("")}
            <option value="custom">自定义</option>
          </select>
        </div>
        <div class="field"><label>实际电压值(V)</label><input type="number" id="vdVoltage" value="12" step="0.1" class="mono"></div>
        <div class="field"><label>负载电流(A)</label><input type="number" id="vdCurrent" value="1" step="0.01" class="mono"></div>
        <div class="field"><label>单程距离(m)</label><input type="number" id="vdDistance" value="30" class="mono"></div>
        <div class="field"><label>线径预设</label>
          <select id="vdAreaPreset">
            ${WIRE_AREA_PRESETS.map((p, i) => `<option value="${i}" ${i === 3 ? "selected" : ""}>${p.label}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>横截面积(mm²)</label><input type="number" id="vdArea" value="1.5" step="0.01" class="mono"></div>
        <div class="field grid1"><label>最低可接受电压(V,选填)</label><input type="number" id="vdMinVoltage" value="10.5" step="0.1" class="mono"></div>
      </div>
      <p style="color:var(--text-dim);font-size:12px;margin-top:6px;">按铜线电阻率 0.0175 Ω·mm²/m、去回双程计算(负载为纯电阻性近似估算)。</p>
      <div id="vdResultArea"></div>
    </div>
  `;
  document.getElementById("vdVoltagePreset").addEventListener("change", (e) => {
    if (e.target.value !== "custom") document.getElementById("vdVoltage").value = e.target.value;
    paintVoltageResult();
  });
  document.getElementById("vdAreaPreset").addEventListener("change", (e) => {
    const preset = WIRE_AREA_PRESETS[parseInt(e.target.value)];
    if (preset.mm2 !== null) document.getElementById("vdArea").value = preset.mm2;
    paintVoltageResult();
  });
  ["vdVoltage", "vdCurrent", "vdDistance", "vdArea", "vdMinVoltage"].forEach((id) => {
    document.getElementById(id).addEventListener("input", paintVoltageResult);
  });
  paintVoltageResult();
}

function paintVoltageResult() {
  const voltage = parseFloat(document.getElementById("vdVoltage").value) || 0;
  const current = parseFloat(document.getElementById("vdCurrent").value) || 0;
  const distance = parseFloat(document.getElementById("vdDistance").value) || 0;
  const area = parseFloat(document.getElementById("vdArea").value) || 0;
  const minVoltage = parseFloat(document.getElementById("vdMinVoltage").value) || 0;
  const RESISTIVITY = 0.0175; // 铜线电阻率 Ω·mm²/m

  const area_ = area > 0 ? area : 0.0001;
  const loopResistance = (2 * RESISTIVITY * distance) / area_;
  const drop = current * loopResistance;
  const endVoltage = voltage - drop;
  const dropPct = voltage > 0 ? (drop / voltage) * 100 : 0;
  const pass = endVoltage >= minVoltage;

  const area_el = document.getElementById("vdResultArea");
  area_el.innerHTML = `
    <div class="stat-row" style="margin-top:14px;">
      <div class="stat-box"><div class="v">${fmtNum(loopResistance)}</div><div class="l">线路电阻(Ω)</div></div>
      <div class="stat-box"><div class="v" style="color:${dropPct > 15 ? "var(--red)" : dropPct > 8 ? "var(--amber)" : "var(--green)"}">${fmtNum(drop)}</div><div class="l">压降(V)</div></div>
      <div class="stat-box"><div class="v"><b>${fmtNum(endVoltage)}</b></div><div class="l">末端实际电压(V)</div></div>
      <div class="stat-box"><div class="v">${dropPct.toFixed(1)}%</div><div class="l">压降百分比</div></div>
      <div class="stat-box" style="background:${pass ? "rgba(30,142,90,0.08)" : "rgba(192,57,43,0.08)"};border-color:${pass ? "var(--green)" : "var(--red)"};">
        <div class="v"><span class="tag ${pass ? "tag-ok" : "tag-bad"}">${pass ? "满足" : "不足"}</span></div><div class="l">是否满足最低电压</div>
      </div>
    </div>
    ${!pass ? `<p style="color:var(--red);font-size:13px;margin-top:8px;">⚠ 末端电压低于设定的最低可接受电压,建议加粗线径、缩短距离,或改用本地供电/POE供电方式。</p>` : ""}
  `;
}

/* ============================================================
   8. UPS/应急电源续航估算
   ============================================================ */
function renderUPSTool() {
  const body = document.getElementById("toolboxBody");
  body.innerHTML = `
    <div class="card panel">
      <p style="color:var(--text-dim);font-size:13px;margin:0 0 12px;">按蓄电池容量和负载功耗估算断电后的应急供电时长。</p>
      <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:640px;">
        <div class="field"><label>蓄电池容量(Ah)</label><input type="number" id="upAh" value="7" step="0.1" class="mono"></div>
        <div class="field"><label>蓄电池电压(V)</label><input type="number" id="upBattV" value="12" step="0.1" class="mono"></div>
        <div class="field"><label>电池节数(串联)</label><input type="number" id="upSeries" value="2" class="mono"></div>
        <div class="field"><label>逆变/转换效率(%)</label><input type="number" id="upEff" value="85" step="1" class="mono"></div>
        <div class="field grid1"><label>负载总功率(W)</label><input type="number" id="upLoad" value="60" step="1" class="mono"></div>
      </div>
      <div id="upResultArea"></div>
    </div>
  `;
  ["upAh", "upBattV", "upSeries", "upEff", "upLoad"].forEach((id) => {
    document.getElementById(id).addEventListener("input", paintUPSResult);
  });
  paintUPSResult();
}

function paintUPSResult() {
  const ah = parseFloat(document.getElementById("upAh").value) || 0;
  const battV = parseFloat(document.getElementById("upBattV").value) || 0;
  const series = parseFloat(document.getElementById("upSeries").value) || 1;
  const eff = parseFloat(document.getElementById("upEff").value) || 100;
  const load = parseFloat(document.getElementById("upLoad").value) || 0;

  const totalWh = ah * battV * series;
  const usableWh = totalWh * (eff / 100);
  const hours = load > 0 ? usableWh / load : 0;
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);

  const area = document.getElementById("upResultArea");
  area.innerHTML = `
    <div class="stat-row" style="margin-top:14px;">
      <div class="stat-box"><div class="v">${fmtNum(totalWh)}</div><div class="l">电池总能量(Wh)</div></div>
      <div class="stat-box"><div class="v">${fmtNum(usableWh)}</div><div class="l">可用能量(Wh)</div></div>
      <div class="stat-box" style="background:rgba(15,155,176,0.08);border-color:var(--cyan);">
        <div class="v" style="color:var(--cyan)">${h}小时${m}分</div><div class="l">预计续航时长</div>
      </div>
    </div>
    <p style="color:var(--text-dim);font-size:12.5px;margin-top:8px;">估算按恒定负载功率计算,实际续航会受电池老化、温度、放电深度等因素影响,建议预留余量。</p>
  `;
}

/* ============================================================
   9. 线规换算(AWG / mm² / 长度单位)
   ============================================================ */
function awgToDiameterMm(awg) {
  return 0.127 * Math.pow(92, (36 - awg) / 39);
}
function awgToAreaMm2(awg) {
  const d = awgToDiameterMm(awg);
  return (Math.PI / 4) * d * d;
}
function mm2ToNearestAwg(mm2) {
  let best = null, bestDiff = Infinity;
  for (let awg = -3; awg <= 40; awg++) {
    const diff = Math.abs(awgToAreaMm2(awg) - mm2);
    if (diff < bestDiff) { bestDiff = diff; best = awg; }
  }
  return best;
}
const LENGTH_UNITS = [
  { id: "m", label: "米(m)", toM: 1 },
  { id: "ft", label: "英尺(ft)", toM: 0.3048 },
  { id: "inch", label: "英寸(in)", toM: 0.0254 },
  { id: "yard", label: "码(yd)", toM: 0.9144 },
];

function renderAWGTool() {
  const body = document.getElementById("toolboxBody");
  body.innerHTML = `
    <div class="card panel">
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;">
        <b style="font-size:14px;">AWG ↔ mm² 线规对照</b>
      </div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;">
        <div>
          <label style="font-size:13px;color:var(--text-dim);display:block;margin-bottom:6px;">输入 AWG 号</label>
          <input type="number" id="awgInput" value="18" class="mono" style="width:120px;padding:8px;border:1px solid var(--line);border-radius:6px;">
        </div>
        <div>
          <label style="font-size:13px;color:var(--text-dim);display:block;margin-bottom:6px;">输入 mm²</label>
          <input type="number" id="mm2Input" value="0.82" step="0.01" class="mono" style="width:120px;padding:8px;border:1px solid var(--line);border-radius:6px;">
        </div>
      </div>
      <div id="awgResultArea"></div>
    </div>
    <div class="card panel" style="margin-top:16px;">
      <b style="font-size:14px;">长度单位换算</b>
      <div style="display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap;">
        <input type="number" id="lenInput" value="100" step="0.01" class="mono" style="width:140px;padding:8px;border:1px solid var(--line);border-radius:6px;">
        <select id="lenUnit" style="padding:8px;border:1px solid var(--line);border-radius:6px;">
          ${LENGTH_UNITS.map((u) => `<option value="${u.id}">${u.label}</option>`).join("")}
        </select>
      </div>
      <div id="lenResultArea"></div>
    </div>
  `;
  document.getElementById("awgInput").addEventListener("input", () => paintAWGResult("awg"));
  document.getElementById("mm2Input").addEventListener("input", () => paintAWGResult("mm2"));
  document.getElementById("lenInput").addEventListener("input", paintLengthResult);
  document.getElementById("lenUnit").addEventListener("change", paintLengthResult);
  paintAWGResult("awg");
  paintLengthResult();
}

function paintAWGResult(source) {
  let awg, mm2;
  if (source === "awg") {
    awg = parseFloat(document.getElementById("awgInput").value);
    if (isNaN(awg)) { document.getElementById("awgResultArea").innerHTML = ""; return; }
    mm2 = awgToAreaMm2(awg);
    document.getElementById("mm2Input").value = mm2.toFixed(3);
  } else {
    mm2 = parseFloat(document.getElementById("mm2Input").value);
    if (isNaN(mm2) || mm2 <= 0) { document.getElementById("awgResultArea").innerHTML = ""; return; }
    awg = mm2ToNearestAwg(mm2);
    document.getElementById("awgInput").value = awg;
  }
  const diameter = awgToDiameterMm(awg);
  const area = document.getElementById("awgResultArea");
  area.innerHTML = `
    <div class="stat-row" style="margin-top:14px;">
      <div class="stat-box"><div class="v">AWG ${fmtNum(awg)}</div><div class="l">最接近的AWG</div></div>
      <div class="stat-box"><div class="v">${fmtNum(awgToAreaMm2(Math.round(awg)))}</div><div class="l">对应截面积(mm²)</div></div>
      <div class="stat-box"><div class="v">${fmtNum(awgToDiameterMm(Math.round(awg)))}</div><div class="l">对应直径(mm)</div></div>
    </div>
  `;
}

function paintLengthResult() {
  const val = parseFloat(document.getElementById("lenInput").value) || 0;
  const unitId = document.getElementById("lenUnit").value;
  const unit = LENGTH_UNITS.find((u) => u.id === unitId);
  const meters = val * unit.toM;
  const area = document.getElementById("lenResultArea");
  area.innerHTML = `
    <div class="stat-row" style="margin-top:14px;">
      ${LENGTH_UNITS.map((u) => `
        <div class="stat-box"><div class="v">${fmtNum(meters / u.toM)}</div><div class="l">${u.label}</div></div>
      `).join("")}
    </div>
  `;
}

/* ============================================================
   10. 桥架/线槽填充率
   ============================================================ */
let TRAY_CABLES = [{ count: 10, diameter: 6 }];

function renderTrayTool() {
  const body = document.getElementById("toolboxBody");
  body.innerHTML = `
    <div class="card panel">
      <p style="color:var(--text-dim);font-size:13px;margin:0 0 12px;">按桥架/线槽内截面尺寸和线缆规格,估算填充率。行业常参考不超过 40% 作为设计经验值,具体请以当地规范/设计要求为准。</p>
      <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:500px;">
        <div class="field"><label>桥架内宽(mm)</label><input type="number" id="trayW" value="100" class="mono"></div>
        <div class="field"><label>桥架内高(mm)</label><input type="number" id="trayH" value="50" class="mono"></div>
      </div>
      <div id="trayCablesArea" style="margin-top:12px;"></div>
      <button class="btn btn-outline btn-sm" id="trayAddBtn">+ 添加一种线缆</button>
      <div id="trayResultArea"></div>
    </div>
  `;
  document.getElementById("trayW").addEventListener("input", paintTrayResult);
  document.getElementById("trayH").addEventListener("input", paintTrayResult);
  document.getElementById("trayAddBtn").addEventListener("click", () => {
    TRAY_CABLES.push({ count: 1, diameter: 6 });
    paintTrayCables();
  });
  paintTrayCables();
}

function paintTrayCables() {
  const area = document.getElementById("trayCablesArea");
  area.innerHTML = TRAY_CABLES.map((c, i) => `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
      <input type="number" min="0" class="mono" style="width:90px;padding:8px;border:1px solid var(--line);border-radius:6px;" placeholder="数量" value="${c.count}" onchange="updateTrayCable(${i},'count',this.value)">
      <span style="color:var(--text-dim);font-size:12.5px;">根 × 外径</span>
      <input type="number" min="0" step="0.1" class="mono" style="width:90px;padding:8px;border:1px solid var(--line);border-radius:6px;" placeholder="mm" value="${c.diameter}" onchange="updateTrayCable(${i},'diameter',this.value)">
      <span style="color:var(--text-dim);font-size:12.5px;">mm</span>
      ${TRAY_CABLES.length > 1 ? `<button class="btn btn-danger btn-sm" onclick="removeTrayCable(${i})">删除</button>` : ""}
    </div>
  `).join("");
  paintTrayResult();
}
function updateTrayCable(idx, field, val) {
  TRAY_CABLES[idx][field] = parseFloat(val) || 0;
  paintTrayResult();
}
function removeTrayCable(idx) {
  TRAY_CABLES.splice(idx, 1);
  paintTrayCables();
}

function paintTrayResult() {
  const w = parseFloat(document.getElementById("trayW").value) || 0;
  const h = parseFloat(document.getElementById("trayH").value) || 0;
  const trayArea = w * h;
  const cableArea = TRAY_CABLES.reduce((s, c) => s + c.count * ((Math.PI / 4) * c.diameter * c.diameter), 0);
  const fillPct = trayArea > 0 ? (cableArea / trayArea) * 100 : 0;
  const color = fillPct > 40 ? "var(--red)" : fillPct > 30 ? "var(--amber)" : "var(--green)";

  const area = document.getElementById("trayResultArea");
  area.innerHTML = `
    <div class="stat-row" style="margin-top:14px;">
      <div class="stat-box"><div class="v">${fmtNum(trayArea)}</div><div class="l">桥架截面积(mm²)</div></div>
      <div class="stat-box"><div class="v">${fmtNum(cableArea)}</div><div class="l">线缆截面积合计(mm²)</div></div>
      <div class="stat-box" style="background:${fillPct > 40 ? "rgba(192,57,43,0.08)" : "rgba(30,142,90,0.08)"};border-color:${color};">
        <div class="v" style="color:${color}">${fillPct.toFixed(1)}%</div><div class="l">填充率</div>
      </div>
    </div>
    ${progressBar(Math.min(fillPct, 100), color)}
    ${fillPct > 40 ? `<p style="color:var(--red);font-size:13px;margin-top:8px;">⚠ 填充率超过常见的 40% 参考经验值,建议加大桥架规格或分槽敷设。</p>` : ""}
  `;
}

/* ============================================================
   11. 网线传输距离校验
   ============================================================ */
function renderCatCheckTool() {
  const body = document.getElementById("toolboxBody");
  body.innerHTML = `
    <div class="card panel">
      <p style="color:var(--text-dim);font-size:13px;margin:0 0 12px;">以太网双绞线标准最大传输距离为 100 米(含跳线),这个上限对 Cat5e/Cat6/Cat6a 都一样,超出后信号质量会下降甚至无法连通。<b>类别的区别在于能稳定支持的最高速率,而不是距离</b>——具体说明见下方结果。</p>
      <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:500px;">
        <div class="field"><label>网线长度(m)</label><input type="number" id="ccLen" value="95" class="mono"></div>
        <div class="field"><label>网线类别</label>
          <select id="ccCat">
            <option>Cat5e</option><option>Cat6</option><option>Cat6a</option>
          </select>
        </div>
        <div class="field grid1"><label>目标速率</label>
          <select id="ccSpeed">
            <option value="1000">千兆(1000BASE-T)</option>
            <option value="10000">万兆(10GBASE-T)</option>
          </select>
        </div>
      </div>
      <div id="ccResultArea"></div>
    </div>
  `;
  document.getElementById("ccLen").addEventListener("input", paintCatCheckResult);
  document.getElementById("ccCat").addEventListener("change", paintCatCheckResult);
  document.getElementById("ccSpeed").addEventListener("change", paintCatCheckResult);
  paintCatCheckResult();
}

function paintCatCheckResult() {
  const len = parseFloat(document.getElementById("ccLen").value) || 0;
  const cat = document.getElementById("ccCat").value;
  const speed = document.getElementById("ccSpeed").value;
  const area = document.getElementById("ccResultArea");

  // 100 米是所有类别在标准以太网下共同的信道长度上限,这一步跟类别、速率都无关
  let lenStatus, lenColor, lenMsg;
  if (len <= 90) {
    lenStatus = "正常"; lenColor = "var(--green)";
    lenMsg = "长度在安全范围内,标准布线一般没有问题。";
  } else if (len <= 100) {
    lenStatus = "临界"; lenColor = "var(--amber)";
    lenMsg = "接近 100 米上限(含跳线后可能超标),建议尽量压缩配线架/设备跳线长度,或做链路测试确认。";
  } else {
    lenStatus = "超限"; lenColor = "var(--red)";
    lenMsg = "已超过 100 米标准限制,建议改用光纤+光纤收发器、加装交换机中继,或改走 POE 延长器等方案。";
  }

  // 万兆场景下,非增强型 Cat6 在干扰较大的环境中实际稳定距离通常收窄到约 55 米,这是类别真正起作用的地方
  let speedNote = "";
  if (speed === "10000" && len <= 100) {
    if (cat === "Cat6a") {
      speedNote = `<p style="color:var(--green);font-size:13px;margin-top:8px;">Cat6a 屏蔽和串扰控制更好,支持万兆在 100 米全程稳定运行,当前长度没问题。</p>`;
    } else {
      const limit = 55;
      if (len > limit) {
        speedNote = `<p style="color:var(--red);font-size:13px;margin-top:8px;">⚠ ${cat} 跑万兆时,在干扰较大环境下实际稳定距离通常只能到约 ${limit} 米左右(当前 ${fmtNum(len)} 米已超出),建议改用 Cat6a,或降速跑千兆。</p>`;
      } else {
        speedNote = `<p style="color:var(--amber);font-size:13px;margin-top:8px;">${cat} 理论上可以跑万兆,但在干扰较大的环境下建议控制在 ${limit} 米以内才能稳定;如果环境干扰较小或对可靠性要求高,更保险的做法是用 Cat6a。</p>`;
      }
    }
  }

  area.innerHTML = `
    <div class="stat-row" style="margin-top:14px;">
      <div class="stat-box"><div class="v">${fmtNum(len)}</div><div class="l">网线长度(m)</div></div>
      <div class="stat-box"><div class="v">${cat}</div><div class="l">网线类别</div></div>
      <div class="stat-box"><div class="v">${speed === "10000" ? "万兆" : "千兆"}</div><div class="l">目标速率</div></div>
      <div class="stat-box" style="background:rgba(0,0,0,0.02);border-color:${lenColor};">
        <div class="v" style="color:${lenColor}"><span class="tag ${len <= 90 ? "tag-ok" : len <= 100 ? "tag-warn" : "tag-bad"}">${lenStatus}</span></div><div class="l">100米限制判定</div>
      </div>
    </div>
    ${progressBar(Math.min((len / 100) * 100, 100), lenColor)}
    <p style="color:var(--text-dim);font-size:13px;margin-top:8px;">${lenMsg}</p>
    ${speedNote}
  `;
}

/* ============================================================
   12. 摄像头视场角(FOV)估算
   ============================================================ */
const SENSOR_PRESETS = [
  { label: "1/4\"(约3.6×2.7mm)", w: 3.6, h: 2.7 },
  { label: "1/3\"(约4.8×3.6mm)", w: 4.8, h: 3.6 },
  { label: "1/2.8\"(约5.14×3.86mm,常见IPC)", w: 5.14, h: 3.86 },
  { label: "1/2.7\"(约5.37×4.04mm)", w: 5.37, h: 4.04 },
  { label: "1/2\"(约6.4×4.8mm)", w: 6.4, h: 4.8 },
  { label: "1/1.8\"(约7.18×5.32mm)", w: 7.18, h: 5.32 },
  { label: "1\"(约12.8×9.6mm)", w: 12.8, h: 9.6 },
  { label: "自定义", w: null, h: null },
];

function renderFOVTool() {
  const body = document.getElementById("toolboxBody");
  body.innerHTML = `
    <div class="card panel">
      <p style="color:var(--text-dim);font-size:13px;margin:0 0 12px;">按镜头焦距和传感器尺寸估算视场角,以及在指定安装距离下的画面覆盖范围。传感器尺寸为常见近似值,以实际镜头/摄像头厂商参数为准。</p>
      <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:640px;">
        <div class="field"><label>镜头焦距(mm)</label><input type="number" id="fovFocal" value="4" step="0.1" class="mono"></div>
        <div class="field"><label>传感器尺寸</label>
          <select id="fovSensorPreset">
            ${SENSOR_PRESETS.map((s, i) => `<option value="${i}" ${i === 2 ? "selected" : ""}>${s.label}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>传感器宽(mm)</label><input type="number" id="fovSensorW" value="5.14" step="0.01" class="mono"></div>
        <div class="field"><label>传感器高(mm)</label><input type="number" id="fovSensorH" value="3.86" step="0.01" class="mono"></div>
        <div class="field grid1"><label>安装/监视距离(m)</label><input type="number" id="fovDistance" value="10" step="0.1" class="mono"></div>
      </div>
      <div id="fovResultArea"></div>
    </div>
  `;
  document.getElementById("fovSensorPreset").addEventListener("change", (e) => {
    const preset = SENSOR_PRESETS[parseInt(e.target.value)];
    if (preset.w !== null) {
      document.getElementById("fovSensorW").value = preset.w;
      document.getElementById("fovSensorH").value = preset.h;
    }
    paintFOVResult();
  });
  ["fovFocal", "fovSensorW", "fovSensorH", "fovDistance"].forEach((id) => {
    document.getElementById(id).addEventListener("input", paintFOVResult);
  });
  paintFOVResult();
}

function paintFOVResult() {
  const focal = parseFloat(document.getElementById("fovFocal").value) || 0.0001;
  const sw = parseFloat(document.getElementById("fovSensorW").value) || 0;
  const sh = parseFloat(document.getElementById("fovSensorH").value) || 0;
  const distance = parseFloat(document.getElementById("fovDistance").value) || 0;

  const toDeg = (rad) => rad * (180 / Math.PI);
  const fovH = toDeg(2 * Math.atan(sw / (2 * focal)));
  const fovV = toDeg(2 * Math.atan(sh / (2 * focal)));
  const diag = Math.sqrt(sw * sw + sh * sh);
  const fovD = toDeg(2 * Math.atan(diag / (2 * focal)));
  const coverW = 2 * distance * Math.tan((fovH / 2) * (Math.PI / 180));
  const coverH = 2 * distance * Math.tan((fovV / 2) * (Math.PI / 180));

  const area = document.getElementById("fovResultArea");
  area.innerHTML = `
    <div class="stat-row" style="margin-top:14px;">
      <div class="stat-box"><div class="v">${fmtNum(fovH)}°</div><div class="l">水平视场角</div></div>
      <div class="stat-box"><div class="v">${fmtNum(fovV)}°</div><div class="l">垂直视场角</div></div>
      <div class="stat-box"><div class="v">${fmtNum(fovD)}°</div><div class="l">对角视场角</div></div>
    </div>
    <div class="stat-row">
      <div class="stat-box"><div class="v">${fmtNum(coverW)}</div><div class="l">${fmtNum(distance)}m处覆盖宽度(m)</div></div>
      <div class="stat-box"><div class="v">${fmtNum(coverH)}</div><div class="l">${fmtNum(distance)}m处覆盖高度(m)</div></div>
    </div>
  `;
}

/* ============================================================
   13. 线材粗算(网线箱数 / 预留)
   ============================================================ */
function renderCableTool() {
  const body = document.getElementById("toolboxBody");
  body.innerHTML = `
    <div class="card panel">
      <p style="color:var(--text-dim);font-size:13px;margin:0 0 12px;">按点位数量和平均单点距离估算总用线长度和需要采购的箱数(国标网线整箱通常为 305 米/箱)。</p>
      <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:640px;">
        <div class="field"><label>点位数量</label><input type="number" id="cbCount" value="30" class="mono"></div>
        <div class="field"><label>平均单点距离(m)</label><input type="number" id="cbAvgDist" value="25" step="0.5" class="mono"></div>
        <div class="field"><label>预留系数(%)</label><input type="number" id="cbReserve" value="10" step="1" class="mono"></div>
        <div class="field"><label>每箱线长(m)</label><input type="number" id="cbBoxLen" value="305" class="mono"></div>
      </div>
      <div id="cbResultArea"></div>
    </div>
  `;
  ["cbCount", "cbAvgDist", "cbReserve", "cbBoxLen"].forEach((id) => {
    document.getElementById(id).addEventListener("input", paintCableResult);
  });
  paintCableResult();
}

function paintCableResult() {
  const count = parseFloat(document.getElementById("cbCount").value) || 0;
  const avgDist = parseFloat(document.getElementById("cbAvgDist").value) || 0;
  const reservePct = parseFloat(document.getElementById("cbReserve").value) || 0;
  const boxLen = parseFloat(document.getElementById("cbBoxLen").value) || 1;

  const rawTotal = count * avgDist;
  const totalWithReserve = rawTotal * (1 + reservePct / 100);
  const boxCount = Math.ceil(totalWithReserve / boxLen);

  const area = document.getElementById("cbResultArea");
  area.innerHTML = `
    <div class="stat-row" style="margin-top:14px;">
      <div class="stat-box"><div class="v">${fmtNum(rawTotal)}</div><div class="l">基础用线量(m)</div></div>
      <div class="stat-box"><div class="v">${fmtNum(totalWithReserve)}</div><div class="l">含预留总用线量(m)</div></div>
      <div class="stat-box" style="background:rgba(15,155,176,0.08);border-color:var(--cyan);">
        <div class="v" style="color:var(--cyan)">${boxCount}</div><div class="l">建议采购箱数</div>
      </div>
    </div>
  `;
}

/* ============================================================
   14. 密码生成(设备激活强密码)
   ============================================================ */
function genPassword(length, useUpper, useLower, useDigit, useSymbol) {
  let chars = "";
  if (useUpper) chars += "ABCDEFGHJKLMNPQRSTUVWXYZ"; // 去掉易混淆的 I O
  if (useLower) chars += "abcdefghijkmnpqrstuvwxyz"; // 去掉易混淆的 l o
  if (useDigit) chars += "23456789"; // 去掉易混淆的 0 1
  if (useSymbol) chars += "!@#$%^&*-_=+";
  if (!chars) return "";
  const arr = new Uint32Array(length);
  (window.crypto || window.msCrypto).getRandomValues(arr);
  let pw = "";
  for (let i = 0; i < length; i++) pw += chars[arr[i] % chars.length];
  return pw;
}

function renderPasswordTool() {
  const body = document.getElementById("toolboxBody");
  body.innerHTML = `
    <div class="card panel">
      <p style="color:var(--text-dim);font-size:13px;margin:0 0 12px;">生成设备激活/初始化用的随机强密码(已排除易混淆字符如 0/O、1/l/I)。</p>
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;">
        <label style="font-size:13px;color:var(--text-dim);">长度</label>
        <input type="number" id="pwLen" value="12" min="4" max="64" class="mono" style="width:80px;padding:8px;border:1px solid var(--line);border-radius:6px;">
        <label class="checkline"><input type="checkbox" id="pwUpper" checked> 大写字母</label>
        <label class="checkline"><input type="checkbox" id="pwLower" checked> 小写字母</label>
        <label class="checkline"><input type="checkbox" id="pwDigit" checked> 数字</label>
        <label class="checkline"><input type="checkbox" id="pwSymbol"> 特殊符号</label>
      </div>
      <div style="margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" id="pwGenBtn">生成密码</button>
        <label style="font-size:13px;color:var(--text-dim);">批量生成</label>
        <input type="number" id="pwBatch" value="1" min="1" max="50" class="mono" style="width:70px;padding:8px;border:1px solid var(--line);border-radius:6px;">
        <span style="font-size:13px;color:var(--text-dim);">个</span>
      </div>
      <div id="pwResultArea" style="margin-top:16px;"></div>
    </div>
  `;
  document.getElementById("pwGenBtn").addEventListener("click", paintPasswordResult);
  paintPasswordResult();
}

function paintPasswordResult() {
  const length = parseInt(document.getElementById("pwLen").value) || 12;
  const upper = document.getElementById("pwUpper").checked;
  const lower = document.getElementById("pwLower").checked;
  const digit = document.getElementById("pwDigit").checked;
  const symbol = document.getElementById("pwSymbol").checked;
  const batch = Math.max(1, Math.min(50, parseInt(document.getElementById("pwBatch").value) || 1));

  const area = document.getElementById("pwResultArea");
  if (!upper && !lower && !digit && !symbol) {
    area.innerHTML = `<p style="color:var(--red);font-size:13px;">请至少勾选一种字符类型</p>`;
    return;
  }
  const pwds = [];
  for (let i = 0; i < batch; i++) pwds.push(genPassword(length, upper, lower, digit, symbol));

  area.innerHTML = pwds.map((pw) => `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
      <span class="mono" style="font-size:15px;background:var(--paper);padding:8px 12px;border-radius:6px;border:1px solid var(--line);flex:1;max-width:320px;">${escapeHTML(pw)}</span>
      <button class="btn btn-outline btn-sm" onclick="copyText('${pw.replace(/'/g, "\\'")}')">复制</button>
    </div>
  `).join("");
}

/* ============================================================
   15. RTSP编码(特殊字符URL编码)
   ============================================================ */
function renderRTSPTool() {
  const body = document.getElementById("toolboxBody");
  body.innerHTML = `
    <div class="card panel">
      <p style="color:var(--text-dim);font-size:13px;margin:0 0 12px;">账号或密码中含有 @ : / 等特殊字符时,直接拼在 RTSP 地址里会导致解析错误,需要做 URL 编码。</p>
      <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:640px;">
        <div class="field"><label>用户名</label><input type="text" id="rtUser" value="admin"></div>
        <div class="field"><label>密码</label><input type="text" id="rtPass" value="P@ss:word/1"></div>
        <div class="field"><label>设备IP</label><input type="text" id="rtIp" class="mono" value="192.168.1.64"></div>
        <div class="field"><label>端口</label><input type="text" id="rtPort" class="mono" value="554"></div>
        <div class="field grid1"><label>路径(不含开头斜杠)</label><input type="text" id="rtPath" class="mono" value="Streaming/Channels/101"></div>
      </div>
      <div id="rtResultArea"></div>
    </div>
    <div class="card panel" style="margin-top:16px;">
      <b style="font-size:14px;">反向解码</b>
      <p style="color:var(--text-dim);font-size:12.5px;margin:6px 0 10px;">粘贴一个已编码的字符串,还原成原始内容(用于核对)。</p>
      <input type="text" id="rtDecodeInput" class="mono" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;" placeholder="P%40ss%3Aword%2F1">
      <div id="rtDecodeResult" style="margin-top:10px;"></div>
    </div>
  `;
  ["rtUser", "rtPass", "rtIp", "rtPort", "rtPath"].forEach((id) => {
    document.getElementById(id).addEventListener("input", paintRTSPResult);
  });
  document.getElementById("rtDecodeInput").addEventListener("input", paintRTSPDecodeResult);
  paintRTSPResult();
}

function paintRTSPResult() {
  const user = document.getElementById("rtUser").value;
  const pass = document.getElementById("rtPass").value;
  const ip = document.getElementById("rtIp").value.trim();
  const port = document.getElementById("rtPort").value.trim();
  const path = document.getElementById("rtPath").value.trim();

  const encUser = encodeURIComponent(user);
  const encPass = encodeURIComponent(pass);
  const url = `rtsp://${encUser}:${encPass}@${ip}${port ? ":" + port : ""}/${path}`;

  const area = document.getElementById("rtResultArea");
  area.innerHTML = `
    <div style="margin-top:14px;">
      <label style="font-size:13px;color:var(--text-dim);display:block;margin-bottom:6px;">编码后的用户名 / 密码</label>
      <div style="display:flex;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
        <span class="mono" style="background:var(--paper);padding:6px 10px;border-radius:6px;border:1px solid var(--line);">${escapeHTML(encUser)}</span>
        <span class="mono" style="background:var(--paper);padding:6px 10px;border-radius:6px;border:1px solid var(--line);">${escapeHTML(encPass)}</span>
      </div>
      <label style="font-size:13px;color:var(--text-dim);display:block;margin:12px 0 6px;">完整 RTSP 地址</label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <span class="mono" style="background:var(--paper);padding:8px 12px;border-radius:6px;border:1px solid var(--line);flex:1;word-break:break-all;">${escapeHTML(url)}</span>
        <button class="btn btn-outline btn-sm" onclick="copyText('${url.replace(/'/g, "\\'")}')">复制</button>
      </div>
    </div>
  `;
}

function paintRTSPDecodeResult() {
  const input = document.getElementById("rtDecodeInput").value;
  const area = document.getElementById("rtDecodeResult");
  if (!input) { area.innerHTML = ""; return; }
  try {
    const decoded = decodeURIComponent(input);
    area.innerHTML = `<span class="mono" style="background:var(--paper);padding:8px 12px;border-radius:6px;border:1px solid var(--line);display:inline-block;">${escapeHTML(decoded)}</span>`;
  } catch (e) {
    area.innerHTML = `<span style="color:var(--red);font-size:13px;">解码失败,格式不正确</span>`;
  }
}
