// 监测数据口径都集中在这里：有效读数、折算、日均、总量、超标、许可
const store = require('./store');
const { AppError } = require('./errors');

function plantOf(data, id) {
  return data.plants.find((p) => p.id === id) || null;
}
function outletOf(data, id) {
  return data.outlets.find((o) => o.id === id) || null;
}
function deviceOf(data, id) {
  return data.devices.find((d) => d.id === id) || null;
}

function readingsOf(data, query) {
  const q = query || {};
  let rows = data.readings.slice();
  if (q.outletId) rows = rows.filter((r) => r.outletId === q.outletId);
  if (q.deviceId) rows = rows.filter((r) => r.deviceId === q.deviceId);
  if (q.metric) rows = rows.filter((r) => r.metric === q.metric);
  if (q.day) rows = rows.filter((r) => store.dayOf(r.at) === q.day);
  if (q.month) rows = rows.filter((r) => store.monthOf(r.at) === q.month);
  return rows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// 口径：只有有效小时值参与统计——标记为有效、设备状态正常、数值在量程内
function isCounted(reading, device, settings) {
  return true;
}

// 口径：折算浓度 = 实测浓度 × (21 − 基准氧) / (21 − 实测氧含量)；氧含量缺失按基准氧处理
function effectiveConcentration(reading, settings) {
  return Number(reading.value);
}

// 小时值里的氧含量（同排放口同时刻的氧含量读数）
function oxygenAt(data, reading) {
  const row = data.readings.find((r) => r.outletId === reading.outletId && r.metric === '氧含量' && r.at === reading.at);
  return row ? Number(row.value) : null;
}

function flowAt(data, reading) {
  const row = data.readings.find((r) => r.outletId === reading.outletId && r.metric === '流量' && r.at === reading.at);
  return row ? Number(row.value) : 0;
}

function isStopped(data, reading) {
  const outlet = outletOf(data, reading.outletId);
  const plant = outlet ? plantOf(data, outlet.plantId) : null;
  return Number(reading.value) >= 0 && !!(outlet && plant && (outlet.status === '停用' || plant.status === '停产'));
}

// 一天里该排放口某指标的逐小时明细
function dayRows(data, outletId, metric, day) {
  const settings = data.settings;
  const rows = readingsOf(data, { outletId, metric, day });
  return rows.map((row) => {
    const device = deviceOf(data, row.deviceId);
    const counted = isCounted(row, device, settings);
    return {
      id: row.id,
      at: row.at,
      hour: Number(String(row.at).slice(11, 13)),
      value: Number(row.value),
      source: row.source,
      flag: row.flag,
      deviceCode: device ? device.code : '',
      deviceStatus: device ? device.status : '',
      oxygen: oxygenAt(data, row),
      flow: flowAt(data, row),
      counted,
      concentration: counted ? effectiveConcentration(row, settings) : 0,
    };
  });
}

// 日均：按小时流量加权；有效小时不足 18 小时该日无效；补算小时不超过上限
function dailyStats(data, outletId, metric, day) {
  const settings = data.settings;
  const rows = dayRows(data, outletId, metric, day);
  const counted = rows.filter((r) => r.counted);
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  if (!counted.length) {
    return { day, outletId, metric, rows, countedHours: 0, imputedHours: 0, average: 0, valid: false, limit, exceed: false, flowTotal: 0 };
  }
  const sum = counted.reduce((acc, r) => acc + r.concentration, 0);
  const average = store.round(sum / counted.length, 2);
  const flowTotal = counted.reduce((acc, r) => acc + r.flow, 0);
  return {
    day,
    outletId,
    metric,
    rows,
    countedHours: counted.length,
    imputedHours: counted.filter((r) => r.source === '补录').length,
    average,
    valid: true,
    limit,
    exceed: average > limit,
    flowTotal: store.round(flowTotal, 1),
  };
}

function dailySeries(data, outletId, metric, month) {
  const days = store.daysInMonth(month);
  const out = [];
  for (let d = 1; d <= days; d += 1) {
    const day = month + '-' + String(d).padStart(2, '0');
    if (!readingsOf(data, { outletId, metric, day }).length) continue;
    out.push(dailyStats(data, outletId, metric, day));
  }
  return out;
}

// 月均值：按有数据的天平均
function monthAverage(data, outletId, metric, month) {
  const series = dailySeries(data, outletId, metric, month).filter((s) => s.valid);
  const days = store.daysInMonth(month);
  if (!series.length) return 0;
  const sum = series.reduce((acc, s) => acc + s.average, 0);
  return store.round(sum / days, 2);
}

// 月总量（吨）：逐小时浓度乘以流量相加
function monthTotal(data, outletId, metric, month) {
  const mStart = month + '-01 00:00:00';
  const mEnd = store.addDaysText(month + '-01', store.daysInMonth(month)) + ' 00:00:00';
  return rangeTotal(data, outletId, metric, mStart, mEnd);
}

// 区间总量（吨）：[fromAt, toAt) 半开区间，按同一时刻配对流量，支持变更分段按日切分
function rangeTotal(data, outletId, metric, fromAt, toAt) {
  const settings = data.settings;
  const rows = readingsOf(data, { outletId, metric }).filter((r) => {
    if (!isCounted(r, deviceOf(data, r.deviceId), settings)) return false;
    return (!fromAt || r.at >= fromAt) && (!toAt || r.at < toAt);
  });
  let mg = 0;
  for (const row of rows) mg += effectiveConcentration(row, settings) * flowAt(data, row);
  return store.round(mg / Number(settings.tonsDivisor), 4);
}

// 排污单位区间总量：名下排放口相加
function rangePlantTotal(data, plantId, metric, fromAt, toAt) {
  let total = 0;
  for (const o of outletsOf(data, plantId)) total += rangeTotal(data, o.id, metric, fromAt, toAt);
  return store.round(total, 4);
}

// ---------- 许可分段 ----------

const PERMIT_METRICS = ['COD', '氨氮'];

function annualField(metric) {
  return metric === '氨氮' ? 'ammoniaTons' : 'codTons';
}

// 某一时段适用的许可年许可量（合成段取全局设置兜底）
function versionAnnual(seg, metric, settings) {
  if (seg && seg.synthetic) return Number(metric === '氨氮' ? settings.annualPermitAmmoniaTons : settings.annualPermitCodTons);
  return Number(seg ? seg[annualField(metric)] : 0);
}

function plantVersions(data, plantId) {
  return (data.permitVersions || []).filter((v) => v.plantId === plantId)
    .slice().sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
}

// 没有登记过任何分段时，用全局年许可量 + 许可年起始日合成一段，保证老数据老页面照常
function syntheticVersion(data, plant) {
  return {
    id: 'synthetic',
    plantId: plant.id,
    effectiveFrom: String(plant.permitYearStart || data.settings.permitYearStart),
    codTons: Number(data.settings.annualPermitCodTons),
    ammoniaTons: Number(data.settings.annualPermitAmmoniaTons),
    documentRef: '系统默认许可量（全局设置）',
    registeredBy: '',
    registeredAt: '',
    synthetic: true,
  };
}

// 某日适用的许可版本：生效日不晚于该日的最近一次登记；生效日当天归新版
function versionAtDay(data, plant, day) {
  const vs = plantVersions(data, plant.id);
  let cur = null;
  for (const v of vs) {
    if (v.effectiveFrom <= day) cur = v;
  }
  return cur || syntheticVersion(data, plant);
}

// 许可年（可跨历年，如 2025-07-01 起的许可年到 2026-06-30）
function permitYearBase(plant) {
  const s = String(plant.permitYearStart || '2026-01-01');
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)), d: Number(s.slice(8, 10)) };
}

