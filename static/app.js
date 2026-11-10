/* ============================================================
   弱电工程综合管理与运维平台 - 前端逻辑 (纯原生 JS,无构建步骤)
   ============================================================ */
const API = "/api";
let ME = null;
let PROJECTS = [];
let CUR_PROJECT = localStorage.getItem("wdmp_project") ? parseInt(localStorage.getItem("wdmp_project")) : 0;
let CUR_VIEW = "quantity";

/* ---------------- 基础请求封装 ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    credentials: "same-origin",
    headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {},
    ...opts,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("未登录");
  }
  const ct = res.headers.get("content-type") || "";
  if (!res.ok) {
    let msg = "请求失败";
    if (ct.includes("application/json")) {
      try { msg = (await res.json()).error || msg; } catch (e) {}
    }
    toast(msg, "err");
    throw new Error(msg);
  }
  if (ct.includes("application/json")) return res.json();
  return res;
}
function apiJSON(path, method, data) {
  return api(path, { method, body: JSON.stringify(data || {}) });
}

/* ---------------- Toast ---------------- */
function toast(msg, type = "ok") {
  const wrap = document.getElementById("toastWrap");
  const el = document.createElement("div");
  el.className = "toast " + (type === "err" ? "err" : type === "ok" ? "" : "");
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ---------------- 登录 / 会话 ---------------- */
function showLogin() {
  document.getElementById("loginView").style.display = "flex";
  document.getElementById("app").style.display = "none";
}
function showApp() {
  document.getElementById("loginView").style.display = "none";
  document.getElementById("app").style.display = "block";
}

// hasPerm 判断当前登录用户是否有权访问某个模块;admin 永远返回 true。
function hasPerm(module) {
  if (!ME) return false;
  if (ME.role === "admin") return true;
  return (ME.permissions || []).includes(module);
}
// PERMISSION_GATED_VIEWS 里只有 vault 会在导航栏被整页隐藏(未授权完全不可见);
// 其它模块现在对所有登录用户都开放查看,只是新增/编辑受 hasPerm() 控制,导航栏正常显示。
const PERMISSION_GATED_VIEWS = ["vault"];
// EDITABLE_MODULES 是"查看开放、编辑受限"的模块列表,各模块渲染时用 hasPerm() 判断是否显示新增/编辑/导入等按钮
const EDITABLE_MODULES = ["projects", "categories", "quantity", "install", "devices", "network"];

async function boot() {
  try {
    ME = await api("/me");
  } catch (e) {
    console.error("获取登录状态失败:", e);
    showLogin();
    return;
  }
  showApp();
  document.getElementById("curUser").textContent = ME.username;
  document.getElementById("curRole").textContent = ME.role === "admin" ? "管理员" : "施工人员";
  if (ME.role !== "admin") {
    document.getElementById("navUsers").style.display = "none";
  }
  document.querySelectorAll(".sidenav .nav-item").forEach((el) => {
    const view = el.dataset.view;
    if (PERMISSION_GATED_VIEWS.includes(view)) {
      el.style.display = hasPerm(view) ? "" : "none";
    }
  });

  // 新注册但还没被管理员分配任何编辑权限的账号,是"只读"状态而不是"完全没法用",
  // 所以不再拦截整个应用,只在顶部提示一下,各模块页面自己会隐藏新增/编辑相关的按钮。
  if (ME.role !== "admin" && !(ME.permissions || []).length) {
    toast("当前账号是只读模式,如需新增/编辑权限请联系管理员分配");
  }

  try {
    await loadProjects();
    await loadCategories();
    switchView("dashboard");
  } catch (e) {
    console.error("加载首页数据失败(已登录,但页面渲染出错):", e);
    toast("页面加载出错,请查看控制台", "err");
  }

  // 手机扫描设备标签上的二维码后,链接会带上 ?scan=设备ID 打开本页;
  // 登录并加载完首页数据后,自动弹出"现场核验"弹窗,不用再让工人手动去设备台账里找这台设备。
  const scanID = parseInt(new URLSearchParams(location.search).get("scan"));
  if (scanID) {
    // 用完就把参数从地址栏清掉,避免用户后续手动刷新页面时反复弹出同一个核验弹窗
    history.replaceState(null, "", location.pathname);
    openDeviceCheckin(scanID);
  }
}

document.getElementById("loginBtn").addEventListener("click", doLogin);
document.getElementById("loginPass").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
document.getElementById("loginUser").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

async function doLogin() {
  const u = document.getElementById("loginUser").value.trim();
  const p = document.getElementById("loginPass").value;
  const errEl = document.getElementById("loginErr");
  errEl.textContent = "";
  if (!u || !p) { errEl.textContent = "请输入用户名和密码"; return; }
  try {
    const res = await fetch(API + "/login", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      errEl.textContent = j.error || "登录失败";
      return;
    }
    await boot();
  } catch (e) {
    errEl.textContent = "网络错误,请检查服务是否可访问";
  }
}

// bindSubmitOnce 给"保存/提交"类按钮加一层防抖:点击后立刻禁用按钮、文案变成"处理中...",
// 等这次请求真正结束(不管成功还是失败)才恢复可点击状态。
// 主要解决手机卡顿或网络慢的时候,用户以为没反应又点了一次甚至好几次,导致后端收到多条重复的新增/提交请求。
function bindSubmitOnce(btn, handler) {
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (btn.disabled) return; // 正在处理上一次点击,直接忽略这次多余的点击
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "处理中...";
    try {
      await handler();
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
}

document.getElementById("changePwBtn").addEventListener("click", () => {
  openModal(`
    <h2>修改我的密码</h2>
    <div class="field"><label>旧密码</label><input id="cpOld" type="password" autocomplete="current-password"></div>
    <div class="field"><label>新密码(至少6位)</label><input id="cpNew" type="password" autocomplete="new-password"></div>
    <div class="field"><label>确认新密码</label><input id="cpNew2" type="password" autocomplete="new-password"></div>
    <p style="color:var(--text-dim);font-size:12px;">修改后,该账号在其它设备上的登录会全部下线。</p>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="cpSaveBtn">保存</button>
    </div>`);
  bindSubmitOnce(document.getElementById("cpSaveBtn"), async () => {
    const o = document.getElementById("cpOld").value, n = document.getElementById("cpNew").value, n2 = document.getElementById("cpNew2").value;
    if (!o) { toast("请输入旧密码", "err"); return; }
    if (n.length < 6) { toast("新密码至少6位", "err"); return; }
    if (n !== n2) { toast("两次输入的新密码不一致", "err"); return; }
    try {
      await apiJSON("/me/password", "PUT", { old_password: o, new_password: n });
      toast("密码已修改");
      closeModal();
    } catch (e) {}
  });
});
document.getElementById("logoutBtn").addEventListener("click", async () => {
  await api("/logout", { method: "POST" });
  ME = null;
  showLogin();
});

/* ---------------- 注册 ---------------- */
document.getElementById("showRegisterBtn").addEventListener("click", () => {
  document.getElementById("loginCard").style.display = "none";
  document.getElementById("registerCard").style.display = "block";
  document.getElementById("registerErr").textContent = "";
});
document.getElementById("showLoginBtn").addEventListener("click", () => {
  document.getElementById("registerCard").style.display = "none";
  document.getElementById("loginCard").style.display = "block";
  document.getElementById("loginErr").textContent = "";
});
document.getElementById("registerBtn").addEventListener("click", doRegister);
document.getElementById("regPass2").addEventListener("keydown", (e) => { if (e.key === "Enter") doRegister(); });

async function doRegister() {
  const u = document.getElementById("regUser").value.trim();
  const p = document.getElementById("regPass").value;
  const p2 = document.getElementById("regPass2").value;
  const errEl = document.getElementById("registerErr");
  errEl.textContent = "";
  if (!u || !p) { errEl.textContent = "请输入用户名和密码"; return; }
  if (p !== p2) { errEl.textContent = "两次输入的密码不一致"; return; }
  if (p.length < 6) { errEl.textContent = "密码至少需要6位"; return; }
  try {
    const res = await fetch(API + "/register", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { errEl.textContent = j.error || "注册失败"; return; }
    document.getElementById("registerCard").innerHTML = `
      <p class="login-title">注册成功</p>
      <p class="login-sub" style="line-height:1.7;margin-top:10px;">${escapeHTML(j.message || "请联系管理员分配权限后再登录")}</p>
      <button class="btn btn-primary" style="margin-top:16px;" onclick="location.reload()">返回登录</button>
    `;
  } catch (e) {
    errEl.textContent = "网络错误,请检查服务是否可访问";
  }
}

/* ---------------- 侧边导航 / 移动端菜单 ---------------- */
const NAV_LABELS = {
  quantity: "工程量对比", devices: "设备台账", vault: "核心密码本",
  network: "网络与交换机", audit: "修改日志", projects: "项目管理",
  users: "用户管理", backup: "数据备份",
};

document.querySelectorAll(".sidenav .nav-item").forEach((el) => {
  el.addEventListener("click", () => {
    switchView(el.dataset.view);
    closeMobileNav();
  });
});
document.getElementById("hamburgerBtn").addEventListener("click", () => {
  document.getElementById("sideNav").classList.toggle("open");
  document.getElementById("navBackdrop").style.display =
    document.getElementById("sideNav").classList.contains("open") ? "block" : "none";
});
document.getElementById("navBackdrop").addEventListener("click", closeMobileNav);
function closeMobileNav() {
  document.getElementById("sideNav").classList.remove("open");
  document.getElementById("navBackdrop").style.display = "none";
}

function switchView(name) {
  if (PERMISSION_GATED_VIEWS.includes(name) && !hasPerm(name)) {
    toast("没有该模块的使用权限,请联系管理员分配", "err");
    name = "dashboard";
  }
  CUR_VIEW = name;
  document.querySelectorAll(".sidenav .nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === name);
  });
  const renderers = {
    dashboard: renderDashboardView,
    quantity: renderQuantityView,
    install: renderInstallView,
    devices: renderDevicesView,
    categories: renderCategoriesView,
    vault: renderVaultView,
    network: renderNetworkView,
    toolbox: renderToolboxView,
    audit: renderAuditView,
    projects: renderProjectsView,
    users: renderUsersView,
    backup: renderBackupView,
  };
  (renderers[name] || renderDashboardView)();
}

/* ---------------- 项目下拉框(全局筛选) ---------------- */
async function loadProjects() {
  PROJECTS = await api("/projects");
  if (CUR_PROJECT && !PROJECTS.find((p) => p.id === CUR_PROJECT)) CUR_PROJECT = 0;
  if (!CUR_PROJECT && PROJECTS.length) CUR_PROJECT = PROJECTS[0].id;
  localStorage.setItem("wdmp_project", CUR_PROJECT || "");
}
function projectSelectHTML(id) {
  let opts = PROJECTS.map(
    (p) => `<option value="${p.id}" ${p.id === CUR_PROJECT ? "selected" : ""}>${escapeHTML(p.name)}${p.area ? " / " + escapeHTML(p.area) : ""}</option>`
  ).join("");
  if (!PROJECTS.length) opts = `<option value="">暂无项目,请先在"项目管理"中创建</option>`;
  return `<select id="${id}">${opts}</select>`;
}
function bindProjectSelect(id, onChange) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", () => {
    CUR_PROJECT = parseInt(el.value) || 0;
    localStorage.setItem("wdmp_project", CUR_PROJECT || "");
    onChange();
  });
}

