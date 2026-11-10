/* ============================================================
   模块:现场安装数量登记(批量登记,自动同步到工程量对比的安装数量)
   ============================================================ */
let INSTALL_CACHE = [];
let INSTALL_PAGE = 1, INSTALL_PAGE_SIZE = 20;
let INSTALL_SORT = ""; // "" = 默认(最新录入在前) / "location" / "model"
let INSTALL_MODEL_FILTER = ""; // 按型号筛选,空字符串表示不筛选

async function renderInstallView() {
  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="page-head">
      <h1>现场安装数量登记</h1>
      <span class="sub">按分类批量登记安装数量,无需逐台录入设备,自动同步到"工程量对比"的安装数量</span>
    </div>
    <div class="toolbar">
      ${projectSelectHTML("instProjectSel")}
      ${mainCategorySelectHTML("instCatFilter", null)}
      ${subCategorySelectHTML("instSubFilter", 0, null)}
      <select id="instSortSel">
        <option value="">默认排序(最新录入在前)</option>
        <option value="location">按安装位置排序</option>
        <option value="model">按型号排序</option>
      </select>
      <input id="instModelFilter" list="instModelFilterSuggestions" placeholder="按型号筛选" style="width:150px;">
      <datalist id="instModelFilterSuggestions"></datalist>
      <div class="fill"></div>
      <button class="btn btn-outline btn-sm" id="instExportBtn">导出Excel</button>
      ${hasPerm("install") ? `
      <label class="btn btn-outline btn-sm" style="margin:0">
        导入Excel<input type="file" id="instImportFile" accept=".xlsx" style="display:none">
      </label>
      <button class="btn btn-cyan btn-sm" id="instAddBtn">+ 新增安装登记</button>
      ` : `<span style="color:var(--text-dim);font-size:12.5px;">只读模式,如需新增/编辑请联系管理员授权</span>`}
    </div>
    <div id="instStats" class="stat-row"></div>
    <div id="instTableWrap"></div>
    <div id="instPager"></div>
  `;
  bindProjectSelect("instProjectSel", loadInstall);
  document.getElementById("instCatFilter").addEventListener("change", (e) => {
    document.getElementById("instSubFilter").outerHTML = subCategorySelectHTML("instSubFilter", e.target.value, null);
    document.getElementById("instSubFilter").addEventListener("change", loadInstall);
    loadInstall();
  });
  document.getElementById("instSubFilter").addEventListener("change", loadInstall);
  document.getElementById("instSortSel").addEventListener("change", (e) => {
    INSTALL_SORT = e.target.value;
    INSTALL_PAGE = 1;
    paintInstallTable();
  });
  let modelFilterTimer = null;
  document.getElementById("instModelFilter").addEventListener("input", (e) => {
    clearTimeout(modelFilterTimer);
    modelFilterTimer = setTimeout(() => {
      INSTALL_MODEL_FILTER = e.target.value.trim();
      INSTALL_PAGE = 1;
      paintInstallTable();
    }, 200);
  });
  document.getElementById("instExportBtn").addEventListener("click", () => {
    window.location = API + "/export/install?project_id=" + (CUR_PROJECT || 0);
  });
  if (hasPerm("install")) {
    document.getElementById("instAddBtn").addEventListener("click", () => openInstallForm(null));
    document.getElementById("instImportFile").addEventListener("change", async (e) => {
      if (!e.target.files.length) return;
      if (!CUR_PROJECT) { toast("请先选择所属项目", "err"); e.target.value = ""; return; }
      const file = e.target.files[0];
      e.target.value = "";
      const mode = await chooseImportMode("现场安装数量登记");
      if (!mode) return;
      const fd = new FormData();
      fd.append("file", file);
      try {
        const r = await api("/import/install?project_id=" + CUR_PROJECT + "&mode=" + mode, { method: "POST", body: fd });
        toast(`成功导入 ${r.imported} 条记录(${mode === "overwrite" ? "覆盖导入" : "追加导入"}),已同步到工程量对比`);
        await loadCategories();
        loadInstall();
      } catch (err) {}
    });
  }
  await loadInstall();
}

async function loadInstall() {
  INSTALL_PAGE = 1;
  if (!CUR_PROJECT) { INSTALL_CACHE = []; paintInstallTable(); return; }
  const catId = document.getElementById("instCatFilter")?.value || "";
  const subId = document.getElementById("instSubFilter")?.value || "";
  const qs = new URLSearchParams({ project_id: CUR_PROJECT });
  if (catId) qs.set("category_id", catId);
  if (subId) qs.set("sub_category_id", subId);
  INSTALL_CACHE = await api("/install?" + qs.toString());
  paintInstallTable();
}

function sortedInstall() {
  let list = INSTALL_MODEL_FILTER ? INSTALL_CACHE.filter((it) => (it.model || "").toLowerCase().includes(INSTALL_MODEL_FILTER.toLowerCase())) : INSTALL_CACHE;
  if (!INSTALL_SORT) return list;
  list = [...list];
  list.sort((a, b) => (a[INSTALL_SORT] || "").localeCompare(b[INSTALL_SORT] || "", "zh"));
  return list;
}

// refreshInstallModelSuggestions 把当前数据里出现过的所有型号列进筛选框的下拉建议,方便直接选而不用手打
function refreshInstallModelSuggestions() {
  const dl = document.getElementById("instModelFilterSuggestions");
  if (!dl) return;
  const models = Array.from(new Set(INSTALL_CACHE.map((it) => it.model).filter(Boolean)));
  dl.innerHTML = models.map((m) => `<option value="${escapeHTML(m)}">`).join("");
}

function paintInstallTable() {
  const wrap = document.getElementById("instTableWrap");
  const statsEl = document.getElementById("instStats");
  refreshInstallModelSuggestions();
  if (!INSTALL_CACHE.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="big">&#128230;</div>暂无安装登记记录,点击右上角新增</div>`;
    document.getElementById("instPager").innerHTML = "";
    statsEl.innerHTML = "";
    return;
  }
  const all = sortedInstall();
  const totalQty = all.reduce((s, it) => s + (it.quantity || 0), 0);
  statsEl.innerHTML = `
    <div class="stat-box"><div class="v">${all.length}</div><div class="l">${INSTALL_MODEL_FILTER ? "筛选出的记录" : "当前记录"}</div></div>
    <div class="stat-box"><div class="v">${fmtNum(totalQty)}</div><div class="l">${INSTALL_MODEL_FILTER ? `"${escapeHTML(INSTALL_MODEL_FILTER)}" 安装数量合计` : "安装数量合计"}</div></div>
  `;
  if (!all.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="big">&#128269;</div>没有匹配"${escapeHTML(INSTALL_MODEL_FILTER)}"的型号,换个关键词试试</div>`;
    document.getElementById("instPager").innerHTML = "";
    return;
  }
  INSTALL_PAGE = clampPage(INSTALL_PAGE, all.length, INSTALL_PAGE_SIZE);
  const pageRows = paginate(all, INSTALL_PAGE, INSTALL_PAGE_SIZE);
  wrap.innerHTML = `
    <div class="table-wrap"><table class="data" id="instTable">
    <thead><tr>
      <th>照片</th><th>总分类</th><th>子分类</th><th>安装位置</th><th>设备型号</th><th>数量</th><th>备注</th><th>更新</th><th></th>
    </tr></thead>
    <tbody>
      ${pageRows.map((it) => `
        <tr>
          <td>${it.photo_path ? `<img class="thumb" src="${it.photo_path}" onclick="window.open('${it.photo_path}')">` : (hasPerm("install") ? `<label class="btn btn-outline btn-sm" style="margin:0"><input type="file" accept="image/*" capture="environment" style="display:none" onchange="uploadInstallPhoto(${it.id}, this)">拍照</label>` : `<span style="color:var(--text-dim);font-size:12px;">无照片</span>`)}</td>
          <td>${escapeHTML(it.category_name)}</td>
          <td>${escapeHTML(it.sub_category_name)}</td>
          <td>${escapeHTML(it.location)}</td>
          <td><b>${escapeHTML(it.model)}</b></td>
          <td class="mono"><b>${fmtNum(it.quantity)}</b></td>
          <td class="remark">${escapeHTML(it.remark)}</td>
          <td class="mono" style="font-size:11px;color:var(--text-dim)">${escapeHTML(it.updated_by)}<br>${escapeHTML(it.updated_at)}</td>
          <td>
            ${hasPerm("install") ? `<button class="btn btn-outline btn-sm" onclick="openInstallForm(${it.id})">编辑</button>` : ""}
            ${ME.role === "admin" ? `<button class="btn btn-danger btn-sm" onclick="deleteInstallRow(${it.id})">删除</button>` : ""}
          </td>
        </tr>
      `).join("")}
    </tbody>
    </table></div>
  `;
  renderPager("instPager", all.length, INSTALL_PAGE, INSTALL_PAGE_SIZE,
    (p) => { INSTALL_PAGE = p; paintInstallTable(); },
    (sz) => { INSTALL_PAGE_SIZE = sz; INSTALL_PAGE = 1; paintInstallTable(); });
}