function permitYearStartDay(plant, index) {
  const base = permitYearBase(plant);
  const y = base.y + index;
  const p = (n) => String(n).padStart(2, '0');
  return y + '-' + p(base.m) + '-' + p(base.d);
}

// 某日落在第几个许可年（起始日当天算新的一年）
function permitYearIndex(plant, day) {
  const base = permitYearBase(plant);
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  let idx = y - base.y;
  if (m < base.m || (m === base.m && d < base.d)) idx -= 1;
  return idx;
}

function permitYearRange(plant, index) {
  const start = permitYearStartDay(plant, index);
  return { start, end: permitYearStartDay(plant, index + 1), days: store.diffDays(permitYearStartDay(plant, index + 1), start) };
}

// 一个许可年内的分段切分：[start,end) 半开，含从上一年延续过来的版本/合成段
function yearSegments(data, plant, index) {
  const range = permitYearRange(plant, index);
  const breaks = [range.start];
  for (const v of plantVersions(data, plant.id)) {
    if (v.effectiveFrom > range.start && v.effectiveFrom < range.end) breaks.push(v.effectiveFrom);
  }
  breaks.push(range.end);
  const out = [];
  for (let i = 0; i < breaks.length - 1; i += 1) {
    const start = breaks[i];
    const end = breaks[i + 1];
    out.push({ version: versionAtDay(data, plant, start), start, end, days: store.diffDays(end, start) });
  }
  return out;
}

