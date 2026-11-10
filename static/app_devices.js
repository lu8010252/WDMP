/* ============================================================
   模块:终端设备点位台账
   ============================================================ */
let DEV_CACHE = [];
let DEV_SELECTED = new Set();
let DEV_PAGE = 1, DEV_PAGE_SIZE = 20;
let DEV_SORT = ""; // "" = 默认(最新录入在前) / "location" / "model" / "ip"

async function renderDevicesView() {
  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="page-head">
      <h1>终端设备点位台账</h1>
      <span class="sub">摄像机 · 无线AP · 广播音响 · 门禁一体机(逐台录入,含IP/机柜/照片)</span>
    </div>
    <div class="toolbar">
      ${projectSelectHTML("devProjectSel")}
      ${mainCategorySelectHTML("devCatFilter", null)}
      ${subCategorySelectHTML("devSubFilter", 0, null)}
      <select id="devStatusFilter">
        <option value="">全部状态</option>
        <option>未安装</option><option>已安装</option><option>已调试</option><option>施工异常</option>
      </select>
      <select id="devSortSel">
        <option value="">默认排序(最新录入在前)</option>
        <option value="location">按位置排序</option>
        <option value="model">按型号排序</option>
        <option value="ip">按IP地址排序</option>
      </select>
      <input type="text" class="grow" id="devKwFilter" placeholder="搜索位置/型号/IP/机柜">
      <div class="fill"></div>
      <button class="btn btn-outline btn-sm" id="devExportBtn">导出Excel</button>
      ${hasPerm("devices") ? `
      <label class="btn btn-outline btn-sm" style="margin:0">
        导入Excel<input type="file" id="devImportFile" accept=".xlsx" style="display:none">
      </label>
      ` : ""}
      <button class="btn btn-outline btn-sm" id="devLabelBtn">批量打印标签(<span id="devSelCount">0</span>)</button>
      ${hasPerm("devices") ? `<button class="btn btn-cyan btn-sm" id="devAddBtn">+ 新增设备</button>` : `<span style="color:var(--text-dim);font-size:12.5px;">只读模式</span>`}
    </div>
    <div id="devBatchBar" style="display:none;"></div>
    <div id="devListArea"></div>
  `;
  bindProjectSelect("devProjectSel", loadDevices);
  document.getElementById("devCatFilter").addEventListener("change", (e) => {
    document.getElementById("devSubFilter").outerHTML = subCategorySelectHTML("devSubFilter", e.target.value, null);
    document.getElementById("devSubFilter").addEventListener("change", loadDevices);
    loadDevices();
  });
  ["devSubFilter", "devStatusFilter"].forEach((id) => document.getElementById(id).addEventListener("change", loadDevices));
  document.getElementById("devSortSel").addEventListener("change", (e) => {
    DEV_SORT = e.target.value;
    DEV_PAGE = 1;
    paintDeviceTable();
  });
  let kwTimer;
  document.getElementById("devKwFilter").addEventListener("input", () => {
    clearTimeout(kwTimer);
    kwTimer = setTimeout(loadDevices, 300);
  });
  document.getElementById("devExportBtn").addEventListener("click", () => {
    window.location = API + "/export/devices?project_id=" + (CUR_PROJECT || 0);
  });
  document.getElementById("devLabelBtn").addEventListener("click", printDeviceLabels);
  if (hasPerm("devices")) {
    document.getElementById("devAddBtn").addEventListener("click", () => openDeviceForm(null));
    document.getElementById("devImportFile").addEventListener("change", async (e) => {
    if (!e.target.files.length) return;
    if (!CUR_PROJECT) { toast("请先选择所属项目", "err"); e.target.value = ""; return; }
    const file = e.target.files[0];
    e.target.value = "";
    const mode = await chooseImportMode("设备台账");
    if (!mode) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await api("/import/devices?project_id=" + CUR_PROJECT + "&mode=" + mode, { method: "POST", body: fd });
      toast(`成功导入 ${r.imported} 条记录(${mode === "overwrite" ? "覆盖导入" : "追加导入"})`);
      await loadCategories();
      loadDevices();
    } catch (err) {}
    });
  }
  DEV_SELECTED.clear();
  await loadDevices();
}

async function loadDevices() {
  if (!CUR_PROJECT) { DEV_CACHE = []; paintDeviceTable(); return; }
  const catId = document.getElementById("devCatFilter")?.value || "";
  const subId = document.getElementById("devSubFilter")?.value || "";
  const status = document.getElementById("devStatusFilter")?.value || "";
  const kw = document.getElementById("devKwFilter")?.value.trim() || "";
  const qs = new URLSearchParams({ project_id: CUR_PROJECT });
  if (catId) qs.set("category_id", catId);
  if (subId) qs.set("sub_category_id", subId);
  if (status) qs.set("status", status);
  if (kw) qs.set("q", kw);
  DEV_CACHE = await api("/devices?" + qs.toString());
  DEV_PAGE = 1;
  paintDeviceTable();
}

// compareIP 按IP各段数值大小比较,不能直接用字符串比较(否则"10.0.0.9"会排在"10.0.0.10"后面)
function compareIP(a, b) {
  const pa = (a || "").split(".").map(Number);
  const pb = (b || "").split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function sortedDevices() {
  if (!DEV_SORT) return DEV_CACHE;
  const list = [...DEV_CACHE];
  list.sort((a, b) => {
    if (DEV_SORT === "ip") return compareIP(a.ip, b.ip);
    return (a[DEV_SORT] || "").localeCompare(b[DEV_SORT] || "", "zh");
  });
  return list;
}

function paintDeviceTable() {
  const area = document.getElementById("devListArea");
  if (!DEV_CACHE.length) {
    area.innerHTML = `<div class="empty-state"><div class="big">&#128225;</div>暂无设备点位数据,请先新增或导入Excel</div>`;
    updateBatchBar();
    return;
  }
  const all = sortedDevices();
  DEV_PAGE = clampPage(DEV_PAGE, all.length, DEV_PAGE_SIZE);
  const visible = paginate(all, DEV_PAGE, DEV_PAGE_SIZE);

  area.innerHTML = `
    <div class="table-wrap"><table class="data" id="devTable">
      <thead><tr>
        <th><input type="checkbox" id="devSelectAll"></th>
        <th>照片</th><th>分类</th><th>位置</th><th>型号</th><th>机柜</th>
        <th>IP地址</th><th>状态</th><th></th>
      </tr></thead>
      <tbody>
        ${visible.map((d) => `
          <tr>
            <td><input type="checkbox" class="dev-check" data-id="${d.id}" ${DEV_SELECTED.has(d.id) ? "checked" : ""}></td>
            <td>${d.photo_path ? `<img class="thumb" src="${d.photo_path}" onclick="window.open('${d.photo_path}')">` : (hasPerm("devices") ? `<label class="btn btn-outline btn-sm" style="margin:0"><input type="file" accept="image/*" capture="environment" style="display:none" onchange="uploadPhoto(${d.id}, this)">拍照</label>` : `<span style="color:var(--text-dim);font-size:12px;">无照片</span>`)}</td>
            <td>${escapeHTML(d.category)}</td>
            <td>${escapeHTML(d.location)}</td>
            <td>${escapeHTML(d.model)}</td>
            <td>${escapeHTML(d.cabinet)}</td>
            <td class="mono">${escapeHTML(d.ip)}</td>
            <td>${statusTag(d.status)}</td>
            <td>
              <button class="btn btn-outline btn-sm" onclick="openDeviceCheckin(${d.id})">核验</button>
              ${hasPerm("devices") ? `<button class="btn btn-outline btn-sm" onclick="openDeviceForm(${d.id})">编辑</button>` : ""}
              ${ME.role === "admin" ? `<button class="btn btn-danger btn-sm" onclick="deleteDeviceRow(${d.id})">删除</button>` : ""}
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table></div>
    <div id="devPager"></div>
  `;
  renderPager("devPager", all.length, DEV_PAGE, DEV_PAGE_SIZE,
    (p) => { DEV_PAGE = p; paintDeviceTable(); },
    (sz) => { DEV_PAGE_SIZE = sz; DEV_PAGE = 1; paintDeviceTable(); });
  document.getElementById("devSelectAll").addEventListener("change", (e) => {
    document.querySelectorAll(".dev-check").forEach((cb) => {
      cb.checked = e.target.checked;
      const id = parseInt(cb.dataset.id);
      if (e.target.checked) DEV_SELECTED.add(id); else DEV_SELECTED.delete(id);
    });
    onDevSelectionChange();
  });
  document.querySelectorAll(".dev-check").forEach((cb) => {
    cb.addEventListener("change", () => {
      const id = parseInt(cb.dataset.id);
      if (cb.checked) DEV_SELECTED.add(id); else DEV_SELECTED.delete(id);
      onDevSelectionChange();
    });
  });
  onDevSelectionChange();
}

function onDevSelectionChange() {
  document.getElementById("devSelCount").textContent = DEV_SELECTED.size;
  updateBatchBar();
}

/* ---------------- 批量操作条:批量改状态 / 批量删除 ---------------- */
function updateBatchBar() {
  const bar = document.getElementById("devBatchBar");
  if (!bar) return;
  if (!DEV_SELECTED.size) {
    bar.style.display = "none";
    bar.innerHTML = "";
    return;
  }
  bar.style.display = "flex";
  bar.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:10px 14px;margin-bottom:12px;";
  bar.innerHTML = `
    <b style="color:var(--ink);">已选中 ${DEV_SELECTED.size} 台设备</b>
    ${hasPerm("devices") ? `
    <select id="batchStatusSel">
      <option>未安装</option><option>已安装</option><option>已调试</option><option>施工异常</option>
    </select>
    <button class="btn btn-outline btn-sm" id="batchStatusBtn">批量设为该状态</button>
    ` : ""}
    <div class="fill"></div>
    ${ME.role === "admin" ? `<button class="btn btn-danger btn-sm" id="batchDeleteBtn">批量删除</button>` : ""}
    <button class="btn btn-outline btn-sm" id="batchClearBtn">取消选择</button>
  `;
  if (hasPerm("devices")) {
    document.getElementById("batchStatusBtn").addEventListener("click", batchSetStatus);
  }
  document.getElementById("batchClearBtn").addEventListener("click", () => {
    DEV_SELECTED.clear();
    paintDeviceTable();
  });
  const delBtn = document.getElementById("batchDeleteBtn");
  if (delBtn) delBtn.addEventListener("click", batchDeleteSelected);
}

async function batchSetStatus() {
  const status = document.getElementById("batchStatusSel").value;
  const ids = Array.from(DEV_SELECTED);
  if (!confirm(`确认将选中的 ${ids.length} 台设备状态批量改为"${status}"?`)) return;
  const btn = document.getElementById("batchStatusBtn");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const r = await apiJSON("/devices/batch-status", "POST", { ids, status });
    toast(`已更新 ${r.updated} 台设备的状态`);
    DEV_SELECTED.clear();
    loadDevices();
  } catch (e) {
  } finally {
    btn.disabled = false;
  }
}

async function batchDeleteSelected() {
  const ids = Array.from(DEV_SELECTED);
  if (!confirm(`确认批量删除选中的 ${ids.length} 台设备?此操作不可恢复,将记录在修改日志中。`)) return;
  const btn = document.getElementById("batchDeleteBtn") || document.querySelector('[onclick^="batchDeleteSelected"]');
  if (btn && btn.disabled) return;
  if (btn) btn.disabled = true;
  try {
    const r = await apiJSON("/devices/batch-delete", "POST", { ids });
    toast(`已删除 ${r.deleted} 台设备`);
    DEV_SELECTED.clear();
    loadDevices();
  } catch (e) {
  } finally {
    if (btn) btn.disabled = false;
  }
}

function openDeviceForm(id) {
  const row = id ? DEV_CACHE.find((d) => d.id === id) : null;
  let pendingPhotoBlob = null; // 表单里选好但还没上传的照片,保存的时候才真正提交

  openModal(`
    <h2>${id ? "编辑设备点位" : "新增设备点位"}</h2>
    <div class="grid2">
      <div class="field"><label>总分类 *</label>${mainCategorySelectHTML("fCategory", row?.category_id)}</div>
      <div class="field"><label>子分类</label>${subCategorySelectHTML("fSubCategory", row?.category_id || 0, row?.sub_category_id)}</div>
      <div class="field"><label>安装位置</label><input id="fLocation" value="${escapeHTML(row?.location || "")}" placeholder="如: 1楼大厅、A栋3层走廊"></div>
      <div class="field">
        <label>设备型号</label>
        <input id="fModel" list="devModelSuggestions" value="${escapeHTML(row?.model || "")}" placeholder="可从下拉选择工程量对比里的型号,或自己输入">
        <datalist id="devModelSuggestions"></datalist>
      </div>
      <div class="field"><label>所属机柜</label><input id="fCabinet" value="${escapeHTML(row?.cabinet || "")}" placeholder="如: 1号弱电间A柜"></div>
      <div class="field"><label>IP地址</label><input id="fIp" class="mono" value="${escapeHTML(row?.ip || "")}"></div>
      <div class="field"><label>安装状态</label>
        <select id="fStatus">
          ${["未安装", "已安装", "已调试", "施工异常"].map((s) => `<option ${row?.status === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
      </div>
      <div class="field grid1"><label>备注</label><input id="fRemark" value="${escapeHTML(row?.remark || "")}"></div>
      <div class="field grid1">
        <label>现场照片</label>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <div id="fPhotoPreviewWrap">
            ${row?.photo_path
              ? `<img id="fPhotoPreview" class="thumb" src="${row.photo_path}">`
              : `<span id="fPhotoPreview" style="color:var(--text-dim);font-size:12.5px;">暂无照片</span>`}
          </div>
          <label class="btn btn-outline btn-sm" style="margin:0">
            拍照/选择照片<input type="file" id="fPhotoInput" accept="image/*" capture="environment" style="display:none">
          </label>
        </div>
      </div>
    </div>
    ${!mainCategories().length ? `<p style="color:var(--red);font-size:12.5px;margin-top:8px;">暂无可选分类,请先到"分类管理"页面新增总分类</p>` : ""}
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="devSaveBtn">保存</button>
    </div>
  `);
  bindCategoryCascade("fCategory", "fSubCategory", null, true);

  // 型号下拉建议:复用"工程量对比"里已经录入过的型号,按分类联动过滤,省得每次都手打
  let qtyList = [];
  function modelsFor(catId, subId) {
    let list = qtyList;
    if (catId) list = list.filter((q) => q.category_id === catId);
    if (subId) list = list.filter((q) => q.sub_category_id === subId);
    return Array.from(new Set(list.map((q) => q.device_name))).filter(Boolean);
  }
  // autoFilledModel 记录"当前输入框里的值是不是系统自动帮填的",用户一旦手动改动过就不再干预
  let autoFilledModel = null;
  function refreshModelSuggestions() {
    const catId = parseInt(document.getElementById("fCategory")?.value) || 0;
    const subId = parseInt(document.getElementById("fSubCategory")?.value) || 0;
    const list = modelsFor(catId, subId);
    const dl = document.getElementById("devModelSuggestions");
    if (dl) dl.innerHTML = list.map((n) => `<option value="${escapeHTML(n)}">`).join("");
    // 举一反三:分类下只有唯一一个型号时自动填入;只在输入框"没被用户接管"时才生效
    // (还是空的,或者还是系统上次自动填的那个值),这样改错分类再改回来也能继续自动更新,
    // 用户一旦手动改过输入框的内容,后面不管怎么切分类都不会再覆盖。
    const modelInput = document.getElementById("fModel");
    if (modelInput) {
      const untouched = modelInput.value.trim() === "" || modelInput.value === autoFilledModel;
      if (untouched) {
        modelInput.value = list.length === 1 ? list[0] : "";
        autoFilledModel = modelInput.value;
      }
    }
  }
  if (CUR_PROJECT) {
    api("/quantity?project_id=" + CUR_PROJECT).then((list) => { qtyList = list || []; refreshModelSuggestions(); }).catch(() => {});
  }
  // 用事件委托绑在 modalRoot 上,因为切换总分类时子分类下拉会被 outerHTML 整个重建,
  // 直接绑在 fSubCategory 上的监听器会随旧节点一起被销毁,委托到不会被替换的父容器上更稳妥。
  const modalRoot = document.getElementById("modalRoot");
  if (modalRoot._devModelHandler) modalRoot.removeEventListener("change", modalRoot._devModelHandler);
  const modelHandler = (e) => {
    if (e.target.id === "fCategory" || e.target.id === "fSubCategory") setTimeout(refreshModelSuggestions, 0);
  };
  modalRoot._devModelHandler = modelHandler;
  modalRoot.addEventListener("change", modelHandler);

  // 照片选择:先本地压缩出预览,真正的上传放到点"保存"的时候一起做
  document.getElementById("fPhotoInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    toast("正在压缩照片...");
    try {
      pendingPhotoBlob = await compressImage(file);
      const url = URL.createObjectURL(pendingPhotoBlob);
      document.getElementById("fPhotoPreviewWrap").innerHTML = `<img id="fPhotoPreview" class="thumb" src="${url}">`;
      toast(`照片已就绪(${(pendingPhotoBlob.size / 1024).toFixed(0)}KB),点"保存"后生效`);
    } catch (err) {
      toast("照片处理失败: " + err.message, "err");
    }
  });

  bindSubmitOnce(document.getElementById("devSaveBtn"), async () => {
    const data = {
      project_id: CUR_PROJECT,
      category_id: parseInt(document.getElementById("fCategory").value) || 0,
      sub_category_id: parseInt(document.getElementById("fSubCategory").value) || 0,
      location: document.getElementById("fLocation").value.trim(),
      model: document.getElementById("fModel").value.trim(),
      cabinet: document.getElementById("fCabinet").value.trim(),
      ip: document.getElementById("fIp").value.trim(),
      status: document.getElementById("fStatus").value,
      remark: document.getElementById("fRemark").value.trim(),
    };
    if (!data.category_id) { toast("请选择总分类", "err"); return; }
    try {
      let savedId = id;
      if (id) {
        await apiJSON("/devices/" + id, "PUT", data);
      } else {
        const created = await apiJSON("/devices", "POST", data);
        savedId = created.id;
      }
      if (pendingPhotoBlob && savedId) {
        const fd = new FormData();
        fd.append("photo", pendingPhotoBlob, "photo.jpg");
        await api("/devices/" + savedId + "/photo", { method: "POST", body: fd });
      }
      toast("保存成功");
      closeModal();
      loadDevices();
    } catch (e) {}
  });
}

