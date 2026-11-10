/* ============================================================
   模块:修改日志(操作审计)
   ============================================================ */
let AUDIT_PAGE = 1;
const ENTITY_LABELS = {
  quantity_item: "工程量对比", terminal_device: "设备台账", core_device: "核心密码本",
  switch: "交换机", switch_port: "交换机端口", project: "项目", user: "用户", backup: "数据备份",
  category_main: "分类管理(总分类)", category_sub: "分类管理(子分类)", install_record: "安装数量登记",
  audit_log: "日志清理",
};

async function renderAuditView() {
  AUDIT_PAGE = 1;
  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="page-head">
      <h1>修改日志</h1>
      <span class="sub">全量记录:修改人 · 操作时间 · 修改项 · 变更前后内容</span>
    </div>
    <div class="toolbar">
      <select id="auditEntityFilter">
        <option value="">全部模块</option>
        ${Object.entries(ENTITY_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
      </select>
      <input type="text" id="auditUserFilter" placeholder="按操作人筛选">
      <button class="btn btn-outline btn-sm" id="auditSearchBtn">查询</button>
      <div class="fill"></div>
      ${ME.role === "admin" ? `<button class="btn btn-danger btn-sm" id="auditCleanupBtn">清理历史日志</button>` : ""}
    </div>
    <div id="auditList"></div>
    <div class="pagination" id="auditPager"></div>
  `;
  document.getElementById("auditSearchBtn").addEventListener("click", () => { AUDIT_PAGE = 1; loadAudit(); });
  const cleanupBtn = document.getElementById("auditCleanupBtn");
  if (cleanupBtn) cleanupBtn.addEventListener("click", openAuditCleanupDialog);
  await loadAudit();
}

function openAuditCleanupDialog() {
  openModal(`
    <h2>清理历史日志</h2>
    <p style="color:var(--text-dim);font-size:13px;line-height:1.6;">
      清理后无法恢复。建议只清理很久之前、确认不再需要追溯的记录。清理这个操作本身也会被记一条新日志。
    </p>
    <div class="field"><label>保留最近多少天,更早的将被清理 *</label><input id="cleanupDays" type="number" value="180" min="1"></div>
    <div id="cleanupPreview" style="font-size:13px;color:var(--text-dim);margin-top:6px;"></div>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-danger" id="cleanupConfirmBtn">预览并清理</button>
    </div>
  `);
  bindSubmitOnce(document.getElementById("cleanupConfirmBtn"), async () => {
    const days = parseInt(document.getElementById("cleanupDays").value);
    if (!days || days <= 0) { toast("请填写有效的天数", "err"); return; }
    const previewEl = document.getElementById("cleanupPreview");
    try {
      const preview = await api("/audit/cleanup-preview?days=" + days);
      if (preview.count === 0) {
        previewEl.textContent = `没有需要清理的日志(${preview.cutoff} 之前没有记录)`;
        return;
      }
      if (!confirm(`将永久删除 ${preview.count} 条 ${preview.cutoff} 之前的日志,此操作不可恢复,确认继续?`)) return;
      const r = await apiJSON("/audit/cleanup", "POST", { days });
      toast(`已清理 ${r.deleted} 条历史日志`);
      closeModal();
      AUDIT_PAGE = 1;
      loadAudit();
    } catch (e) {}
  });
}

function auditActionLabel(a) {
  return { create: "新增", update: "修改", delete: "删除", read: "查看", checkin: "现场核验" }[a] || a;
}

async function loadAudit() {
  const entity = document.getElementById("auditEntityFilter").value;
  const username = document.getElementById("auditUserFilter").value.trim();
  const qs = new URLSearchParams({ page: AUDIT_PAGE });
  if (entity) qs.set("entity", entity);
  if (username) qs.set("username", username);
  const r = await api("/audit?" + qs.toString());
  const el = document.getElementById("auditList");
  if (!r.items || !r.items.length) {
    el.innerHTML = `<div class="empty-state"><div class="big">&#128220;</div>暂无匹配的操作记录</div>`;
  } else {
    el.innerHTML = r.items.map((it) => `
      <div class="audit-item">
        <div class="meta">${it.created_at} · ${escapeHTML(it.username)} · ${auditActionLabel(it.action)} · ${ENTITY_LABELS[it.entity] || it.entity} #${it.record_id} · 字段: ${escapeHTML(it.field)}</div>
        <div class="chg">
          ${it.before_val ? `<span class="audit-before">${escapeHTML(it.before_val)}</span> → ` : ""}
          <span class="audit-after">${escapeHTML(it.after_val || "(空)")}</span>
        </div>
      </div>
    `).join("");
  }
  const totalPages = Math.max(1, Math.ceil(r.total / 50));
  document.getElementById("auditPager").innerHTML = `
    <button class="btn btn-outline btn-sm" ${AUDIT_PAGE <= 1 ? "disabled" : ""} onclick="changeAuditPage(-1)">上一页</button>
    <span>第 ${AUDIT_PAGE} / ${totalPages} 页 · 共 ${r.total} 条</span>
    <button class="btn btn-outline btn-sm" ${AUDIT_PAGE >= totalPages ? "disabled" : ""} onclick="changeAuditPage(1)">下一页</button>
  `;
}
function changeAuditPage(delta) {
  AUDIT_PAGE += delta;
  loadAudit();
}

/* ============================================================
   模块:项目管理
   ============================================================ */
async function renderProjectsView() {
  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="page-head"><h1>项目管理</h1><span class="sub">按项目/区域组织设备与工程量数据</span></div>
    <div class="toolbar"><div class="fill"></div>${hasPerm("projects") ? `<button class="btn btn-cyan btn-sm" id="projAddBtn">+ 新增项目</button>` : `<span style="color:var(--text-dim);font-size:12.5px;">只读模式,如需新增项目请联系管理员授权</span>`}</div>
    <div id="projTableWrap"></div>
  `;
  if (hasPerm("projects")) {
    document.getElementById("projAddBtn").addEventListener("click", openProjectForm);
  }
  await loadProjectsView();
}
async function loadProjectsView() {
  await loadProjects();
  const wrap = document.getElementById("projTableWrap");
  if (!PROJECTS.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="big">&#127959;</div>暂无项目,请先新增</div>`;
    return;
  }
  wrap.innerHTML = `
    <div class="table-wrap"><table class="data" id="projTable">
    <thead><tr><th>项目名称</th><th>区域</th><th>创建时间</th><th></th></tr></thead>
    <tbody>${PROJECTS.map((p) => `
      <tr><td><b>${escapeHTML(p.name)}</b></td><td>${escapeHTML(p.area)}</td><td class="mono">${escapeHTML(p.created_at)}</td>
      <td>${ME.role === "admin" ? `<button class="btn btn-danger btn-sm" onclick="deleteProjectRow(${p.id})">删除</button>` : ""}</td></tr>
    `).join("")}</tbody>
    </table></div>
  `;
}
function openProjectForm() {
  openModal(`
    <h2>新增项目</h2>
    <div class="grid2">
      <div class="field"><label>项目名称 *</label><input id="fPName"></div>
      <div class="field"><label>区域</label><input id="fPArea" placeholder="如: A栋/1-3层"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="projSaveBtn">保存</button>
    </div>
  `);
  bindSubmitOnce(document.getElementById("projSaveBtn"), async () => {
    const name = document.getElementById("fPName").value.trim();
    const area = document.getElementById("fPArea").value.trim();
    if (!name) { toast("项目名称不能为空", "err"); return; }
    try {
      await apiJSON("/projects", "POST", { name, area });
      toast("新增成功");
      closeModal();
      loadProjectsView();
    } catch (e) {}
  });
}
async function deleteProjectRow(id) {
  let counts = {};
  try {
    counts = await api("/projects/" + id + "/impact");
  } catch (e) {}
  const parts = [];
  if (counts.devices) parts.push(`设备台账 ${counts.devices} 条`);
  if (counts.quantity) parts.push(`工程量 ${counts.quantity} 条`);
  if (counts.install) parts.push(`安装登记 ${counts.install} 条`);
  if (counts.vault) parts.push(`密码本 ${counts.vault} 条`);
  if (counts.switches) parts.push(`交换机 ${counts.switches} 条`);
  const msg = parts.length
    ? `删除该项目将连同以下数据一并永久删除,且无法恢复:\n\n${parts.join("\n")}\n\n确认要删除吗?`
    : "该项目下暂无关联数据,确认删除?";
  if (!confirm(msg)) return;
  try {
    await api("/projects/" + id, { method: "DELETE" });
    toast("已删除");
    loadProjectsView();
  } catch (e) {}
}

