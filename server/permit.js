// 许可量分段核算：变更登记 → 许可年分段 → 按天折算 → 余额结转
// 口径：
//  - 初始许可（V1）取设置里的基准值，每次变更登记生成 V2、V3……，自生效日起替换年许可量
//  - 某一时段（月/季度/许可年）的许可量 = Σ 段内年许可量 × 段在该时段内的天数 / 许可年天数
//  - 年度内变更：已用量按同一口径（逐小时累加）衔接，剩余 = 折合年许可 + 结转 − 已用
//  - 跨年变更：变更登记上用 carryOverEnabled / carryOverTons 明确余额能否带入、带多少
const store = require('./store');
const { AppError } = require('./errors');

const PERMIT_METRICS = ['COD', '氨氮'];

function baselineTons(data, metric) {
  return metric === '氨氮' ? Number(data.settings.annualPermitAmmoniaTons) : Number(data.settings.annualPermitCodTons);
}

// 某指标的全部变更登记，按生效日（再按登记时刻）排序
function changesOf(data, metric) {
  return (data.permitChanges || [])
    .filter((c) => c.metric === metric)
    .slice()
    .sort((a, b) => (a.effectiveAt < b.effectiveAt ? -1 : a.effectiveAt > b.effectiveAt ? 1 : (a.registeredAt < b.registeredAt ? -1 : a.registeredAt > b.registeredAt ? 1 : 0)));
}

// 版本号：初始许可 V1，第 i 条变更（按生效排序）是 V(i+2)
// 变更前数值与跨年标记按当前变更链动态重算，补登历史变更也能自洽
function decorateChange(data, change) {
  const ordered = changesOf(data, change.metric);
  const idx = ordered.findIndex((c) => c.id === change.id);
  const before = permitAt(data, change.metric, store.addDays(change.effectiveAt, -1));
  const prev = idx > 0 ? ordered[idx - 1] : null;
  const yearOf = (day) => store.permitYearOf(day, data.settings.permitYearStart).start;
  const crossYear = !!(prev && yearOf(change.effectiveAt) > yearOf(prev.effectiveAt));
  return Object.assign({}, change, { version: 'V' + (idx + 2), beforeTons: before.tons, crossYear });
}

// 某一天生效的许可：值、来源变更、版本
function permitAt(data, metric, day) {
  const day10 = String(day).slice(0, 10);
  const effective = changesOf(data, metric).filter((c) => c.effectiveAt <= day10);
  if (!effective.length) {
    return { tons: baselineTons(data, metric), change: null, version: 1 };
  }
  const last = effective[effective.length - 1];
  return { tons: Number(last.afterTons), change: last, version: effective.length + 1 };
}

// 许可年分段：把 [yearStart, yearEnd) 按变更生效日切成段，每段用当时的年许可量
function segmentsForYear(data, metric, yearStart) {
  const year = store.permitYearOf(yearStart, data.settings.permitYearStart);
  const inside = changesOf(data, metric).filter((c) => c.effectiveAt > year.start && c.effectiveAt < year.end);
  const bounds = [year.start].concat(inside.map((c) => c.effectiveAt));
  const segments = bounds.map((from, i) => {
    const to = i + 1 < bounds.length ? bounds[i + 1] : year.end;
    const eff = permitAt(data, metric, from);
    const days = store.daysBetween(from, to);
    return {
      version: 'V' + eff.version,
      from,
      to: store.addDays(to, -1),
      days,
      annualTons: eff.tons,
      equivalentTons: store.round((eff.tons * days) / year.days, 4),
      changeId: eff.change ? eff.change.id : null,
      basisDoc: eff.change ? eff.change.basisDoc : '初始许可（设置里的基准值）',
      registeredBy: eff.change ? eff.change.registeredBy : '',
    };
  });
  return { year, segments };
}

// 跨年结转：落在该许可年内、声明了结转的变更登记，其结转量计入该许可年
function carryOverForYear(data, metric, yearStart) {
  const year = store.permitYearOf(yearStart, data.settings.permitYearStart);
  const items = changesOf(data, metric)
    .filter((c) => c.carryOverEnabled && c.effectiveAt >= year.start && c.effectiveAt < year.end)
    .map((c) => ({ changeId: c.id, tons: Number(c.carryOverTons) || 0, basisDoc: c.basisDoc, registeredBy: c.registeredBy, effectiveAt: c.effectiveAt }));
  return { tons: store.round(items.reduce((acc, it) => acc + it.tons, 0), 4), items };
}

// 任意时段 [startDay, endDay) 的许可量：跨许可年逐段按天折算
function permitForRange(data, metric, startDay, endDay) {
  let cursor = String(startDay).slice(0, 10);
  const end = String(endDay).slice(0, 10);
  let tons = 0;
  while (cursor < end) {
    const year = store.permitYearOf(cursor, data.settings.permitYearStart);
    const seg = segmentsForYear(data, metric, cursor).segments;
    for (const s of seg) {
      const segStart = s.from;
      const segEnd = store.addDays(s.to, 1);
      const from = segStart > cursor ? segStart : cursor;
      const to = segEnd < end ? segEnd : end;
      if (from < to) tons += (s.annualTons * store.daysBetween(from, to)) / year.days;
    }
    cursor = year.end;
  }
  return store.round(tons, 4);
}

