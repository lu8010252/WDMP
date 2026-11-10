/* ============================================================
   模块:分类管理(总分类 / 子分类)
   ============================================================ */
let CAT_PAGE = 1, CAT_PAGE_SIZE = 10;
async function renderCategoriesView() {
  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="page-head">
      <h1>分类管理</h1>
      <span class="sub">设备台账 / 工程量对比 / 安装数量登记 通用的总分类与子分类</span>
    </div>
    <div class="toolbar">
      <div class="fill"></div>
      ${hasPerm("categories") ? `<button class="btn btn-cyan btn-sm" id="catAddMainBtn">+ 新增总分类</button>` : `<span style="color:var(--text-dim);font-size:12.5px;">只读模式,如需新增/编辑请联系管理员授权</span>`}
    </div>
    <div id="catList"></div>
    <div id="catPager"></div>
  `;
  if (hasPerm("categories")) {
    document.getElementById("catAddMainBtn").addEventListener("click", () => openCategoryForm(0, null));
  }
  CAT_PAGE = 1;
  await loadCategories();
  paintCategoryList();
}

function paintCategoryList() {
  const el = document.getElementById("catList");
  const mains = mainCategories();
  if (!mains.length) {
    el.innerHTML = `<div class="empty-state"><div class="big">&#128193;</div>暂无分类,请先新增总分类(如: 监控系统 / 广播系统 / 门禁系统)</div>`;
    document.getElementById("catPager").innerHTML = "";
    return;
  }
  CAT_PAGE = clampPage(CAT_PAGE, mains.length, CAT_PAGE_SIZE);
  const pageMains = paginate(mains, CAT_PAGE, CAT_PAGE_SIZE);
  el.innerHTML = pageMains.map((m) => {
    const subs = subCategories(m.id);
    return `
      <div class="card panel">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
          <b style="font-size:15px;">${escapeHTML(m.name)}</b>
          <span class="tag tag-idle">总分类</span>
          <div class="fill"></div>
          ${hasPerm("categories") ? `
          <button class="btn btn-outline btn-sm" onclick="openCategoryForm(${m.id}, null)">+ 添加子分类</button>
          <button class="btn btn-outline btn-sm" onclick="editCategory(${m.id}, '${escapeHTML(m.name)}')">编辑</button>
          ` : ""}
          ${ME.role === "admin" ? `<button class="btn btn-danger btn-sm" onclick="deleteCategoryRow(${m.id}, true)">删除</button>` : ""}
        </div>
        ${subs.length ? `
          <div style="display:flex;flex-wrap:wrap;gap:8px;">
            ${subs.map((sc) => `
              <span class="tag tag-ok" style="display:inline-flex;align-items:center;gap:6px;padding:4px 6px 4px 10px;">
                ${escapeHTML(sc.name)}
                ${hasPerm("categories") ? `<button style="border:none;background:none;color:inherit;cursor:pointer;font-size:12px;" onclick="editCategory(${sc.id}, '${escapeHTML(sc.name)}')">&#9998;</button>` : ""}
                ${ME.role === "admin" ? `<button style="border:none;background:none;color:inherit;cursor:pointer;font-size:12px;" onclick="deleteCategoryRow(${sc.id}, false)">&times;</button>` : ""}
              </span>
            `).join("")}
          </div>
        ` : `<div style="color:var(--text-dim);font-size:12.5px;">暂无子分类</div>`}
      </div>
    `;
  }).join("");
  renderPager("catPager", mains.length, CAT_PAGE, CAT_PAGE_SIZE,
    (p) => { CAT_PAGE = p; paintCategoryList(); },
    (sz) => { CAT_PAGE_SIZE = sz; CAT_PAGE = 1; paintCategoryList(); });
}

function openCategoryForm(parentId, unused) {
  const parentName = parentId ? categoryName(parentId) : "";
  openModal(`
    <h2>${parentId ? `新增子分类(所属: ${escapeHTML(parentName)})` : "新增总分类"}</h2>
    <div class="field"><label>分类名称 *</label><input id="fCatName" placeholder="${parentId ? "如: 枪机 / 半球机" : "如: 监控系统"}"></div>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="catSaveBtn">保存</button>
    </div>
  `);
  bindSubmitOnce(document.getElementById("catSaveBtn"), async () => {
    const name = document.getElementById("fCatName").value.trim();
    if (!name) { toast("分类名称不能为空", "err"); return; }
    try {
      await apiJSON("/categories", "POST", { name, parent_id: parentId || 0 });
      toast("新增成功");
      closeModal();
      await loadCategories();
      paintCategoryList();
    } catch (e) {}
  });
}

function editCategory(id, curName) {
  openModal(`
    <h2>编辑分类</h2>
    <div class="field"><label>分类名称 *</label><input id="fCatName" value="${escapeHTML(curName)}"></div>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="catEditBtn">保存</button>
    </div>
  `);
  bindSubmitOnce(document.getElementById("catEditBtn"), async () => {
    const name = document.getElementById("fCatName").value.trim();
    if (!name) { toast("分类名称不能为空", "err"); return; }
    try {
      await apiJSON("/categories/" + id, "PUT", { name });
      toast("保存成功");
      closeModal();
      await loadCategories();
      paintCategoryList();
    } catch (e) {}
  });
}

async function deleteCategoryRow(id, isMain) {
  let counts = {};
  try {
    counts = await api("/categories/" + id + "/impact");
  } catch (e) {}
  const parts = [];
  if (counts.devices) parts.push(`设备台账 ${counts.devices} 条`);
  if (counts.quantity) parts.push(`工程量对比 ${counts.quantity} 条`);
  if (counts.install) parts.push(`安装数量登记 ${counts.install} 条`);
  if (isMain && counts.sub_categories) parts.push(`子分类 ${counts.sub_categories} 个`);
  const msg = parts.length
    ? `删除该${isMain ? "总分类" : "子分类"}将连同以下数据一并永久删除,且无法恢复:\n\n${parts.join("\n")}\n\n确认要删除吗?`
    : `该${isMain ? "总分类" : "子分类"}暂无关联数据,确认删除?`;
  if (!confirm(msg)) return;
  try {
    await api("/categories/" + id, { method: "DELETE" });
    toast("已删除");
    await loadCategories();
    paintCategoryList();
  } catch (e) {}
}