/* ---------------- 通用分页组件 ----------------
   用法(以某模块为例):
     1. 模块顶部维护两个状态变量,如 let QTY_PAGE = 1, QTY_PAGE_SIZE = 20;
     2. 每次筛选条件变化时把 QTY_PAGE 重置为 1;
     3. 渲染时:
          const totalPages = clampPageState(rows.length, QTY_PAGE_SIZE);
          // ↑ 见下方说明,用于把 QTY_PAGE 钳制在合法范围内
          const pageRows = paginate(rows, QTY_PAGE, QTY_PAGE_SIZE);
          tbody 用 pageRows 渲染,同时在表格下方插入一个 <div id="xxxPager"></div>
          renderPager("xxxPager", rows.length, QTY_PAGE, QTY_PAGE_SIZE, (p) => { QTY_PAGE = p; paint(); }, (sz) => { QTY_PAGE_SIZE = sz; QTY_PAGE = 1; paint(); });
*/
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

// 把 page 钳制在 [1, 总页数] 范围内,返回钳制后的合法页码(调用方通常直接把返回值写回自己的 PAGE 变量)
function clampPage(page, total, pageSize) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return Math.min(Math.max(1, page || 1), totalPages);
}

// 从完整列表里切出当前页要显示的部分
function paginate(list, page, pageSize) {
  const start = (page - 1) * pageSize;
  return list.slice(start, start + pageSize);
}