// 某月覆盖到的许可版本（可能跨段）
function versionsOfMonth(data, metric, month) {
  const start = month + '-01';
  const end = store.formatDay(store.parseDay(start) + store.daysInMonth(month) * 86400000);
  const year = store.permitYearOf(start, data.settings.permitYearStart);
  const years = new Set([year.start, store.permitYearOf(store.addDays(end, -1), data.settings.permitYearStart).start]);
  const out = [];
  for (const ys of years) {
    for (const s of segmentsForYear(data, metric, ys).segments) {
      if (s.from < end && store.addDays(s.to, 1) > start) {
        out.push({ version: s.version, from: s.from, to: s.to, annualTons: s.annualTons, changeId: s.changeId, basisDoc: s.basisDoc });
      }
    }
  }
  return out;
}

function validateChange(data, payload) {
  const errors = {};
  const p = payload || {};
  if (!PERMIT_METRICS.includes(p.metric)) errors.metric = '指标只能是：' + PERMIT_METRICS.join('、');
  const eff = String(p.effectiveAt || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eff)) errors.effectiveAt = '变更生效时刻要像 2026-07-01（可带时分秒）';
  const after = Number(p.afterTons);
  if (p.afterTons === undefined || p.afterTons === '' || !Number.isFinite(after) || after < 0) errors.afterTons = '变更后年许可量要是不小于 0 的数字';
  if (!String(p.basisDoc || '').trim()) errors.basisDoc = '依据文件不能为空';
  if (!String(p.registeredBy || '').trim()) errors.registeredBy = '登记人不能为空';
  const carryOverEnabled = p.carryOverEnabled === true || p.carryOverEnabled === '是' || p.carryOverEnabled === 'true';
  const carryOverTons = Number(p.carryOverTons);
  if (carryOverEnabled && (!Number.isFinite(carryOverTons) || carryOverTons < 0)) {
    errors.carryOverTons = '声明了结转就要给出不小于 0 的结转量（吨）';
  }
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这条变更登记没通过校验', errors);
  return { metric: p.metric, effectiveAt: eff, afterTons: after, carryOverEnabled, carryOverTons: carryOverEnabled ? carryOverTons : 0 };
}

// 登记变更：变更前数值由系统按生效日前一天生效的许可自动带出，不许手工改历史
function createChange(data, payload) {
  const p = validateChange(data, payload);
  const before = permitAt(data, p.metric, store.addDays(p.effectiveAt, -1));
  const siblings = changesOf(data, p.metric);
  const prev = siblings.filter((c) => c.effectiveAt < p.effectiveAt).pop() || null;
  const yearOf = (day) => store.permitYearOf(day, data.settings.permitYearStart).start;
  const change = {
    id: store.nextId('pc', data.permitChanges),
    metric: p.metric,
    effectiveAt: p.effectiveAt,
    beforeTons: before.tons,
    afterTons: p.afterTons,
    basisDoc: String(payload.basisDoc).trim(),
    registeredBy: String(payload.registeredBy).trim(),
    registeredAt: store.nowText(),
    carryOverEnabled: p.carryOverEnabled,
    carryOverTons: p.carryOverTons,
    // 跨年变更：生效日所在许可年晚于上一条变更所在许可年（首条变更不算跨年）
    crossYear: !!(prev && yearOf(p.effectiveAt) > yearOf(prev.effectiveAt)),
  };
  data.permitChanges.push(change);
  return decorateChange(data, change);
}

// 删除变更登记：已被已上报报表快照引用的不许删
function removeChange(data, id) {
  const change = (data.permitChanges || []).find((c) => c.id === id);
  if (!change) throw new AppError(404, 'PERMIT_CHANGE_NOT_FOUND', '这条变更登记不存在');
  const frozen = data.reports.filter((r) => r.status === '已上报' && r.snapshot && JSON.stringify(r.snapshot).indexOf('"' + id + '"') !== -1);
  if (frozen.length) {
    throw new AppError(409, 'PERMIT_CHANGE_FROZEN', '这条变更已被已上报报表 ' + frozen.map((r) => r.id).join('、') + ' 引用，不能删除', { reports: frozen.map((r) => r.id) });
  }
  data.permitChanges = data.permitChanges.filter((c) => c.id !== id);
  return { removed: id };
}

function listChanges(data, query) {
  const q = query || {};
  let rows = changesOf(data, q.metric || null);
  if (!q.metric) rows = (data.permitChanges || []).slice().sort((a, b) => (a.effectiveAt < b.effectiveAt ? -1 : a.effectiveAt > b.effectiveAt ? 1 : 0));
  return rows.map((c) => decorateChange(data, c));
}

module.exports = {
  PERMIT_METRICS, baselineTons, changesOf, decorateChange, permitAt,
  segmentsForYear, carryOverForYear, permitForRange, versionsOfMonth,
  createChange, removeChange, listChanges,
};