async function openInstallForm(id) {
  const row = id ? INSTALL_CACHE.find((it) => it.id === id) : null;
  let pendingPhotoBlob = null; // 表单里选好但还没上传的照片,保存的时候才真正提交

  // 拉取当前项目"工程量对比"里已经录入的设备型号(含分类信息),按所选分类动态过滤下拉建议
  let qtyList = [];
  if (CUR_PROJECT) {
    try {
      qtyList = await api("/quantity?project_id=" + CUR_PROJECT);
    } catch (e) {}
  }
  function modelsFor(catId, subId) {
    let list = qtyList;
    if (catId) list = list.filter((q) => q.category_id === catId);
    if (subId) list = list.filter((q) => q.sub_category_id === subId);
    return Array.from(new Set(list.map((q) => q.device_name))).filter(Boolean);
  }

  const initCatId = row?.category_id || 0;
  const initSubId = row?.sub_category_id || 0;
  const initSuggestions = modelsFor(initCatId, initSubId);

  openModal(`
    <h2>${id ? "编辑安装登记" : "新增安装登记"}</h2>
    <p style="color:var(--text-dim);font-size:12.5px;margin:-6px 0 14px;">保存后会自动累加同步到"工程量对比"页面对应设备的安装数量</p>
    <div class="grid2">
      <div class="field"><label>总分类 *</label>${mainCategorySelectHTML("fMainCat", row?.category_id)}</div>
      <div class="field"><label>子分类</label>${subCategorySelectHTML("fSubCat", row?.category_id || 0, row?.sub_category_id)}</div>
      <div class="field"><label>安装位置</label><input id="fLocation" value="${escapeHTML(row?.location || "")}" placeholder="如: 1楼大厅、A栋3层走廊"></div>
      <div class="field">
        <label>设备型号 *</label>
        <input id="fModel" list="modelSuggestions" value="${escapeHTML(row?.model || "")}" placeholder="可从下拉选择已在工程量对比录入的型号,或自己输入">
        <datalist id="modelSuggestions">${initSuggestions.map((n) => `<option value="${escapeHTML(n)}">`).join("")}</datalist>
      </div>
      <div class="field"><label>本次安装数量 *</label><input id="fQty" type="number" step="any" value="${row?.quantity ?? ""}" placeholder="可一次登记多台"></div>
      <div class="field"><label>备注</label><input id="fRemark" value="${escapeHTML(row?.remark || "")}"></div>
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
    <p id="modelHint" style="color:var(--text-dim);font-size:12px;margin-top:2px;">${modelHintText(initSuggestions.length)}</p>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="instSaveBtn">保存</button>
    </div>
  `);

  // autoFilledModel 记录"当前输入框里的值是不是系统自动帮填的",用户一旦手动改动过(输入框的值
  // 不再等于这个记录值),后续切换分类就不会再干预,尊重用户已经自己填写/修改过的内容。
  let autoFilledModel = null;
  function refreshModelSuggestions() {
    const catId = parseInt(document.getElementById("fMainCat").value) || 0;
    const subId = parseInt(document.getElementById("fSubCat").value) || 0;
    const list = modelsFor(catId, subId);
    document.getElementById("modelSuggestions").innerHTML = list.map((n) => `<option value="${escapeHTML(n)}">`).join("");
    document.getElementById("modelHint").textContent = modelHintText(list.length);
    // 举一反三:这个分类下如果工程量对比里只登记过一个型号,直接帮着填上,不用再选/打字;
    // 只在输入框"没被用户接管"(还是空的,或者还是系统上次自动填的那个值)时才生效——
    // 这样切错分类改回来、或者来回切换分类,自动填入会跟着一直刷新;一旦用户自己手动改过,
    // 不管后面怎么切分类都不会再覆盖用户输入的内容。
    const modelInput = document.getElementById("fModel");
    const untouched = modelInput.value.trim() === "" || modelInput.value === autoFilledModel;
    if (untouched) {
      modelInput.value = list.length === 1 ? list[0] : "";
      autoFilledModel = modelInput.value;
    }
  }
  bindCategoryCascade("fMainCat", "fSubCat", null, true);
  // 用事件委托绑在 modalRoot 上,因为 bindCategoryCascade 切换总分类时会用 outerHTML 整个重建
  // 子分类下拉框(直接绑在 fSubCat 上的监听器会随旧节点一起被销毁),委托到不会被替换的父容器上更稳妥。
  // modalRoot 本身在多次打开弹窗之间是复用的,所以每次都要先解绑上一次残留的委托监听器,避免叠加。
  const modalRoot = document.getElementById("modalRoot");
  if (modalRoot._installModelHandler) {
    modalRoot.removeEventListener("change", modalRoot._installModelHandler);
  }
  const handler = (e) => {
    if (e.target.id === "fMainCat" || e.target.id === "fSubCat") {
      setTimeout(refreshModelSuggestions, 0);
    }
  };
  modalRoot._installModelHandler = handler;
  modalRoot.addEventListener("change", handler);

  // 照片选择:复用设备台账里的 compressImage() 压缩逻辑,先本地压缩出预览,
  // 真正的上传放到点"保存"的时候一起做(新增时要等拿到id才能上传)
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

  bindSubmitOnce(document.getElementById("instSaveBtn"), async () => {
    const data = {
      project_id: CUR_PROJECT,
      category_id: parseInt(document.getElementById("fMainCat").value) || 0,
      sub_category_id: parseInt(document.getElementById("fSubCat").value) || 0,
      location: document.getElementById("fLocation").value.trim(),
      model: document.getElementById("fModel").value.trim(),
      quantity: parseFloat(document.getElementById("fQty").value) || 0,
      remark: document.getElementById("fRemark").value.trim(),
    };
    if (!data.category_id) { toast("请选择总分类", "err"); return; }
    if (!data.model) { toast("设备型号不能为空", "err"); return; }
    try {
      let savedId = id;
      if (id) {
        await apiJSON("/install/" + id, "PUT", data);
      } else {
        const created = await apiJSON("/install", "POST", data);
        savedId = created.id;
      }
      if (pendingPhotoBlob && savedId) {
        const fd = new FormData();
        fd.append("photo", pendingPhotoBlob, "photo.jpg");
        await api("/install/" + savedId + "/photo", { method: "POST", body: fd });
      }
      toast("保存成功,已同步到工程量对比");
      closeModal();
      loadInstall();
    } catch (e) {}
  });
}

