/* ============================================================
   模块:核心设备与密码本
   ============================================================ */
let VAULT_CACHE = [];
let VAULT_PAGE = 1, VAULT_PAGE_SIZE = 20;
const VAULT_TYPE_DEFAULTS = ["NVR", "服务器", "门禁主机", "防火墙"];

// vaultTypeSuggestions 汇总默认建议值 + 当前项目里已经用过的自定义类型,供下拉建议使用
function vaultTypeSuggestions() {
  const used = new Set(VAULT_TYPE_DEFAULTS);
  VAULT_CACHE.forEach((d) => { if (d.type) used.add(d.type); });
  return Array.from(used);
}

async function renderVaultView() {
  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="page-head">
      <h1>核心密码本</h1>
      <span class="sub">NVR · 服务器 · 门禁主机 · 防火墙集中管理(密码加密存储,按项目区分)</span>
    </div>
    <div class="toolbar">
      ${projectSelectHTML("vaultProjectSel")}
      <div class="fill"></div>
      <button class="btn btn-cyan btn-sm" id="vaultAddBtn">+ 新增核心设备</button>
    </div>
    <div id="vaultTableWrap"></div>
    <div id="vaultPager"></div>
  `;
  bindProjectSelect("vaultProjectSel", loadVault);
  document.getElementById("vaultAddBtn").addEventListener("click", () => openVaultForm(null));
  await loadVault();
}

async function loadVault() {
  VAULT_PAGE = 1;
  if (!CUR_PROJECT) { VAULT_CACHE = []; paintVaultTable(); return; }
  VAULT_CACHE = await api("/vault?project_id=" + CUR_PROJECT);
  paintVaultTable();
}

function paintVaultTable() {
  const wrap = document.getElementById("vaultTableWrap");
  if (!VAULT_CACHE.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="big">&#128274;</div>当前项目暂无核心设备记录</div>`;
    document.getElementById("vaultPager").innerHTML = "";
    return;
  }
  VAULT_PAGE = clampPage(VAULT_PAGE, VAULT_CACHE.length, VAULT_PAGE_SIZE);
  const pageRows = paginate(VAULT_CACHE, VAULT_PAGE, VAULT_PAGE_SIZE);
  wrap.innerHTML = `
    <div class="table-wrap"><table class="data" id="vaultTable">
    <thead><tr>
      <th>设备名称</th><th>类型</th><th>管理IP/地址</th><th>账号</th><th>密码</th><th>维保/备注</th><th>更新</th><th></th>
    </tr></thead>
    <tbody>
      ${pageRows.map((d) => `
        <tr>
          <td><b>${escapeHTML(d.name)}</b></td>
          <td>${escapeHTML(d.type)}</td>
          <td class="mono">${escapeHTML(d.manage_addr)}</td>
          <td class="mono">${escapeHTML(d.account)}</td>
          <td>
            <span class="pw-mask" id="pwmask-${d.id}">••••••••</span>
            <button class="copy-btn" onclick="revealAndCopy(${d.id})">一键复制</button>
          </td>
          <td class="remark">${escapeHTML(d.remark)}</td>
          <td class="mono" style="font-size:11px;color:var(--text-dim)">${escapeHTML(d.updated_by)}<br>${escapeHTML(d.updated_at)}</td>
          <td>
            <button class="btn btn-outline btn-sm" onclick="openVaultForm(${d.id})">编辑</button>
            ${ME.role === "admin" ? `<button class="btn btn-danger btn-sm" onclick="deleteVaultRow(${d.id})">删除</button>` : ""}
          </td>
        </tr>
      `).join("")}
    </tbody>
    </table></div>
  `;
  renderPager("vaultPager", VAULT_CACHE.length, VAULT_PAGE, VAULT_PAGE_SIZE,
    (p) => { VAULT_PAGE = p; paintVaultTable(); },
    (sz) => { VAULT_PAGE_SIZE = sz; VAULT_PAGE = 1; paintVaultTable(); });
}

async function revealAndCopy(id) {
  try {
    const r = await api("/vault/" + id + "/reveal");
    const maskEl = document.getElementById("pwmask-" + id);
    maskEl.textContent = r.password || "(空)";
    setTimeout(() => { maskEl.textContent = "••••••••"; }, 8000);
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(r.password || "");
      toast("密码已复制到剪贴板(8秒后自动隐藏)");
    } else {
      toast("已显示密码(请手动复制,8秒后自动隐藏)");
    }
  } catch (e) {}
}

