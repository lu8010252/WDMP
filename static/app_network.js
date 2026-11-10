/* ============================================================
   模块:交换机与网络划分
   ============================================================ */
let SW_CACHE = [];
let SW_PAGE = 1, SW_PAGE_SIZE = 10;
const NET_TYPE_DEFAULTS = ["内网", "外网", "监控专网"];

async function renderNetworkView() {
  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="page-head">
      <h1>网络与交换机</h1>
      <span class="sub">交换机及端口网络属性划分(可清空、也可自定义填写,不限于内网/外网/监控专网)</span>
    </div>
    <div class="toolbar">
      ${projectSelectHTML("swProjectSel")}
      <div class="fill"></div>
      ${hasPerm("network") ? `<button class="btn btn-cyan btn-sm" id="swAddBtn">+ 新增交换机</button>` : `<span style="color:var(--text-dim);font-size:12.5px;">只读模式,如需新增/编辑请联系管理员授权</span>`}
    </div>
    <div id="swList"></div>
    <div id="swPager"></div>
  `;
  bindProjectSelect("swProjectSel", loadSwitches);
  if (hasPerm("network")) {
    document.getElementById("swAddBtn").addEventListener("click", () => openSwitchForm(null));
  }
  await loadSwitches();
}

async function loadSwitches() {
  SW_PAGE = 1;
  if (!CUR_PROJECT) { SW_CACHE = []; paintSwitchList(); return; }
  SW_CACHE = await api("/switches?project_id=" + CUR_PROJECT);
  paintSwitchList();
}

// netTypeSuggestions 汇总默认的三个建议值 + 当前项目里已经用过的自定义值,供下拉建议使用
function netTypeSuggestions() {
  const used = new Set(NET_TYPE_DEFAULTS);
  SW_CACHE.forEach((sw) => { if (sw.network_type) used.add(sw.network_type); });
  return Array.from(used);
}

function netTag(t) {
  const map = { "内网": "tag-ok", "外网": "tag-bad", "监控专网": "tag-warn" };
  return `<span class="tag ${map[t] || "tag-idle"}">${escapeHTML(t || "未设置")}</span>`;
}

function paintSwitchList() {
  const el = document.getElementById("swList");
  if (!SW_CACHE.length) {
    el.innerHTML = `<div class="empty-state"><div class="big">&#128375;</div>当前项目暂无交换机记录</div>`;
    document.getElementById("swPager").innerHTML = "";
    return;
  }
  SW_PAGE = clampPage(SW_PAGE, SW_CACHE.length, SW_PAGE_SIZE);
  const pageRows = paginate(SW_CACHE, SW_PAGE, SW_PAGE_SIZE);
  el.innerHTML = pageRows.map((sw) => `
    <div class="card panel">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <b style="font-size:15px;">${escapeHTML(sw.name)}</b>
        ${netTag(sw.network_type)}
        <span class="mono" style="color:var(--text-dim);font-size:12.5px;">${escapeHTML(sw.manage_ip)} · ${escapeHTML(sw.location)} · ${sw.port_count}口</span>
        <div class="fill"></div>
        <button class="btn btn-outline btn-sm" onclick="togglePorts(${sw.id})">端口详情</button>
        ${hasPerm("network") ? `<button class="btn btn-outline btn-sm" onclick="openSwitchForm(${sw.id})">编辑</button>` : ""}
        ${ME.role === "admin" ? `<button class="btn btn-danger btn-sm" onclick="deleteSwitchRow(${sw.id})">删除</button>` : ""}
      </div>
      <div id="ports-${sw.id}" style="display:none;"></div>
    </div>
  `).join("");
  renderPager("swPager", SW_CACHE.length, SW_PAGE, SW_PAGE_SIZE,
    (p) => { SW_PAGE = p; paintSwitchList(); },
    (sz) => { SW_PAGE_SIZE = sz; SW_PAGE = 1; paintSwitchList(); });
}

