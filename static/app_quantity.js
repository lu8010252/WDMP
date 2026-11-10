/* ============================================================
   模块:工程量与三方数量对比
   ============================================================ */
let QTY_CACHE = [];
let QTY_PAGE = 1, QTY_PAGE_SIZE = 20;
// QTY_DIFF_COLS 控制"对比差值"这几列是否显示,方便只关心某一种对比时把其余列隐藏、表格更清爽。
// key 对应后端返回字段名,label 是勾选框文字,默认全部勾选(和原来行为一致)。
const QTY_DIFF_COLS = [
  { key: "diff_list", label: "安装-清单" },
  { key: "diff_drawing", label: "安装-图纸" },
  { key: "diff_arrival", label: "到货-清单", posText: "到货超量", negText: "到货不足" },
  { key: "diff_installed", label: "安装-到货", posText: "超装(异常)", negText: "有货未装" },
];
let QTY_KW = "", QTY_ONLY_DIFF = false;
let QTY_VISIBLE_DIFFS = new Set(QTY_DIFF_COLS.map((c) => c.key));

async function renderQuantityView() {
  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="page-head">
      <h1>工程量对比</h1>
      <span class="sub">图纸数量 · 清单数量 · 到货数量 · 安装数量 四方对比</span>
    </div>
    <div class="toolbar">
      ${projectSelectHTML("qtyProjectSel")}
      ${mainCategorySelectHTML("qtyCatFilter", null)}
      ${subCategorySelectHTML("qtySubFilter", 0, null)}
      <div class="fill"></div>
      <button class="btn btn-outline btn-sm" id="qtyExportBtn">导出Excel</button>
      ${hasPerm("quantity") ? `
      <label class="btn btn-outline btn-sm" style="margin:0">
        导入Excel<input type="file" id="qtyImportFile" accept=".xlsx" style="display:none">
      </label>
      <button class="btn btn-cyan btn-sm" id="qtyAddBtn">+ 新增设备项</button>
      ` : `<span style="color:var(--text-dim);font-size:12.5px;">只读模式,如需新增/编辑请联系管理员授权</span>`}
    </div>
    <div class="toolbar" style="padding-top:0;">
      <input type="text" id="qtyKw" placeholder="搜索型号/品牌/备注" value="${escapeHTML(QTY_KW)}" style="width:170px;padding:6px 8px;border:1px solid var(--line);border-radius:4px;font-size:13px;">
      <label style="display:flex;align-items:center;gap:5px;font-size:12.5px;">
        <input type="checkbox" id="qtyOnlyDiff" ${QTY_ONLY_DIFF ? "checked" : ""}>只看有差异的
      </label>
      <span style="color:var(--text-dim);font-size:12.5px;margin-left:10px;">显示对比列:</span>
      ${QTY_DIFF_COLS.map((c) => `
        <label style="display:flex;align-items:center;gap:5px;font-size:12.5px;">
          <input type="checkbox" class="qtyDiffColToggle" value="${c.key}" ${QTY_VISIBLE_DIFFS.has(c.key) ? "checked" : ""}>${c.label}
        </label>
      `).join("")}
    </div>
    <div id="qtyStats" class="stat-row"></div>
    <div id="qtyTableWrap"></div>
    <div id="qtyPager"></div>
  `;
  bindProjectSelect("qtyProjectSel", loadQuantity);
  document.getElementById("qtyCatFilter").addEventListener("change", (e) => {
    document.getElementById("qtySubFilter").outerHTML = subCategorySelectHTML("qtySubFilter", e.target.value, null);
    document.getElementById("qtySubFilter").addEventListener("change", () => { QTY_PAGE = 1; paintQuantityTable(); });
    QTY_PAGE = 1;
    paintQuantityTable();
  });
  document.getElementById("qtySubFilter").addEventListener("change", () => { QTY_PAGE = 1; paintQuantityTable(); });
  document.querySelectorAll(".qtyDiffColToggle").forEach((cb) => cb.addEventListener("change", () => {
    if (cb.checked) QTY_VISIBLE_DIFFS.add(cb.value); else QTY_VISIBLE_DIFFS.delete(cb.value);
    paintQuantityTable();
  }));
  document.getElementById("qtyKw").addEventListener("input", (e) => { QTY_KW = e.target.value; QTY_PAGE = 1; paintQuantityTable(); });
  document.getElementById("qtyOnlyDiff").addEventListener("change", (e) => { QTY_ONLY_DIFF = e.target.checked; QTY_PAGE = 1; paintQuantityTable(); });
  document.getElementById("qtyExportBtn").addEventListener("click", () => {
    window.location = API + "/export/quantity?project_id=" + (CUR_PROJECT || 0);
  });
  if (hasPerm("quantity")) {
    document.getElementById("qtyAddBtn").addEventListener("click", () => openQuantityForm(null));
    document.getElementById("qtyImportFile").addEventListener("change", async (e) => {
      if (!e.target.files.length) return;
      if (!CUR_PROJECT) { toast("请先选择所属项目", "err"); e.target.value = ""; return; }
      const file = e.target.files[0];
      e.target.value = "";
      const mode = await chooseImportMode("工程量对比");
      if (!mode) return;
      const fd = new FormData();
      fd.append("file", file);
      try {
        const r = await api("/import/quantity?project_id=" + CUR_PROJECT + "&mode=" + mode, { method: "POST", body: fd });
        toast(`成功导入 ${r.imported} 条记录(${mode === "overwrite" ? "覆盖导入" : "追加导入"})`);
        await loadCategories();
        loadQuantity();
      } catch (err) {}
    });
  }
  await loadQuantity();
}

async function loadQuantity() {
  QTY_PAGE = 1;
  if (!CUR_PROJECT) { QTY_CACHE = []; paintQuantityTable(); return; }
  QTY_CACHE = await api("/quantity?project_id=" + CUR_PROJECT);
  paintQuantityTable();
}

function paintQuantityTable() {
  const statsEl = document.getElementById("qtyStats");
  const wrap = document.getElementById("qtyTableWrap");
  let rows = QTY_CACHE;
  const catId = parseInt(document.getElementById("qtyCatFilter")?.value) || 0;
  const subId = parseInt(document.getElementById("qtySubFilter")?.value) || 0;
  if (catId) rows = rows.filter((r) => r.category_id === catId);
  if (subId) rows = rows.filter((r) => r.sub_category_id === subId);
  const kw = QTY_KW.trim().toLowerCase();
  if (kw) rows = rows.filter((r) => [r.device_name, r.brand, r.remark, r.category].some((x) => (x || "").toLowerCase().includes(kw)));
  // "有差异" 只看当前勾选显示的对比列,和表格上看到的保持一致
  if (QTY_ONLY_DIFF) rows = rows.filter((r) => QTY_DIFF_COLS.some((c) => QTY_VISIBLE_DIFFS.has(c.key) && r[c.key] !== 0));

  const totalDrawing = rows.reduce((s, r) => s + r.drawing_qty, 0);
  const totalList = rows.reduce((s, r) => s + r.list_qty, 0);
  const totalArrival = rows.reduce((s, r) => s + r.arrival_qty, 0);
  const totalActual = rows.reduce((s, r) => s + r.actual_qty, 0);
  const overCount = rows.filter((r) => r.diff_list > 0).length;
  const underCount = rows.filter((r) => r.diff_list < 0).length;
  const notArrivedCount = rows.filter((r) => r.diff_arrival < 0).length;
  statsEl.innerHTML = `
    <div class="stat-box"><div class="v">${rows.length}</div><div class="l">设备条目</div></div>
    <div class="stat-box"><div class="v">${fmtNum(totalDrawing)}</div><div class="l">图纸合计</div></div>
    <div class="stat-box"><div class="v">${fmtNum(totalList)}</div><div class="l">清单合计</div></div>
    <div class="stat-box"><div class="v">${fmtNum(totalArrival)}</div><div class="l">到货合计</div></div>
    <div class="stat-box"><div class="v">${fmtNum(totalActual)}</div><div class="l">实际合计</div></div>
    <div class="stat-box"><div class="v" style="color:var(--amber)">${overCount}</div><div class="l">多装条目</div></div>
    <div class="stat-box"><div class="v" style="color:var(--red)">${underCount}</div><div class="l">漏装条目</div></div>
    <div class="stat-box"><div class="v" style="color:var(--red)">${notArrivedCount}</div><div class="l">到货不齐条目</div></div>
  `;

  if (!rows.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="big">&#128203;</div>暂无工程量数据,请先新增或导入Excel</div>`;
    document.getElementById("qtyPager").innerHTML = "";
    return;
  }
  QTY_PAGE = clampPage(QTY_PAGE, rows.length, QTY_PAGE_SIZE);
  const pageRows = paginate(rows, QTY_PAGE, QTY_PAGE_SIZE);
  const visibleDiffCols = QTY_DIFF_COLS.filter((c) => QTY_VISIBLE_DIFFS.has(c.key));
  wrap.innerHTML = `
    <div class="table-wrap"><table class="data" id="qtyTable">
    <thead><tr>
      <th>分类</th><th>设备型号</th><th>品牌</th><th>单位</th>
      <th>图纸数量</th><th>清单数量</th><th>到货数量</th><th>安装数量</th>
      ${visibleDiffCols.map((c) => `<th>${c.label}</th>`).join("")}
      <th>备注</th><th>更新</th><th></th>
    </tr></thead>
    <tbody>
      ${pageRows.map((r) => `
        <tr>
          <td>${escapeHTML(r.category)}</td>
          <td><b>${escapeHTML(r.device_name)}</b></td>
          <td>${escapeHTML(r.brand)}</td>
          <td>${escapeHTML(r.unit)}</td>
          <td class="mono">${fmtNum(r.drawing_qty)}</td>
          <td class="mono">${fmtNum(r.list_qty)}</td>
          <td class="mono">${fmtNum(r.arrival_qty)}</td>
          <td class="mono"><b>${fmtNum(r.actual_qty)}</b></td>
          ${visibleDiffCols.map((c) => `<td>${diffTag(r[c.key], c.posText, c.negText)}</td>`).join("")}
          <td class="remark">${escapeHTML(r.remark)}</td>
          <td class="mono" style="font-size:11px;color:var(--text-dim)">${escapeHTML(r.updated_by)}<br>${escapeHTML(r.updated_at)}</td>
          <td>
            ${hasPerm("quantity") ? `<button class="btn btn-outline btn-sm" onclick="openQuantityForm(${r.id})">编辑</button>` : ""}
            ${ME.role === "admin" ? `<button class="btn btn-danger btn-sm" onclick="deleteQuantityRow(${r.id})">删除</button>` : ""}
          </td>
        </tr>
      `).join("")}
    </tbody>
    </table></div>
  `;
  renderPager("qtyPager", rows.length, QTY_PAGE, QTY_PAGE_SIZE,
    (p) => { QTY_PAGE = p; paintQuantityTable(); },
    (sz) => { QTY_PAGE_SIZE = sz; QTY_PAGE = 1; paintQuantityTable(); });
}

