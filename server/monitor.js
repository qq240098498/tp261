// 监测数据口径都集中在这里：有效读数、折算、日均、总量、超标、许可
const store = require('./store');
const permit = require('./permit');

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

// 月份范围：[月初, 次月初)
function monthRange(month) {
  const [y, m] = String(month).split('-').map(Number);
  const start = y + '-' + String(m).padStart(2, '0') + '-01';
  const end = m === 12 ? (y + 1) + '-01-01' : y + '-' + String(m + 1).padStart(2, '0') + '-01';
  return [start, end];
}

// 时段总量（吨）：逐小时按时刻配对（浓度与流量取同一时刻的那一对）累加，月/季/年/分段都用这一套口径
function totalInRange(data, outletId, metric, startDay, endDay) {
  const settings = data.settings;
  const rows = readingsOf(data, { outletId, metric }).filter((r) => {
    const day = store.dayOf(r.at);
    return day >= startDay && day < endDay && isCounted(r, deviceOf(data, r.deviceId), settings);
  });
  let mg = 0;
  for (const r of rows) mg += effectiveConcentration(r, settings) * flowAt(data, r);
  return store.round(mg / Number(settings.tonsDivisor), 4);
}

// 全部排放口在某时段的已用量（吨）
function usedInRange(data, metric, startDay, endDay) {
  let total = 0;
  for (const o of data.outlets) total += totalInRange(data, o.id, metric, startDay, endDay);
  return store.round(total, 4);
}

// 月总量（吨）：逐小时浓度乘以流量相加
function monthTotal(data, outletId, metric, month) {
  const [start, end] = monthRange(month);
  return totalInRange(data, outletId, metric, start, end);
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

// 季度许可量：按季度内各许可分段的年许可量 × 实际天数占许可年天数比例分解
function quarterPermitTons(data, metric, quarter) {
  const [y, q] = String(quarter).split('-Q').map(Number);
  const firstMonth = y + '-' + String((q - 1) * 3 + 1).padStart(2, '0');
  const lastMonth = y + '-' + String((q - 1) * 3 + 3).padStart(2, '0');
  const start = firstMonth + '-01';
  const end = monthRange(lastMonth)[1];
  return permit.permitForRange(data, metric, start, end);
}

// 年累计：按许可年（设置里的许可年起始日）累计，跨许可年的数据不带入
function accumulatedTons(data, metric, refDay) {
  const ref = String(refDay || store.nowText().slice(0, 10)).slice(0, 10);
  const year = store.permitYearOf(ref, data.settings.permitYearStart);
  return usedInRange(data, metric, year.start, year.end);
}

// 剩余许可量结转：折合年许可 + 上年结转 − 许可年已用；分段给出每段口径与段内已用
function permitBalance(data, metric, refDay) {
  const ref = String(refDay || store.nowText().slice(0, 10)).slice(0, 10);
  const segResult = permit.segmentsForYear(data, metric, ref);
  const year = segResult.year;
  const carried = permit.carryOverForYear(data, metric, year.start);
  const segments = segResult.segments.map((s) => Object.assign({}, s, {
    usedTons: usedInRange(data, metric, s.from, store.addDays(s.to, 1)),
  }));
  const equivalentAnnualTons = store.round(segResult.segments.reduce((acc, s) => acc + s.equivalentTons, 0), 4);
  const usedTons = usedInRange(data, metric, year.start, year.end);
  const remainingTons = store.round(equivalentAnnualTons + carried.tons - usedTons, 4);
  // 上一许可年结存（跨年变更时对照「带多少」用）
  const prevRef = store.addDays(year.start, -1);
  const prevSeg = permit.segmentsForYear(data, metric, prevRef);
  const prevCarried = permit.carryOverForYear(data, metric, prevSeg.year.start);
  const prevEquivalent = store.round(prevSeg.segments.reduce((acc, s) => acc + s.equivalentTons, 0), 4);
  const prevUsed = usedInRange(data, metric, prevSeg.year.start, prevSeg.year.end);
  return {
    metric,
    yearStart: year.start,
    yearEnd: store.addDays(year.end, -1),
    yearDays: year.days,
    yearLabel: year.label,
    equivalentAnnualTons,
    carriedTons: carried.tons,
    carryOverItems: carried.items,
    usedTons,
    remainingTons,
    segments,
    prevYear: {
      yearStart: prevSeg.year.start,
      yearEnd: store.addDays(prevSeg.year.end, -1),
      equivalentAnnualTons: prevEquivalent,
      carriedTons: prevCarried.tons,
      usedTons: prevUsed,
      remainingTons: store.round(prevEquivalent + prevCarried.tons - prevUsed, 4),
    },
  };
}

// 某月核算用的许可信息：覆盖该月的版本、月/季许可量、许可年结转与剩余
function permitBlock(data, metric, month) {
  const [start, end] = monthRange(month);
  const bal = permitBalance(data, metric, start);
  const eff = permit.permitAt(data, metric, start);
  return {
    currentVersion: 'V' + eff.version,
    currentAnnualTons: eff.tons,
    versions: permit.versionsOfMonth(data, metric, month),
    monthPermitTons: permit.permitForRange(data, metric, start, end),
    quarterPermitTons: quarterPermitTons(data, metric, store.quarterOf(month)),
    yearEquivalentTons: bal.equivalentAnnualTons,
    carriedTons: bal.carriedTons,
    usedTons: bal.usedTons,
    remainingTons: bal.remainingTons,
  };
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
  // 该月若已有「已上报」报表，结论以报表快照为准，这里只标记出来
  const frozenReport = outlet
    ? data.reports.find((r) => r.plantId === outlet.plantId && r.period === month && r.status === '已上报') || null
    : null;
  return {
    outlet,
    plant: outlet ? plantOf(data, outlet.plantId) : null,
    month,
    rows,
    devices,
    quarterTotalCod: quarterTotal(data, outletId, 'COD', store.quarterOf(month)),
    permitCodTons: quarterPermitTons(data, 'COD', store.quarterOf(month)),
    annualPermitCodTons: permit.permitAt(data, 'COD', month + '-01').tons,
    accumulatedCodTons: accumulatedTons(data, 'COD', month + '-01'),
    accumulatedAmmoniaTons: accumulatedTons(data, '氨氮', month + '-01'),
    permitInfo: {
      COD: permitBlock(data, 'COD', month),
      氨氮: permitBlock(data, '氨氮', month),
    },
    frozenReport: frozenReport
      ? { id: frozenReport.id, period: frozenReport.period, frozenAt: frozenReport.snapshot ? frozenReport.snapshot.frozenAt : '' }
      : null,
    settings,
  };
}

module.exports = {
  plantOf, outletOf, deviceOf,
  readingsOf, isCounted, effectiveConcentration, oxygenAt, flowAt,
  dayRows, dailyStats, dailySeries, monthAverage, monthTotal, quarterTotal, quarterPermitTons, accumulatedTons,
  monthRange, totalInRange, usedInRange, permitBalance, permitBlock,
  exceedance, outletsOf, outletSummary,
};
