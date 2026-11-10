/* ============================================================
   模块:总览看板(按分类的安装进度 + 设备状态分布 + 关键提醒)
   ============================================================ */
async function renderDashboardView() {
  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="page-head">
      <h1>总览看板</h1>
      <span class="sub">按分类查看安装进度,一眼看出整体情况</span>
    </div>
    <div class="toolbar">
      ${projectSelectHTML("dashProjectSel")}
    </div>
    <div id="dashBody"></div>
  `;
  bindProjectSelect("dashProjectSel", loadDashboard);
  await loadDashboard();
}

function progressBar(pct, color) {
  const clamped = Math.max(0, Math.min(100, pct));
  return `
    <div style="background:var(--paper);border:1px solid var(--line);border-radius:20px;height:10px;overflow:hidden;">
      <div style="width:${clamped}%;height:100%;background:${color};transition:width .3s;"></div>
    </div>
  `;
}

async function loadDashboard() {
  const body = document.getElementById("dashBody");
  if (!CUR_PROJECT) {
    body.innerHTML = `<div class="empty-state"><div class="big">&#128202;</div>请先选择或新建一个项目</div>`;
    return;
  }
  body.innerHTML = `<div style="padding:30px;color:var(--text-dim);">加载中...</div>`;

  const [qtyList, devList] = await Promise.all([
    api("/quantity?project_id=" + CUR_PROJECT),
    api("/devices?project_id=" + CUR_PROJECT),
  ]);

  if (!qtyList.length && !devList.length) {
    body.innerHTML = `<div class="empty-state"><div class="big">&#128202;</div>该项目暂无数据,先去"工程量对比"或"设备台账"录入一些内容吧</div>`;
    return;
  }

  // ---- 总体统计 ----
  const totalList = qtyList.reduce((s, r) => s + r.list_qty, 0);
  const totalArrival = qtyList.reduce((s, r) => s + r.arrival_qty, 0);
  const totalActual = qtyList.reduce((s, r) => s + r.actual_qty, 0);
  const overallPct = totalList > 0 ? (totalActual / totalList) * 100 : (totalActual > 0 ? 100 : 0);
  const underCount = qtyList.filter((r) => r.diff_list < 0).length;
  const overCount = qtyList.filter((r) => r.diff_list > 0).length;
  const notArrivedCount = qtyList.filter((r) => r.diff_arrival < 0).length;
  const anomalyCount = qtyList.filter((r) => r.diff_installed > 0).length;

  // ---- 按总分类聚合安装进度 ----
  const byCat = {};
  qtyList.forEach((r) => {
    const key = r.category_id || 0;
    if (!byCat[key]) byCat[key] = { name: categoryName(key) || r.category || "未分类", list: 0, actual: 0, arrival: 0 };
    byCat[key].list += r.list_qty;
    byCat[key].actual += r.actual_qty;
    byCat[key].arrival += r.arrival_qty;
  });
  const catRows = Object.values(byCat).sort((a, b) => b.list - a.list);

  // ---- 设备状态分布 ----
  const statusCount = { "未安装": 0, "已安装": 0, "已调试": 0, "施工异常": 0 };
  devList.forEach((d) => { if (statusCount[d.status] !== undefined) statusCount[d.status]++; });
  const statusColors = { "未安装": "var(--text-dim)", "已安装": "var(--amber)", "已调试": "var(--green)", "施工异常": "var(--red)" };

  body.innerHTML = `
    <div class="stat-row">
      <div class="stat-box"><div class="v">${fmtNum(totalList)}</div><div class="l">清单合计</div></div>
      <div class="stat-box"><div class="v">${fmtNum(totalArrival)}</div><div class="l">到货合计</div></div>
      <div class="stat-box"><div class="v">${fmtNum(totalActual)}</div><div class="l">实际安装合计</div></div>
      <div class="stat-box"><div class="v" style="color:var(--cyan)">${overallPct.toFixed(0)}%</div><div class="l">总体安装进度</div></div>
      <div class="stat-box"><div class="v" style="color:var(--red)">${underCount}</div><div class="l">漏装条目</div></div>
      <div class="stat-box"><div class="v" style="color:var(--amber)">${overCount}</div><div class="l">多装条目</div></div>
      <div class="stat-box"><div class="v" style="color:var(--red)">${notArrivedCount}</div><div class="l">到货不齐条目</div></div>
      <div class="stat-box"><div class="v" style="color:var(--red)">${anomalyCount}</div><div class="l">装的比到的多(异常)</div></div>
    </div>

    <div class="card panel">
      <h3 style="margin:0 0 14px;font-size:15px;color:var(--ink);">按总分类的安装进度</h3>
      ${catRows.length ? catRows.map((c) => {
        const pct = c.list > 0 ? (c.actual / c.list) * 100 : (c.actual > 0 ? 100 : 0);
        const color = pct >= 100 ? "var(--green)" : pct >= 60 ? "var(--cyan)" : pct > 0 ? "var(--amber)" : "var(--text-dim)";
        return `
          <div style="margin-bottom:14px;">
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px;">
              <span><b>${escapeHTML(c.name)}</b></span>
              <span class="mono" style="color:var(--text-dim);">${fmtNum(c.actual)} / ${fmtNum(c.list)}(${pct.toFixed(0)}%)</span>
            </div>
            ${progressBar(pct, color)}
          </div>
        `;
      }).join("") : `<div style="color:var(--text-dim);font-size:13px;">暂无工程量数据</div>`}
    </div>

    <div class="card panel">
      <h3 style="margin:0 0 14px;font-size:15px;color:var(--ink);">设备台账状态分布(共 ${devList.length} 台)</h3>
      ${devList.length ? Object.entries(statusCount).map(([status, count]) => {
        const pct = devList.length > 0 ? (count / devList.length) * 100 : 0;
        return `
          <div style="margin-bottom:14px;">
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px;">
              <span>${statusTag(status)}</span>
              <span class="mono" style="color:var(--text-dim);">${count} 台(${pct.toFixed(0)}%)</span>
            </div>
            ${progressBar(pct, statusColors[status])}
          </div>
        `;
      }).join("") : `<div style="color:var(--text-dim);font-size:13px;">暂无设备台账数据</div>`}
    </div>
  `;
}