// preset:连续新增时沿用上一条的分类/品牌/单位,免得每条都重选
function openQuantityForm(id, preset) {
  const row = id ? QTY_CACHE.find((r) => r.id === id) : (preset || null);
  // 新增时数量留空(placeholder 显示 0),直接输入即可;编辑时显示原值,聚焦自动全选
  const qv = (v) => (id ? (v ?? 0) : "");
  openModal(`
    <h2>${id ? "编辑设备项" : "新增设备项"}</h2>
    <div class="grid2">
      <div class="field"><label>总分类 *</label>${mainCategorySelectHTML("fCategory", row?.category_id)}</div>
      <div class="field"><label>子分类</label>${subCategorySelectHTML("fSubCategory", row?.category_id || 0, row?.sub_category_id)}</div>
      <div class="field grid1"><label>设备型号 *</label><input id="fName" value="${escapeHTML(row?.device_name || "")}" placeholder="需与安装数量登记里的设备型号一致才能自动同步"></div>
      <div class="field"><label>设备品牌</label><input id="fBrand" value="${escapeHTML(row?.brand || "")}"></div>
      <div class="field"><label>单位</label><input id="fUnit" value="${escapeHTML(row?.unit || "台")}"></div>
      <div class="field"><label>图纸数量</label><input id="fDrawing" type="number" inputmode="decimal" step="any" min="0" placeholder="0" value="${qv(row?.drawing_qty)}"></div>
      <div class="field"><label>清单数量</label><input id="fList" type="number" inputmode="decimal" step="any" min="0" placeholder="0" value="${qv(row?.list_qty)}"></div>
      <div class="field"><label>到货数量</label><input id="fArrival" type="number" inputmode="decimal" step="any" min="0" placeholder="0" value="${qv(row?.arrival_qty)}"></div>
      <div class="field"><label>安装数量</label><input id="fActual" type="number" inputmode="decimal" step="any" min="0" placeholder="0" value="${qv(row?.actual_qty)}"></div>
      <div class="field grid1"><label>备注</label><input id="fRemark" value="${escapeHTML(row?.remark || "")}"></div>
    </div>
    <p style="color:var(--text-dim);font-size:12px;margin-top:4px;">提示:如果"现场安装数量登记"模块里有相同 总分类+子分类+设备型号 的记录,安装数量会被自动同步覆盖。</p>
    ${!mainCategories().length ? `<p style="color:var(--red);font-size:12.5px;">暂无可选分类,请先到"分类管理"页面新增总分类</p>` : ""}
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      ${id ? "" : `<button class="btn btn-cyan" id="qtySaveNextBtn">保存并继续新增</button>`}
      <button class="btn btn-primary" id="qtySaveBtn">保存</button>
    </div>
  `);
  bindCategoryCascade("fCategory", "fSubCategory", null, true);
  const saveQty = async (keepOpen) => {
    const data = {
      project_id: CUR_PROJECT,
      category_id: parseInt(document.getElementById("fCategory").value) || 0,
      sub_category_id: parseInt(document.getElementById("fSubCategory").value) || 0,
      device_name: document.getElementById("fName").value.trim(),
      brand: document.getElementById("fBrand").value.trim(),
      unit: document.getElementById("fUnit").value.trim(),
      drawing_qty: parseFloat(document.getElementById("fDrawing").value) || 0,
      list_qty: parseFloat(document.getElementById("fList").value) || 0,
      arrival_qty: parseFloat(document.getElementById("fArrival").value) || 0,
      actual_qty: parseFloat(document.getElementById("fActual").value) || 0,
      remark: document.getElementById("fRemark").value.trim(),
    };
    if (!data.category_id) { toast("请选择总分类", "err"); return; }
    if (!data.device_name) { toast("设备型号不能为空", "err"); return; }
    try {
      if (id) await apiJSON("/quantity/" + id, "PUT", data);
      else await apiJSON("/quantity", "POST", data);
      toast("保存成功");
      loadQuantity();
      if (keepOpen) {
        openQuantityForm(null, { category_id: data.category_id, sub_category_id: data.sub_category_id, brand: data.brand, unit: data.unit });
      } else {
        closeModal();
      }
    } catch (e) {}
  };
  bindSubmitOnce(document.getElementById("qtySaveBtn"), () => saveQty(false));
  bindSubmitOnce(document.getElementById("qtySaveNextBtn"), () => saveQty(true));
  // 新增时光标直接落在设备型号上;型号 → 数量一路 Tab/回车
  document.getElementById("fName")?.focus();
}

async function deleteQuantityRow(id) {
  if (!confirm("确认删除该设备项?此操作将记录在修改日志中。")) return;
  try {
    await api("/quantity/" + id, { method: "DELETE" });
    toast("已删除");
    loadQuantity();
  } catch (e) {}
}