// 把分页条渲染进指定 id 的容器里;total 为 0 时不显示分页条(整段留空)
function renderPager(containerId, total, page, pageSize, onPage, onPageSize) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!total) { el.innerHTML = ""; return; }
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  page = Math.min(Math.max(1, page), totalPages);

  // 页码按钮:首页、末页、当前页前后各1页,其余用省略号折叠
  const shown = new Set([1, totalPages]);
  for (let p = page - 1; p <= page + 1; p++) if (p >= 1 && p <= totalPages) shown.add(p);
  const sorted = Array.from(shown).sort((a, b) => a - b);
  let pageBtns = "";
  let prev = 0;
  sorted.forEach((p) => {
    if (prev && p - prev > 1) pageBtns += `<span class="pg-ellipsis">…</span>`;
    pageBtns += `<button class="pg-btn${p === page ? " active" : ""}" data-page="${p}">${p}</button>`;
    prev = p;
  });

  el.innerHTML = `
    <div class="pagination">
      <div class="pg-info">共 ${total} 条 · 第 ${page}/${totalPages} 页</div>
      <div class="pg-btns">
        <button class="pg-btn" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button>
        ${pageBtns}
        <button class="pg-btn" data-page="${page + 1}" ${page >= totalPages ? "disabled" : ""}>下一页</button>
      </div>
      <div class="pg-size">
        每页
        <select class="pg-size-select">
          ${PAGE_SIZE_OPTIONS.map((n) => `<option value="${n}" ${n === pageSize ? "selected" : ""}>${n}</option>`).join("")}
        </select>
        条
      </div>
    </div>`;
  el.querySelectorAll(".pg-btn[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      onPage(parseInt(btn.dataset.page));
    });
  });
  el.querySelector(".pg-size-select").addEventListener("change", (e) => onPageSize(parseInt(e.target.value)));
}