async function deleteDeviceRow(id) {
  if (!confirm("确认删除该设备点位?此操作将记录在修改日志中。")) return;
  try {
    await api("/devices/" + id, { method: "DELETE" });
    toast("已删除");
    loadDevices();
  } catch (e) {}
}

/* ---------------- 现场照片:前端压缩至 200KB 以内再上传 ---------------- */
function compressImage(file, maxKB = 190) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => (img.src = e.target.result);
    reader.onerror = reject;
    img.onload = () => {
      let { width, height } = img;
      const MAX_DIM = 1280;
      if (width > MAX_DIM || height > MAX_DIM) {
        const ratio = Math.min(MAX_DIM / width, MAX_DIM / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);

      let quality = 0.85;
      function tryCompress() {
        canvas.toBlob(
          (blob) => {
            if (!blob) { reject(new Error("压缩失败")); return; }
            if (blob.size / 1024 <= maxKB || quality <= 0.35) {
              resolve(blob);
            } else {
              quality -= 0.1;
              tryCompress();
            }
          },
          "image/jpeg",
          quality
        );
      }
      tryCompress();
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadPhoto(id, inputEl) {
  const file = inputEl.files[0];
  if (!file) return;
  toast("正在压缩照片...");
  try {
    const blob = await compressImage(file);
    const fd = new FormData();
    fd.append("photo", blob, "photo.jpg");
    await api("/devices/" + id + "/photo", { method: "POST", body: fd });
    toast(`照片上传成功 (${(blob.size / 1024).toFixed(0)}KB)`);
    loadDevices();
  } catch (e) {
    toast("照片处理失败: " + e.message, "err");
  }
  inputEl.value = "";
}

/* ---------------- 扫码现场核验 ---------------- */
// openDeviceCheckin 打开"现场核验"弹窗:显示设备基本信息 + 最近核验历史,并可以提交一条新的核验记录。
// 既可以从设备列表的"核验"按钮触发,也是手机扫描标签二维码后自动打开的入口(见 app.js 里的 ?scan= 处理)。
async function openDeviceCheckin(id) {
  let info;
  try {
    info = await api("/devices/" + id + "/checkin-info");
  } catch (e) { return; }
  const d = info.device;
  openModal(`
    <h2>现场核验</h2>
    <div style="background:var(--bg-soft,#f6f7f9);border-radius:8px;padding:12px 14px;margin-bottom:14px;font-size:13.5px;line-height:1.8;">
      <div><b>${escapeHTML(d.category)}</b>　${escapeHTML(info.project_name || "")}</div>
      <div>位置:${escapeHTML(d.location) || "-"}　机柜:${escapeHTML(d.cabinet) || "-"}</div>
      <div>型号:${escapeHTML(d.model) || "-"}　IP:${escapeHTML(d.ip) || "-"}</div>
      <div>当前状态:${statusTag(d.status)}</div>
    </div>
    <div class="field grid1">
      <label>本次核验结果</label>
      <select id="fCheckResult"><option value="正常">正常</option><option value="异常">异常,需要处理</option></select>
    </div>
    <div class="field"><label>备注(选填)</label><input id="fCheckNote" placeholder="比如:设备运行正常/发现指示灯异常等"></div>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="checkinSubmitBtn">提交核验</button>
    </div>
    <div style="margin-top:18px;">
      <div style="font-size:12.5px;color:var(--text-dim);margin-bottom:6px;">最近核验记录</div>
      ${info.history.length ? info.history.map((c) => `
        <div style="font-size:12.5px;padding:6px 0;border-bottom:1px solid var(--line);">
          ${c.result === "异常" ? '<span class="tag tag-bad">异常</span>' : '<span class="tag tag-ok">正常</span>'}
          ${escapeHTML(c.checked_by)} · ${escapeHTML(c.created_at)} ${c.note ? "· " + escapeHTML(c.note) : ""}
        </div>
      `).join("") : `<div style="font-size:12.5px;color:var(--text-dim);">暂无核验记录,这将是第一次</div>`}
    </div>
  `);
  bindSubmitOnce(document.getElementById("checkinSubmitBtn"), async () => {
    const result = document.getElementById("fCheckResult").value;
    const note = document.getElementById("fCheckNote").value.trim();
    try {
      await apiJSON("/devices/" + id + "/checkin", "POST", { result, note });
      toast("核验已记录");
      closeModal();
      if (typeof loadDevices === "function" && document.getElementById("devListArea")) loadDevices();
    } catch (e) {}
  });
}
async function printDeviceLabels() {
  if (!DEV_SELECTED.size) { toast("请先勾选需要打印标签的设备", "err"); return; }
  const ids = Array.from(DEV_SELECTED);
  const list = await apiJSON("/devices/labels", "POST", { ids });
  const win = window.open("", "_blank");
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>设备标签打印</title>
    <script src="/vendor/qrcode.min.js"><\/script>
    <style>
      body{font-family:sans-serif;margin:16px;}
      .sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;}
      .label{border:1px dashed #333;border-radius:4px;padding:8px;display:flex;gap:8px;align-items:center;break-inside:avoid;}
      .txt{font-size:11px;line-height:1.5;font-family:monospace;}
      .txt b{display:block;font-size:13px;font-family:sans-serif;}
      @media print{ .no-print{display:none;} }
    </style></head><body>
    <div class="no-print" style="margin-bottom:12px;"><button onclick="window.print()">打印</button></div>
    <div class="sheet" id="sheet"></div>
    </body></html>`);
  win.document.close();
  const sheet = win.document.getElementById("sheet");
  list.forEach((d) => {
    // 二维码内容改成"扫码打开核验页"的链接(而不是纯文本参数),这样现场工人拿手机一扫,
    // 直接跳转到登录后的设备核验页,不用再手动翻页面/搜索这台设备。
    const qrText = `${location.origin}/?scan=${d.id}`;
    const div = win.document.createElement("div");
    div.className = "label";
    div.innerHTML = `<div class="qr"></div><div class="txt"><b>${escapeHTML(d.model) || "(未填型号)"}</b>位置:${escapeHTML(d.location) || "-"}<br>机柜:${escapeHTML(d.cabinet) || "-"}<br>IP:${escapeHTML(d.ip) || "-"}</div>`;
    sheet.appendChild(div);
    new win.QRCode(div.querySelector(".qr"), { text: qrText, width: 64, height: 64 });
  });
}