async function openVaultForm(id) {
  const row = id ? VAULT_CACHE.find((d) => d.id === id) : null;
  const projectLabel = (PROJECTS.find((p) => p.id === CUR_PROJECT) || {}).name || "";
  const suggestions = vaultTypeSuggestions();
  // 密码本条目可以"绑定"一台已安装的设备(设备台账里的记录),绑定后名称/类型/管理IP
  // 会一直跟着设备台账走(设备那边改了分类/位置/IP,这里自动同步),不用手动录入、也不容易和实际设备对不上。
  let devices = [];
  if (CUR_PROJECT) {
    try { devices = await api("/devices?project_id=" + CUR_PROJECT); } catch (e) { devices = []; }
  }
  const deviceLabel = (d) => `${d.category || "(未分类)"} - ${d.location || "无位置"}${d.model ? " - " + d.model : ""}${d.ip ? " (" + d.ip + ")" : ""}`;
  const useDeviceMode = row ? !!row.device_id : devices.length > 0;

  openModal(`
    <h2>${id ? "编辑核心设备" : "新增核心设备"}</h2>
    <div class="field grid1"><label>所属项目</label>
      <input value="${escapeHTML(projectLabel)}" disabled style="background:var(--paper);color:var(--text-dim);">
    </div>
    <div class="field grid1">
      <label>名称来源</label>
      <div style="display:flex;gap:16px;font-size:13.5px;padding:4px 0;">
        <label style="display:flex;align-items:center;gap:6px;"><input type="radio" name="fNameSource" value="device" ${useDeviceMode ? "checked" : ""} ${!devices.length ? "disabled" : ""}>从已安装设备里选</label>
        <label style="display:flex;align-items:center;gap:6px;"><input type="radio" name="fNameSource" value="manual" ${!useDeviceMode ? "checked" : ""}>手动填写</label>
      </div>
      ${!devices.length ? `<p style="color:var(--text-dim);font-size:12px;">当前项目下设备台账暂无记录,只能手动填写</p>` : ""}
    </div>
    <div id="fDeviceWrap" class="field grid1" style="${useDeviceMode ? "" : "display:none;"}">
      <label>选择设备</label>
      <select id="fDeviceSel">
        <option value="">请选择...</option>
        ${devices.map((d) => `<option value="${d.id}" ${row && row.device_id === d.id ? "selected" : ""}>${escapeHTML(deviceLabel(d))}</option>`).join("")}
      </select>
    </div>
    <div id="fManualWrap" class="grid2" style="${useDeviceMode ? "display:none;" : ""}">
      <div class="field"><label>设备名称 *</label><input id="fName" value="${escapeHTML(row?.name || "")}"></div>
      <div class="field"><label>设备类型</label>
        <input id="fType" list="vaultTypeSuggestions" placeholder="可留空,或自定义填写" value="${escapeHTML(row?.type || "")}">
        <datalist id="vaultTypeSuggestions">${suggestions.map((t) => `<option value="${escapeHTML(t)}">`).join("")}</datalist>
      </div>
      <div class="field grid1"><label>管理IP/访问地址</label><input id="fAddr" class="mono" value="${escapeHTML(row?.manage_addr || "")}"></div>
    </div>
    <div class="grid2" style="margin-top:10px;">
      <div class="field"><label>登录账号</label><input id="fAccount" value="${escapeHTML(row?.account || "")}"></div>
      <div class="field grid1"><label>登录密码 ${id ? "(留空表示不修改)" : ""}</label><input id="fPassword" type="text" class="mono" placeholder="${id ? "不修改请留空" : ""}"></div>
      <div class="field grid1"><label>维保/备注</label><input id="fRemark" value="${escapeHTML(row?.remark || "")}"></div>
    </div>
    ${!CUR_PROJECT ? `<p style="color:var(--red);font-size:12.5px;">请先在顶部选择所属项目</p>` : ""}
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="vaultSaveBtn">保存</button>
    </div>
  `);
  const radios = document.querySelectorAll('input[name="fNameSource"]');
  const deviceWrap = document.getElementById("fDeviceWrap");
  const manualWrap = document.getElementById("fManualWrap");
  radios.forEach((rad) => rad.addEventListener("change", () => {
    const isDevice = document.querySelector('input[name="fNameSource"]:checked').value === "device";
    deviceWrap.style.display = isDevice ? "" : "none";
    manualWrap.style.display = isDevice ? "none" : "";
  }));
  bindSubmitOnce(document.getElementById("vaultSaveBtn"), async () => {
    const source = document.querySelector('input[name="fNameSource"]:checked')?.value || "manual";
    const data = {
      project_id: CUR_PROJECT,
      device_id: 0,
      name: "",
      type: "",
      manage_addr: "",
      account: document.getElementById("fAccount").value.trim(),
      password: document.getElementById("fPassword").value,
      remark: document.getElementById("fRemark").value.trim(),
    };
    if (source === "device") {
      const devID = parseInt(document.getElementById("fDeviceSel").value);
      if (!devID) { toast("请选择一台已安装设备", "err"); return; }
      data.device_id = devID;
    } else {
      data.name = document.getElementById("fName").value.trim();
      data.type = document.getElementById("fType").value.trim();
      data.manage_addr = document.getElementById("fAddr").value.trim();
      if (!data.name) { toast("设备名称不能为空", "err"); return; }
    }
    if (!CUR_PROJECT) { toast("请先选择所属项目", "err"); return; }
    try {
      if (id) await apiJSON("/vault/" + id, "PUT", data);
      else await apiJSON("/vault", "POST", data);
      toast("保存成功");
      closeModal();
      loadVault();
    } catch (e) {}
  });
}

async function deleteVaultRow(id) {
  if (!confirm("确认删除该核心设备记录?此操作将记录在修改日志中。")) return;
  try {
    await api("/vault/" + id, { method: "DELETE" });
    toast("已删除");
    loadVault();
  } catch (e) {}
}