async function togglePorts(id) {
  const el = document.getElementById("ports-" + id);
  if (el.style.display === "block") { el.style.display = "none"; return; }
  el.style.display = "block";
  el.innerHTML = `<div style="padding:10px;color:var(--text-dim);">加载中...</div>`;
  const ports = await api("/switches/" + id + "/ports");
  const suggestions = netTypeSuggestions();
  el.innerHTML = `
    <datalist id="portNetSuggestions-${id}">${suggestions.map((t) => `<option value="${escapeHTML(t)}">`).join("")}</datalist>
    <div class="port-grid">
      ${ports.map((p) => `
        <div class="port-cell">
          <div class="pn">端口 ${p.port_no}</div>
          <input data-port="${p.port_no}" class="port-net" list="portNetSuggestions-${id}" placeholder="网络属性(可留空)" value="${escapeHTML(p.network_type || "")}" ${hasPerm("network") ? "" : "disabled"}>
          <input class="port-dev" data-port="${p.port_no}" placeholder="连接设备" value="${escapeHTML(p.connected_device || "")}" ${hasPerm("network") ? "" : "disabled"}>
        </div>
      `).join("")}
    </div>
    ${hasPerm("network") ? `<div style="margin-top:12px;"><button class="btn btn-primary btn-sm" onclick="savePorts(${id})">保存端口设置</button></div>` : ""}
  `;
}

async function savePorts(swId) {
  const container = document.getElementById("ports-" + swId);
  const nets = container.querySelectorAll(".port-net");
  const devs = container.querySelectorAll(".port-dev");
  const portData = [];
  nets.forEach((input, i) => {
    portData.push({
      port_no: parseInt(input.dataset.port),
      network_type: input.value.trim(),
      connected_device: devs[i].value.trim(),
    });
  });
  try {
    await apiJSON("/switches/" + swId + "/ports", "PUT", portData);
    toast("端口设置已保存");
  } catch (e) {}
}

function openSwitchForm(id) {
  const row = id ? SW_CACHE.find((s) => s.id === id) : null;
  const projectLabel = (PROJECTS.find((p) => p.id === CUR_PROJECT) || {}).name || "";
  const suggestions = netTypeSuggestions();
  openModal(`
    <h2>${id ? "编辑交换机" : "新增交换机"}</h2>
    <div class="grid2">
      <div class="field grid1"><label>所属项目</label>
        <input value="${escapeHTML(projectLabel)}" disabled style="background:var(--paper);color:var(--text-dim);">
      </div>
      <div class="field"><label>交换机名称 *</label><input id="fName" value="${escapeHTML(row?.name || "")}"></div>
      <div class="field"><label>安装位置</label><input id="fLocation" value="${escapeHTML(row?.location || "")}"></div>
      <div class="field"><label>管理IP</label><input id="fIp" class="mono" value="${escapeHTML(row?.manage_ip || "")}"></div>
      <div class="field"><label>网络属性</label>
        <input id="fNetType" list="swNetSuggestions" placeholder="可留空,或自定义填写" value="${escapeHTML(row?.network_type || "")}">
        <datalist id="swNetSuggestions">${suggestions.map((t) => `<option value="${escapeHTML(t)}">`).join("")}</datalist>
      </div>
      ${!id ? `<div class="field"><label>端口数量</label><input id="fPortCount" type="number" value="24"></div>` : ""}
      <div class="field grid1"><label>备注</label><input id="fRemark" value="${escapeHTML(row?.remark || "")}"></div>
    </div>
    ${!CUR_PROJECT ? `<p style="color:var(--red);font-size:12.5px;">请先在顶部选择所属项目</p>` : ""}
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="swSaveBtn">保存</button>
    </div>
  `);
  bindSubmitOnce(document.getElementById("swSaveBtn"), async () => {
    const data = {
      project_id: CUR_PROJECT,
      name: document.getElementById("fName").value.trim(),
      location: document.getElementById("fLocation").value.trim(),
      manage_ip: document.getElementById("fIp").value.trim(),
      network_type: document.getElementById("fNetType").value.trim(),
      remark: document.getElementById("fRemark").value.trim(),
    };
    if (!id) data.port_count = parseInt(document.getElementById("fPortCount").value) || 24;
    if (!CUR_PROJECT) { toast("请先选择所属项目", "err"); return; }
    if (!data.name) { toast("交换机名称不能为空", "err"); return; }
    try {
      if (id) await apiJSON("/switches/" + id, "PUT", data);
      else await apiJSON("/switches", "POST", data);
      toast("保存成功");
      closeModal();
      loadSwitches();
    } catch (e) {}
  });
}

async function deleteSwitchRow(id) {
  if (!confirm("确认删除该交换机及其端口配置?此操作将记录在修改日志中。")) return;
  try {
    await api("/switches/" + id, { method: "DELETE" });
    toast("已删除");
    loadSwitches();
  } catch (e) {}
}