/* ============================================================
   模块:用户管理(仅管理员)
   ============================================================ */
// PERMISSION_MODULE_LABELS 要和后端 auth.go 里的 PERMISSION_MODULES 保持一致
const PERMISSION_MODULE_LABELS = {
  projects: "项目管理(新增/编辑)",
  categories: "分类管理(新增/编辑)",
  quantity: "工程量对比(新增/编辑)",
  install: "现场安装数量登记(新增/编辑)",
  devices: "设备台账(新增/编辑)",
  vault: "核心密码本(未授权则完全不可见)",
  network: "网络与交换机(新增/编辑)",
};

async function renderUsersView() {
  if (ME.role !== "admin") { switchView("quantity"); return; }
  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="page-head"><h1>用户管理</h1><span class="sub">管理员 / 施工人员账号,新注册的账号默认没有任何权限,需要在这里手动分配</span></div>
    <div class="toolbar"><div class="fill"></div><button class="btn btn-cyan btn-sm" id="userAddBtn">+ 新增用户</button></div>
    <div class="table-wrap"><table class="data" id="userTable"></table></div>
  `;
  document.getElementById("userAddBtn").addEventListener("click", openUserForm);
  await loadUsers();
}
async function loadUsers() {
  const list = await api("/users");
  const tbl = document.getElementById("userTable");
  tbl.innerHTML = `
    <thead><tr><th>用户名</th><th>角色</th><th>已授权模块</th><th>可访问项目</th><th>创建时间</th><th></th></tr></thead>
    <tbody>${list.map((u) => `
      <tr>
        <td><b>${escapeHTML(u.username)}</b></td>
        <td>${u.role === "admin" ? '<span class="tag tag-ok">管理员</span>' : '<span class="tag tag-idle">施工人员</span>'}</td>
        <td>${permissionTagsHTML(u)}</td>
        <td>${projectScopeTagsHTML(u)}</td>
        <td class="mono">${escapeHTML(u.created_at)}</td>
        <td>
          <button class="btn btn-outline btn-sm" onclick="openPermissionForm(${u.id}, '${escapeHTML(u.username)}', '${u.role}', ${JSON.stringify(u.permissions)}, ${JSON.stringify(u.project_scope || [])})">分配权限</button>
          <button class="btn btn-outline btn-sm" onclick="resetPasswordPrompt(${u.id}, '${escapeHTML(u.username)}')">重置密码</button>
          ${u.id !== ME.id ? `<button class="btn btn-danger btn-sm" onclick="deleteUserRow(${u.id})">删除</button>` : ""}
        </td>
      </tr>
    `).join("")}</tbody>
  `;
}
function permissionTagsHTML(u) {
  if (u.role === "admin") return `<span style="color:var(--text-dim);font-size:12px;">全部模块(管理员)</span>`;
  if (!u.permissions || !u.permissions.length) return `<span class="tag tag-idle">只读(未授权任何编辑权限)</span>`;
  return u.permissions.map((m) => `<span class="tag tag-ok" style="margin:2px 3px 2px 0;">${escapeHTML(PERMISSION_MODULE_LABELS[m] || m)}</span>`).join("");
}
function projectScopeTagsHTML(u) {
  if (u.role === "admin") return `<span style="color:var(--text-dim);font-size:12px;">全部项目(管理员)</span>`;
  if (!u.project_scope || !u.project_scope.length) return `<span class="tag tag-ok">全部项目</span>`;
  return u.project_scope.map((pid) => {
    const p = PROJECTS.find((x) => x.id === pid);
    return `<span class="tag tag-idle" style="margin:2px 3px 2px 0;">${escapeHTML(p ? p.name : "#" + pid)}</span>`;
  }).join("");
}
function permissionChecklistHTML(checkedList) {
  const checked = new Set(checkedList || []);
  return Object.entries(PERMISSION_MODULE_LABELS).map(([key, label]) => `
    <label style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--line);font-size:13.5px;">
      <input type="checkbox" class="perm-check" value="${key}" ${checked.has(key) ? "checked" : ""}>
      ${escapeHTML(label)}
    </label>
  `).join("");
}
// projectScopeChecklistHTML 渲染"限制该用户只能访问哪些项目"的勾选列表。
// 不勾选任何项目 = 不限制(能看到所有项目,包括以后新建的),这是老账号升级后的默认行为,
// 所以顶部放一个更醒目的"不限制"开关,勾了之后就把下面的项目复选框整体禁用、清空选中状态。
function projectScopeChecklistHTML(checkedIds) {
  const checked = new Set(checkedIds || []);
  const unrestricted = checked.size === 0;
  const projectRows = PROJECTS.map((p) => `
    <label style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--line);font-size:13.5px;">
      <input type="checkbox" class="proj-scope-check" value="${p.id}" ${checked.has(p.id) ? "checked" : ""} ${unrestricted ? "disabled" : ""}>
      ${escapeHTML(p.name)}
    </label>
  `).join("") || `<p style="color:var(--text-dim);font-size:13px;">暂无项目</p>`;
  return `
    <label style="display:flex;align-items:center;gap:8px;padding:7px 0;font-size:13.5px;">
      <input type="checkbox" id="scopeUnrestricted" ${unrestricted ? "checked" : ""}>
      不限制项目范围(能看到全部项目,包括以后新建的)
    </label>
    <div id="scopeProjectList" style="${unrestricted ? "opacity:.5;" : ""}">${projectRows}</div>
  `;
}
// bindProjectScopeToggle 让"不限制"开关和下面的项目复选框联动:勾上就禁用+置灰下面的列表
function bindProjectScopeToggle() {
  const toggle = document.getElementById("scopeUnrestricted");
  const listWrap = document.getElementById("scopeProjectList");
  if (!toggle) return;
  toggle.addEventListener("change", () => {
    listWrap.style.opacity = toggle.checked ? ".5" : "1";
    listWrap.querySelectorAll(".proj-scope-check").forEach((c) => {
      c.disabled = toggle.checked;
      if (toggle.checked) c.checked = false;
    });
  });
}
// readProjectScopeSelection 读取表单里选中的项目ID列表;勾了"不限制"就返回空数组
function readProjectScopeSelection() {
  if (document.getElementById("scopeUnrestricted").checked) return [];
  return Array.from(document.querySelectorAll(".proj-scope-check:checked")).map((c) => parseInt(c.value));
}
function openUserForm() {
  openModal(`
    <h2>新增用户</h2>
    <div class="grid2">
      <div class="field"><label>用户名 *</label><input id="fUName"></div>
      <div class="field"><label>初始密码 *</label><input id="fUPass" type="text"></div>
      <div class="field grid1"><label>角色</label>
        <select id="fURole"><option value="worker">施工人员</option><option value="admin">管理员</option></select>
      </div>
    </div>
    <div class="field grid1" id="fUPermWrap">
      <label>模块权限(角色为"施工人员"时生效,管理员默认拥有全部权限)</label>
      ${permissionChecklistHTML([])}
    </div>
    <div class="field grid1" id="fUScopeWrap">
      <label>可访问项目(角色为"施工人员"时生效,管理员始终能看全部项目)</label>
      ${projectScopeChecklistHTML([])}
    </div>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="userSaveBtn">保存</button>
    </div>
  `);
  bindProjectScopeToggle();
  const roleSel = document.getElementById("fURole");
  const permWrap = document.getElementById("fUPermWrap");
  const scopeWrap = document.getElementById("fUScopeWrap");
  roleSel.addEventListener("change", () => {
    permWrap.style.display = roleSel.value === "admin" ? "none" : "";
    scopeWrap.style.display = roleSel.value === "admin" ? "none" : "";
  });
  bindSubmitOnce(document.getElementById("userSaveBtn"), async () => {
    const username = document.getElementById("fUName").value.trim();
    const password = document.getElementById("fUPass").value;
    const role = roleSel.value;
    const permissions = Array.from(document.querySelectorAll(".perm-check:checked")).map((c) => c.value);
    const project_scope = readProjectScopeSelection();
    if (!username || !password) { toast("用户名和密码不能为空", "err"); return; }
    try {
      await apiJSON("/users", "POST", { username, password, role, permissions, project_scope });
      toast("新增用户成功");
      closeModal();
      loadUsers();
    } catch (e) {}
  });
}
function openPermissionForm(id, username, role, permissions, projectScope) {
  openModal(`
    <h2>分配权限 - ${escapeHTML(username)}</h2>
    <div class="field grid1">
      <label>角色</label>
      <select id="fPermRole">
        <option value="worker" ${role !== "admin" ? "selected" : ""}>施工人员(按下方勾选的模块和项目授权)</option>
        <option value="admin" ${role === "admin" ? "selected" : ""}>管理员(自动拥有全部模块和项目权限)</option>
      </select>
    </div>
    <div class="field grid1" id="fPermWrap" style="${role === "admin" ? "display:none;" : ""}">
      <label>模块权限</label>
      ${permissionChecklistHTML(permissions)}
      <p style="color:var(--text-dim);font-size:12px;margin-top:6px;">未勾选的模块:除"核心密码本"外都是只读(能看不能新增/编辑),"核心密码本"未勾选则完全不可见。删除操作不受此处控制,始终只有管理员能删除。</p>
    </div>
    <div class="field grid1" id="fScopeWrap" style="${role === "admin" ? "display:none;" : ""}">
      <label>可访问项目</label>
      ${projectScopeChecklistHTML(projectScope)}
      <p style="color:var(--text-dim);font-size:12px;margin-top:6px;">被限制项目范围的账号,在所有模块(工程量、设备台账、核心密码本、交换机等)里都只能看到和操作勾选的项目,搜索结果也一并过滤。</p>
    </div>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="permSaveBtn">保存</button>
    </div>
  `);
  bindProjectScopeToggle();
  const roleSel = document.getElementById("fPermRole");
  const permWrap = document.getElementById("fPermWrap");
  const scopeWrap = document.getElementById("fScopeWrap");
  roleSel.addEventListener("change", () => {
    permWrap.style.display = roleSel.value === "admin" ? "none" : "";
    scopeWrap.style.display = roleSel.value === "admin" ? "none" : "";
  });
  bindSubmitOnce(document.getElementById("permSaveBtn"), async () => {
    const newRole = roleSel.value;
    const newPerms = Array.from(document.querySelectorAll(".perm-check:checked")).map((c) => c.value);
    const newScope = readProjectScopeSelection();
    try {
      await apiJSON("/users/" + id + "/permissions", "PUT", { role: newRole, permissions: newPerms, project_scope: newScope });
      toast("权限已更新,对方无需重新登录即可生效");
      closeModal();
      loadUsers();
    } catch (e) {}
  });
}
function resetPasswordPrompt(id, username) {
  openModal(`
    <h2>重置密码 - ${escapeHTML(username)}</h2>
    <div class="field"><label>新密码 *</label><input id="fNewPw" type="text"></div>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="resetPwBtn">确认重置</button>
    </div>
  `);
  bindSubmitOnce(document.getElementById("resetPwBtn"), async () => {
    const pw = document.getElementById("fNewPw").value;
    if (!pw) { toast("新密码不能为空", "err"); return; }
    try {
      await apiJSON("/users/" + id + "/password", "PUT", { password: pw });
      toast("密码重置成功");
      closeModal();
    } catch (e) {}
  });
}
async function deleteUserRow(id) {
  if (!confirm("确认删除该用户?")) return;
  try {
    await api("/users/" + id, { method: "DELETE" });
    toast("已删除");
    loadUsers();
  } catch (e) {}
}

/* ============================================================
   模块:数据备份
   ============================================================ */
async function renderBackupView() {
  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="page-head"><h1>数据备份</h1><span class="sub">导出 / 恢复 SQLite 数据库文件(.db),建议定期备份至本地</span></div>
    <div class="card panel" style="max-width:560px;">
      <b style="font-size:14.5px;">导出备份</b>
      <p style="color:var(--text-dim);font-size:13.5px;line-height:1.7;margin-top:6px;">
        点击下方按钮将打包生成一份完整备份并下载(<span class="mono">.tar.gz</span>),内含<b>数据库</b>(全部项目、设备台账、密码本密文、操作日志)、
        密码本的<b>加密密钥</b>、以及全部<b>设备照片</b>——三样一起备份,才能保证换机器 / 重装后能完整恢复(只备份数据库的话,密码本会因为丢了密钥而永久打不开,照片也会全部失效)。
      </p>
      ${ME.role === "admin"
        ? `<button class="btn btn-primary" id="doBackupBtn">立即导出数据库备份</button>`
        : `<p style="color:var(--red);font-size:13px;">仅管理员可执行数据库备份导出</p>`}
    </div>
    ${ME.role === "admin" ? `
    <div class="card panel" style="max-width:560px;margin-top:16px;">
      <b style="font-size:14.5px;">自动备份</b>
      <div id="autoBackupStatus" style="margin-top:8px;color:var(--text-dim);font-size:13px;">加载中...</div>
      <div id="autoBackupList" style="margin-top:10px;"></div>
    </div>
    <div class="card panel" style="max-width:560px;margin-top:16px;">
      <b style="font-size:14.5px;color:var(--red);">恢复备份(数据导入)</b>
      <p style="color:var(--text-dim);font-size:13.5px;line-height:1.7;margin-top:6px;">
        上传此前导出的完整备份包(<span class="mono">.tar.gz</span>,会自动一起恢复数据库、密钥、照片),或者升级前导出的旧版纯数据库文件(<span class="mono">.db</span>,兼容识别,但只能恢复数据库本身)。
        服务端会自动识别文件格式,校验通过后<b style="color:var(--red);">整体替换当前数据</b>。
        恢复前会自动把当前的数据库/密钥/照片都留一份底(文件/目录名以 <span class="mono">before_restore_</span> 开头,保存在服务器数据目录),万一恢复出错还能找回。
      </p>
      <p style="color:var(--red);font-size:12.5px;line-height:1.6;">
        ⚠️ 恢复会用备份里的数据<b>完全覆盖</b>当前数据,恢复后所有人(包括你自己)需要重新登录,请务必确认备份文件是你真正想要的版本。
      </p>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px;">
        <input type="file" id="restoreFile">
        <button class="btn btn-danger" id="doRestoreBtn" disabled>恢复此备份</button>
      </div>
    </div>
    <div class="card panel" style="max-width:560px;margin-top:16px;">
      <b style="font-size:14.5px;">照片存储清理</b>
      <p style="color:var(--text-dim);font-size:13.5px;line-height:1.7;margin-top:6px;">
        设备/安装记录删除后,原先关联的照片文件不会自动删除(还留着以防万一);另外从这次更新起,内容完全相同的照片会自动合并成一个文件,
        但更新之前已经存在的重复照片不会自动处理。这里可以一键检查并清理这两类情况,释放存储空间。
      </p>
      <button class="btn btn-outline" id="photoAuditBtn">检查一下</button>
      <div id="photoAuditResult" style="margin-top:12px;"></div>
    </div>
    ` : ""}
  `;
  if (ME.role === "admin") {
    document.getElementById("doBackupBtn").addEventListener("click", () => {
      window.location = API + "/backup/download";
      toast("正在生成备份文件,请稍候...");
    });
    const fileInput = document.getElementById("restoreFile");
    const restoreBtn = document.getElementById("doRestoreBtn");
    fileInput.addEventListener("change", () => {
      restoreBtn.disabled = !fileInput.files.length;
    });
    restoreBtn.addEventListener("click", () => doRestoreBackup(fileInput));
    loadAutoBackupInfo();
    document.getElementById("photoAuditBtn").addEventListener("click", runPhotoAudit);
  }
}