/* ---------------- 工具函数 ---------------- */
function escapeHTML(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtNum(n) {
  if (n === null || n === undefined) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}
function statusTag(status) {
  const map = { "未安装": "tag-idle", "已安装": "tag-warn", "已调试": "tag-ok", "施工异常": "tag-bad" };
  return `<span class="tag ${map[status] || "tag-idle"}">${escapeHTML(status)}</span>`;
}
function diffTag(v, posLabel = "多装", negLabel = "漏装") {
  if (v > 0) return `<span class="diff-pos">+${fmtNum(v)}(${posLabel})</span>`;
  if (v < 0) return `<span class="diff-neg">${fmtNum(v)}(${negLabel})</span>`;
  return `<span class="diff-zero">0(一致)</span>`;
}

/* ---------------- 通用 Modal ---------------- */
function openModal(html) {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `<div class="modal-mask" id="modalMask"><div class="modal">
    <button class="close-x" id="modalClose">&times;</button>${html}</div></div>`;
  document.getElementById("modalMask").addEventListener("click", (e) => {
    if (e.target.id === "modalMask") closeModal();
  });
  document.getElementById("modalClose").addEventListener("click", closeModal);
  // 弹窗里的数字框:聚焦时自动全选(已有内容也不用手动删),
  // 单行输入框按回车相当于点主按钮(保存/确认),不用再伸手去点
  const modal = root.querySelector(".modal");
  modal.addEventListener("focusin", (e) => {
    const t = e.target;
    if (t.tagName === "INPUT" && t.type === "number") setTimeout(() => { try { t.select(); } catch (_) {} }, 0);
  });
  modal.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing || e.target.tagName !== "INPUT") return;
    const t = e.target.type;
    if (t !== "text" && t !== "number" && t !== "password") return;
    const primary = modal.querySelector(".modal-actions .btn-primary");
    if (primary && !primary.disabled) { e.preventDefault(); primary.click(); }
  });
}
function closeModal() {
  document.getElementById("modalRoot").innerHTML = "";
}

// chooseImportMode 弹出"追加导入 / 覆盖导入 / 取消"三选一,返回 Promise<'append'|'overwrite'|null>
function chooseImportMode(moduleLabel) {
  return new Promise((resolve) => {
    openModal(`
      <h2>导入方式</h2>
      <p style="color:var(--text-dim);font-size:13.5px;line-height:1.7;">
        即将导入「${escapeHTML(moduleLabel)}」,请选择导入方式:
      </p>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:6px;">
        <button class="btn btn-cyan" id="modeAppendBtn" style="justify-content:flex-start;padding:12px 14px;">
          <div style="text-align:left;">
            <div style="font-size:14.5px;">追加导入</div>
            <div style="font-size:12px;font-weight:400;opacity:.85;margin-top:2px;">保留现有数据,新数据追加进去</div>
          </div>
        </button>
        <button class="btn btn-danger" id="modeOverwriteBtn" style="justify-content:flex-start;padding:12px 14px;">
          <div style="text-align:left;">
            <div style="font-size:14.5px;">覆盖导入</div>
            <div style="font-size:12px;font-weight:400;opacity:.85;margin-top:2px;">先清空该项目下现有数据,再导入(不可恢复)</div>
          </div>
        </button>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="modeCancelBtn">取消</button>
      </div>
    `);
    let decided = false;
    const finish = (mode) => {
      if (decided) return;
      decided = true;
      closeModal();
      resolve(mode);
    };
    document.getElementById("modeAppendBtn").addEventListener("click", () => finish("append"));
    bindSubmitOnce(document.getElementById("modeOverwriteBtn"), async () => {
      const ok = confirm(`确认要覆盖导入吗?这会先永久删除该项目下「${moduleLabel}」的现有数据,此操作不可恢复。`);
      if (ok) finish("overwrite");
    });
    document.getElementById("modeCancelBtn").addEventListener("click", () => finish(null));
    document.getElementById("modalClose").addEventListener("click", () => finish(null));
    document.getElementById("modalMask").addEventListener("click", (e) => {
      if (e.target.id === "modalMask") finish(null);
    });
  });
}