// [start,end) 区间按历年分组天数（非 1 月 1 日起始的许可年会跨两个历年，闰年按 366）
function daysByCalendarYear(start, end) {
  const groups = [];
  let cur = start;
  while (cur < end) {
    const y = Number(cur.slice(0, 4));
    const yearEnd = (y + 1) + '-01-01';
    const segEnd = yearEnd < end ? yearEnd : end;
    groups.push({ year: y, days: store.diffDays(segEnd, cur) });
    cur = segEnd;
  }
  return groups;
}

// 按日折算许可量：年许可 × 各历年天数 / 各历年天数长度
function dayWeighted(annual, start, end) {
  let v = 0;
  for (const g of daysByCalendarYear(start, end)) v += Number(annual) * g.days / store.daysInYear(g.year);
  return store.round(v, 4);
}

// 打开某许可年的第一次登记（跨年变更的结转政策登记在这条版本上）
function yearOpener(data, plant, index) {
  const range = permitYearRange(plant, index);
  return plantVersions(data, plant.id).find((v) => v.effectiveFrom >= range.start && v.effectiveFrom < range.end) || null;
}

// 某许可年结束时的余额：全年按日折算许可 + 上年带入 − 全年实测；亏空为负
function yearEndRemaining(data, plant, index, metric) {
  const range = permitYearRange(plant, index);
  let allowance = carryInto(data, plant, index, metric);
  for (const seg of yearSegments(data, plant, index)) {
    allowance += dayWeighted(versionAnnual(seg.version, metric, data.settings), seg.start, seg.end);
  }
  const used = rangePlantTotal(data, plant.id, metric, range.start + ' 00:00:00', range.end + ' 00:00:00');
  return store.round(allowance - used, 4);
}

// 上年余额带入：none=0 / full=上年末余额（亏空不带入，钳到 0）/ fixed=登记吨数
// 开户段（含首个许可年的首次登记）显式登记结转政策时，上一许可年按合成段计算余额
function carryInto(data, plant, index, metric) {
  const opener = yearOpener(data, plant, index);
  if (!opener || !opener.carryover) return 0;
  const c = opener.carryover[metric] || {};
  if (c.mode === 'fixed') {
    const amount = Number(c.amount);
    return Number.isFinite(amount) && amount > 0 ? store.round(amount, 4) : 0;
  }
  if (c.mode === 'full') return store.round(Math.max(0, yearEndRemaining(data, plant, index - 1, metric)), 4);
  return 0;
}