async function runPhotoAudit() {
  const box = document.getElementById("photoAuditResult");
  box.innerHTML = `<div style="color:var(--text-dim);font-size:13px;">检查中...</div>`;
  let r;
  try {
    r = await api("/photos/audit");
  } catch (e) {
    box.innerHTML = `<div style="color:var(--red);font-size:13px;">检查失败</div>`;
    return;
  }
  const wasteBytes = r.orphan_bytes + r.duplicate_bytes;
  box.innerHTML = `
    <div style="font-size:13px;line-height:2;color:var(--text-dim);">
      照片总数 <b style="color:var(--ink);">${r.total_files}</b> 个,共 <b style="color:var(--ink);">${fmtBackupSize(r.total_bytes)}</b><br>
      其中:未被任何记录引用的孤儿文件 <b style="color:${r.orphan_files ? "var(--red)" : "var(--ink)"};">${r.orphan_files}</b> 个(${fmtBackupSize(r.orphan_bytes)})<br>
      内容重复的文件 <b style="color:${r.duplicate_files ? "var(--red)" : "var(--ink)"};">${r.duplicate_files}</b> 个,分布在 ${r.duplicate_groups} 组(${fmtBackupSize(r.duplicate_bytes)})
    </div>
    ${wasteBytes > 0
      ? `<button class="btn btn-danger btn-sm" style="margin-top:10px;" id="photoCleanupBtn">立即清理,预计释放 ${fmtBackupSize(wasteBytes)}</button>`
      : `<div style="color:var(--green,#1e8e5a);font-size:13px;margin-top:8px;">没有需要清理的内容 👍</div>`}
  `;
  const cleanupBtn = document.getElementById("photoCleanupBtn");
  if (cleanupBtn) cleanupBtn.addEventListener("click", runPhotoCleanup);
}