/* ---------------- 全局快捷搜索 ---------------- */
let searchTimer = null;
document.getElementById("globalSearch").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const box = document.getElementById("searchResults");
  if (!q) { box.style.display = "none"; return; }
  searchTimer = setTimeout(async () => {
    const list = await api("/search?q=" + encodeURIComponent(q));
    if (!list.length) {
      box.innerHTML = `<div class="sr-item">未找到相关结果</div>`;
    } else {
      box.innerHTML = list
        .map((r) => `<div class="sr-item"><div class="sr-mod">${escapeHTML(r.module)}</div><b>${escapeHTML(r.title)}</b><div>${escapeHTML(r.detail)}</div></div>`)
        .join("");
    }
    box.style.display = "block";
  }, 250);
});
/* ---------------- 分类(总分类/子分类)缓存与选择器 ---------------- */
let CATEGORIES = [];
async function loadCategories() {
  CATEGORIES = await api("/categories");
}
function mainCategories() {
  return CATEGORIES.filter((c) => c.parent_id === 0);
}
function subCategories(mainId) {
  return CATEGORIES.filter((c) => c.parent_id === parseInt(mainId));
}
function categoryName(id) {
  const c = CATEGORIES.find((x) => x.id === id);
  return c ? c.name : "";
}
// 生成"总分类"下拉框 HTML
function mainCategorySelectHTML(id, selectedId) {
  const opts = mainCategories()
    .map((c) => `<option value="${c.id}" ${c.id === selectedId ? "selected" : ""}>${escapeHTML(c.name)}</option>`)
    .join("");
  return `<select id="${id}"><option value="">请选择总分类</option>${opts}</select>`;
}
// 生成"子分类"下拉框 HTML(依赖已选的总分类)
function subCategorySelectHTML(id, mainId, selectedId) {
  const opts = subCategories(mainId)
    .map((c) => `<option value="${c.id}" ${c.id === selectedId ? "selected" : ""}>${escapeHTML(c.name)}</option>`)
    .join("");
  return `<select id="${id}"><option value="">(无/不选)</option>${opts}</select>`;
}
// 绑定"总分类"改变时联动刷新"子分类"选项。
// autoPickSingleSub: 传 true 时,如果切换出来的子分类只有唯一一个选项,自动帮用户选中它,
// 不用再多点一次——仅用于"新增/编辑表单"场景,筛选器场景不传这个参数,保持"不选=看全部"的语义不变。
function bindCategoryCascade(mainSelectId, subSelectId, keepSelectedSubId, autoPickSingleSub) {
  const mainSel = document.getElementById(mainSelectId);
  if (!mainSel || !document.getElementById(subSelectId)) return;
  mainSel.addEventListener("change", () => {
    // 每次都重新按 id 查找当前真正挂在 DOM 里的子分类元素,而不是复用绑定时捕获的旧引用——
    // 旧引用在第一次 outerHTML 替换后就已经从文档里摘除了,再对它赋值 outerHTML 不会反映到页面上,
    // 导致连续切换两次总分类时,子分类下拉框从第二次开始就不会再刷新。
    const curSubSel = document.getElementById(subSelectId);
    if (!curSubSel) return;
    curSubSel.outerHTML = subCategorySelectHTML(subSelectId, mainSel.value, null);
    if (autoPickSingleSub) {
      const subs = subCategories(parseInt(mainSel.value) || 0);
      if (subs.length === 1) {
        const newSubSel = document.getElementById(subSelectId);
        if (newSubSel) newSubSel.value = subs[0].id;
      }
    }
  });
  if (keepSelectedSubId) {
    // 初次渲染已经在 subCategorySelectHTML 里带上了 selected,这里无需处理
  }
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".searchbox")) {
    document.getElementById("searchResults").style.display = "none";
  }
});