function modelHintText(count) {
  return count
    ? "提示:设备型号已按所选分类列出工程量对比里录入过的型号,可直接选择,也可以自己输入新的型号。"
    : "提示:该分类下工程量对比还没有录入过设备型号,可直接手动输入(建议和工程量对比保持一致以便自动同步)。";
}

async function deleteInstallRow(id) {
  if (!confirm("确认删除该安装登记?删除后会自动从工程量对比的安装数量中扣除。")) return;
  try {
    await api("/install/" + id, { method: "DELETE" });
    toast("已删除,工程量对比已同步更新");
    loadInstall();
  } catch (e) {}
}

// uploadInstallPhoto 列表里的快捷拍照入口,和设备台账的 uploadPhoto() 是同一套压缩逻辑(compressImage 复用自 app_devices.js)
async function uploadInstallPhoto(id, inputEl) {
  const file = inputEl.files[0];
  if (!file) return;
  toast("正在压缩照片...");
  try {
    const blob = await compressImage(file);
    const fd = new FormData();
    fd.append("photo", blob, "photo.jpg");
    await api("/install/" + id + "/photo", { method: "POST", body: fd });
    toast(`照片上传成功 (${(blob.size / 1024).toFixed(0)}KB)`);
    loadInstall();
  } catch (e) {
    toast("照片处理失败: " + e.message, "err");
  }
  inputEl.value = "";
}