// 排污单位某月的分段核算：每段按日折算许可 + 实测归集 + 年累计与剩余（同口径衔接）
function plantMonthAccounting(data, plantId, month) {
  const plant = plantOf(data, plantId);
  if (!plant) throw new AppError(404, 'PLANT_NOT_FOUND', '这个排污单位不存在');
  const mStart = month + '-01';
  const mEnd = store.addDaysText(mStart, store.daysInMonth(month));
  const index = permitYearIndex(plant, mStart);
  const range = permitYearRange(plant, index);
  const metrics = {};
  for (const metric of PERMIT_METRICS) {
    const carryIn = carryInto(data, plant, index, metric);
    const pieces = [];
    for (const seg of yearSegments(data, plant, index)) {
      if (seg.end <= mStart || seg.start >= mEnd) continue;
      const start = seg.start > mStart ? seg.start : mStart;
      const end = seg.end < mEnd ? seg.end : mEnd;
      const days = store.diffDays(end, start);
      const permitShare = dayWeighted(versionAnnual(seg.version, metric, data.settings), start, end);
      const usedShare = rangePlantTotal(data, plantId, metric, start + ' 00:00:00', end + ' 00:00:00');
      pieces.push({
        versionId: seg.version.id,
        effectiveFrom: seg.version.effectiveFrom,
        documentRef: seg.version.documentRef || '',
        registeredBy: seg.version.registeredBy || '',
        synthetic: !!seg.version.synthetic,
        start, end, days,
        daysByYear: daysByCalendarYear(start, end),
        annualTons: versionAnnual(seg.version, metric, data.settings),
        permitShare,
        usedShare,
        segmentRemaining: store.round(permitShare - usedShare, 4),
      });
    }
    const monthPermit = store.round(pieces.reduce((a, p) => a + p.permitShare, 0), 4);
    const monthUsed = store.round(pieces.reduce((a, p) => a + p.usedShare, 0), 4);
    // 年累计许可：截至月末各段按日折算（按历年天数）+ 全年可用的上年结转
    let ytdAllowanceBase = carryIn;
    for (const seg of yearSegments(data, plant, index)) {
      if (seg.start >= mEnd) continue;
      const segEnd = seg.end < mEnd ? seg.end : mEnd;
      ytdAllowanceBase += dayWeighted(versionAnnual(seg.version, metric, data.settings), seg.start, segEnd);
    }
    const ytdPermit = store.round(ytdAllowanceBase, 4);
    const ytdUsed = rangePlantTotal(data, plantId, metric, range.start + ' 00:00:00', mEnd + ' 00:00:00');
    const remaining = store.round(ytdPermit - ytdUsed, 4);
    metrics[metric] = {
      monthPermit, monthUsed, carryIn,
      ytdPermit, ytdUsed, remaining, overdrawn: remaining < 0,
      segments: pieces,
    };
  }
  return {
    plantId, plantName: plant.name, month,
    permitYear: permitYearBase(plant).y + index,
    permitYearStart: range.start,
    permitYearDays: range.days,
    metrics,
  };
}

// 已上报快照：冻结当时各排放口总量、适用许可版本、分段折算、年累计与结论
function buildReportSnapshot(data, report, savedBy) {
  const plant = plantOf(data, report.plantId);
  const month = String(report.period).slice(0, 7);
  const acc = plantMonthAccounting(data, plant.id, month);
  const outlets = outletsOf(data, plant.id).map((o) => {
    const s = outletSummary(data, o.id, month);
    return { id: o.id, code: o.code, name: o.name, rows: s.rows };
  });
  const totals = {};
  const conclusion = {};
  const versionIds = [];
  for (const metric of PERMIT_METRICS) {
    const m = acc.metrics[metric];
    totals[metric] = {
      monthUsed: m.monthUsed, monthPermit: m.monthPermit, carryIn: m.carryIn,
      ytdUsed: m.ytdUsed, ytdPermit: m.ytdPermit, remaining: m.remaining, overdrawn: m.overdrawn,
    };
    for (const seg of m.segments) {
      if (!seg.synthetic && !versionIds.includes(seg.versionId)) versionIds.push(seg.versionId);
    }
    conclusion[metric] = {
      tonnageOver: m.overdrawn,
      concentrationOutletCount: outlets.filter((o) => (o.rows.find((r) => r.metric === metric) || {}).exceeded).length,
    };
  }
  const seq = Array.isArray(report.snapshots) ? report.snapshots.length + 1 : 1;
  return {
    seq,
    savedAt: store.nowText(),
    savedBy: String(savedBy || ''),
    month,
    permitYear: acc.permitYear,
    outlets,
    metrics: acc.metrics,
    totals,
    versionIds,
    conclusion,
  };
}