async function runPhotoCleanup() {
  if (!confirm("确认清理吗?会合并内容相同的重复照片(自动更新相关设备/安装记录的引用),并删除没有任何记录引用的孤儿照片文件。此操作不可撤销。")) return;
  try {
    const r = await api("/photos/cleanup", { method: "POST" });
    toast(`清理完成:合并重复文件 ${r.duplicates_removed} 个,删除孤儿文件 ${r.orphans_removed} 个,释放 ${fmtBackupSize(r.freed_bytes)}`);
    runPhotoAudit();
  } catch (e) {}
}

async function loadAutoBackupInfo() {
  const statusEl = document.getElementById("autoBackupStatus");
  const listEl = document.getElementById("autoBackupList");
  try {
    const cfg = await api("/backup/config");
    statusEl.innerHTML = cfg.enabled
      ? `已启用:每 <b>${cfg.interval_hours}</b> 小时自动打包一次(数据库+密钥+照片),最多保留最近 <b>${cfg.keep_count}</b> 份(超出自动删除最旧的)`
      : `未启用。可在部署时设置环境变量 <span class="mono">BACKUP_INTERVAL_HOURS</span> 开启(默认24小时一次)`;
  } catch (e) {
    statusEl.textContent = "加载配置失败";
  }
  try {
    const list = await api("/backup/history");
    if (!list.length) {
      listEl.innerHTML = `<div style="color:var(--text-dim);font-size:12.5px;">暂无自动备份记录</div>`;
      return;
    }
    listEl.innerHTML = `
      <table class="data" style="font-size:12.5px;">
        <thead><tr><th>时间</th><th>文件名</th><th>大小</th><th></th></tr></thead>
        <tbody>
          ${list.map((b) => `
            <tr>
              <td>${escapeHTML(b.time)}</td>
              <td class="mono">${escapeHTML(b.name)}</td>
              <td class="mono">${fmtBackupSize(b.size)}</td>
              <td>
                <button class="btn btn-outline btn-sm" onclick="window.location='${API}/backup/history/${encodeURIComponent(b.name)}'">下载</button>
                <button class="btn btn-danger btn-sm" onclick="deleteAutoBackup('${escapeHTML(b.name)}')">删除</button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  } catch (e) {
    listEl.innerHTML = `<div style="color:var(--red);font-size:12.5px;">加载历史备份列表失败</div>`;
  }
}

function fmtBackupSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  return Math.round(bytes / 1024) + " KB";
}

async function deleteAutoBackup(name) {
  if (!confirm(`确认删除自动备份「${name}」?此操作不可恢复。`)) return;
  try {
    await api("/backup/history/" + encodeURIComponent(name), { method: "DELETE" });
    toast("已删除");
    loadAutoBackupInfo();
  } catch (e) {}
}

async function doRestoreBackup(fileInput) {
  const file = fileInput.files[0];
  if (!file) return;
  const ok = confirm(
    `即将用文件「${file.name}」整体覆盖当前数据库,这会替换掉全部项目、设备台账、密码本、操作日志等数据。\n\n` +
    `恢复完成后所有人(包括你自己)会被强制退出登录,需要用备份文件里的账号密码重新登录。\n\n` +
    `确认要恢复吗?此操作不可撤销(仅服务器上保留了恢复前的一份自动备份)。`
  );
  if (!ok) return;
  const fd = new FormData();
  fd.append("file", file);
  const restoreBtn = document.getElementById("doRestoreBtn");
  restoreBtn.disabled = true;
  restoreBtn.textContent = "正在恢复,请勿关闭页面...";
  try {
    const r = await api("/backup/restore", { method: "POST", body: fd });
    toast(r.message || "数据库已恢复,即将跳转到登录页");
    setTimeout(() => location.reload(), 1800);
  } catch (e) {
    restoreBtn.disabled = false;
    restoreBtn.textContent = "恢复此备份";
  }
}