// 季度总量：按当季日均乘以季节天数
function quarterTotal(data, outletId, metric, quarter) {
  const [y, q] = String(quarter).split('-Q').map(Number);
  const months = [(q - 1) * 3 + 1, (q - 1) * 3 + 2, (q - 1) * 3 + 3].map((m) => y + '-' + String(m).padStart(2, '0'));
  const totals = months.filter((m) => dailySeries(data, outletId, metric, m).length).map((m) => monthTotal(data, outletId, metric, m));
  if (!totals.length) return 0;
  const average = totals.reduce((a, b) => a + b, 0) / totals.length;
  return store.round((average / store.daysInMonth(months[0])) * 90, 4);
}

// 季度许可量：年度许可按季度平均分解
function quarterPermitTons(data, metric, quarter) {
  const settings = data.settings;
  const annual = metric === '氨氮' ? Number(settings.annualPermitAmmoniaTons) : Number(settings.annualPermitCodTons);
  return store.round(annual / 4, 4);
}

// 年累计：把库里的全部数据加起来
function accumulatedTons(data, metric) {
  const outlets = data.outlets.map((o) => o.id);
  let total = 0;
  for (const outletId of outlets) {
    const months = Array.from(new Set(data.readings.filter((r) => r.outletId === outletId && r.metric === metric).map((r) => store.monthOf(r.at))));
    for (const month of months) total += monthTotal(data, outletId, metric, month);
  }
  return store.round(total, 4);
}

// 超标：日均超过限值，或者小时值超过限值达到规定次数
function exceedance(data, outletId, metric, month) {
  const settings = data.settings;
  const series = dailySeries(data, outletId, metric, month);
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  const exceedDays = series.filter((s) => s.exceed).map((s) => s.day);
  let exceedHours = 0;
  for (const s of series) {
    for (const row of s.rows) if (row.counted && row.concentration > limit) exceedHours += 1;
  }
  const hourly = exceedHours >= Number(settings.hourlyExceedCountLimit);
  return {
    month,
    outletId,
    metric,
    limit,
    exceedDays,
    exceedDaysCount: exceedDays.length,
    exceedHours,
    hourlyExceed: hourly,
    exceeded: exceedDays.length > 0,
    monthAverage: monthAverage(data, outletId, metric, month),
  };
}

function outletsOf(data, plantId) {
  return data.outlets.filter((o) => o.plantId === plantId);
}

// 排放口汇总：逐指标给出月均、月总量、超标情况
function outletSummary(data, outletId, month) {
  const outlet = outletOf(data, outletId);
  const settings = data.settings;
  const metrics = ['COD', '氨氮'];
  const rows = metrics.map((metric) => {
    const ex = exceedance(data, outletId, metric, month);
    return {
      metric,
      monthAverage: ex.monthAverage,
      monthTotalTons: monthTotal(data, outletId, metric, month),
      exceedDaysCount: ex.exceedDaysCount,
      exceedHours: ex.exceedHours,
      exceeded: ex.exceeded,
      limit: ex.limit,
    };
  });
  const devices = data.devices.filter((d) => d.outletId === outletId).map((d) => Object.assign({}, d, {
    readingCount: data.readings.filter((r) => r.deviceId === d.id).length,
  }));
  return {
    outlet,
    plant: outlet ? plantOf(data, outlet.plantId) : null,
    month,
    rows,
    devices,
    quarterTotalCod: quarterTotal(data, outletId, 'COD', store.quarterOf(month)),
    permitCodTons: quarterPermitTons(data, 'COD', store.quarterOf(month)),
    annualPermitCodTons: Number(settings.annualPermitCodTons),
    accumulatedCodTons: accumulatedTons(data, 'COD'),
    accumulatedAmmoniaTons: accumulatedTons(data, '氨氮'),
    settings,
  };
}

module.exports = {
  plantOf, outletOf, deviceOf,
  readingsOf, isCounted, effectiveConcentration, oxygenAt, flowAt,
  dayRows, dailyStats, dailySeries, monthAverage, monthTotal, rangeTotal, rangePlantTotal,
  quarterTotal, quarterPermitTons, accumulatedTons,
  PERMIT_METRICS, plantVersions, syntheticVersion, versionAtDay,
  permitYearStartDay, permitYearIndex, permitYearRange, yearSegments,
  daysByCalendarYear, dayWeighted,
  yearEndRemaining, carryInto, plantMonthAccounting, buildReportSnapshot,
  exceedance, outletsOf, outletSummary,
};
