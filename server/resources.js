const { AppError } = require('./errors');
const store = require('./store');
const monitor = require('./monitor');

const PLANT_STATUS = ['生产', '停产', '调试'];
const OUTLET_STATUS = ['运行', '停用'];
const OUTLET_TYPE = ['主要排放口', '一般排放口'];
const DEVICE_STATUS = ['正常', '校准', '维护', '故障'];
const METRICS = ['COD', '氨氮', '流量', '氧含量'];
const FLAGS = ['有效', '无效'];
const SOURCES = ['自动', '补录'];
const REPORT_STATUS = ['草稿', '已上报', '退回'];
const CARRY_MODES = ['none', 'full', 'fixed'];
const CARRY_LABELS = { none: '不结转', full: '上年结余全额结转', fixed: '指定结余量' };

function isValidDay(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(text || ''))) return false;
  const [y, m, d] = String(text).split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > store.daysInMonth(y + '-' + String(m).padStart(2, '0'))) return false;
  return y >= 2000 && y <= 2100;
}

// ---------- 排污许可分段（变更登记） ----------

// 该生效日的版本是否为其许可年的开户段（许可年内最早一条，且前一段在更早许可年）
// predVersions：已存在版本（校验新建时不含候选自身）
function boundaryAmong(plant, versions, effectiveFrom) {
  const yIdx = monitor.permitYearIndex(plant, effectiveFrom);
  const earlier = versions.filter((v) => v.effectiveFrom < effectiveFrom);
  const sameYearEarlier = versions.some((v) => v.effectiveFrom < effectiveFrom && monitor.permitYearIndex(plant, v.effectiveFrom) === yIdx);
  if (sameYearEarlier) return false; // 许可年内已有更早登记，本版不是开户段
  const anchor = earlier.length ? earlier[earlier.length - 1].effectiveFrom : String(plant.permitYearStart);
  return monitor.permitYearIndex(plant, anchor) < yIdx;
}

function isBoundaryVersion(data, plant, effectiveFrom) {
  return boundaryAmong(plant, monitor.plantVersions(data, plant.id), effectiveFrom);
}

// 装饰用：某条已存在版本是否跨年开户（排除自身）
function versionBoundaryFlag(data, plant, version) {
  const others = monitor.plantVersions(data, plant.id).filter((x) => x.id !== version.id);
  return boundaryAmong(plant, others, version.effectiveFrom);
}

// 已上报快照引用过的版本一律冻结（报表当前状态无关，保护当时结论）
function frozenVersionMap(data) {
  const map = {};
  for (const r of data.reports) {
    for (const snap of r.snapshots || []) {
      for (const vid of snap.versionIds || []) {
        map[vid] = { reportId: r.id, seq: snap.seq, savedAt: snap.savedAt, savedBy: snap.savedBy || '' };
      }
    }
  }
  return map;
}

function carryLabel(v, metric) {
  const c = (v.carryover || {})[metric] || {};
  return CARRY_LABELS[c.mode] || '不结转';
}

function decorateVersion(data, v) {
  const plant = monitor.plantOf(data, v.plantId);
  const frozen = frozenVersionMap(data);
  const versions = monitor.plantVersions(data, v.plantId);
  return Object.assign({}, v, {
    plantCode: plant ? plant.code : '',
    plantName: plant ? plant.name : '',
    frozen: !!frozen[v.id],
    boundary: versionBoundaryFlag(data, plant, v),
    isLatest: versions.length ? versions[versions.length - 1].id === v.id : true,
    carryLabels: { COD: carryLabel(v, 'COD'), '氨氮': carryLabel(v, '氨氮') },
  });
}

function listPermitVersions(data, query) {
  const q = query || {};
  let rows = (data.permitVersions || []).slice();
  if (q.plantId) rows = rows.filter((v) => v.plantId === q.plantId);
  return rows.map((v) => decorateVersion(data, v))
    .sort((a, b) => (a.plantId === b.plantId ? (a.effectiveFrom < b.effectiveFrom ? -1 : 1) : a.plantId < b.plantId ? -1 : 1));
}

function permitDetail(data, plantId) {
  const plant = data.plants.find((p) => p.id === plantId);
  if (!plant) throw new AppError(404, 'PLANT_NOT_FOUND', '这个排污单位不存在');
  const versions = monitor.plantVersions(data, plantId).map((v) => decorateVersion(data, v));
  return {
    plant,
    versions,
    synthetic: monitor.syntheticVersion(data, plant),
  };
}

function normalizeCarryover(payload) {
  const out = {};
  for (const metric of monitor.PERMIT_METRICS) {
    const c = (payload && payload[metric]) || {};
    const mode = CARRY_MODES.includes(c.mode) ? c.mode : 'none';
    out[metric] = { mode, amount: mode === 'fixed' ? store.round(Number(c.amount), 4) : 0 };
  }
  return out;
}

function validatePermitVersion(data, plant, payload, current) {
  const errors = {};
  const effectiveFrom = current ? current.effectiveFrom : payload.effectiveFrom;
  if (!isValidDay(effectiveFrom)) errors.effectiveFrom = '生效日要像 2026-09-10，且是真实日期';
  for (const [field, label] of [['codTons', 'COD 年许可量'], ['ammoniaTons', '氨氮年许可量']]) {
    const v = Number(payload[field]);
    if (!Number.isFinite(v) || v < 0) errors[field] = label + '要是不小于 0 的数字';
  }
  if (!String(payload.documentRef || '').trim()) errors.documentRef = '依据文件不能为空（批复/变更文件名称或文号）';
  if (!String(payload.registeredBy || '').trim()) errors.registeredBy = '登记人不能为空';
  // 新建：允许补登历史日期（如事后补登新许可年生效版本），但同日不得重复
  if (!current && isValidDay(effectiveFrom)) {
    if (monitor.plantVersions(data, plant.id).some((v) => v.effectiveFrom === effectiveFrom)) {
      throw new AppError(409, 'VERSION_DATE_CONFLICT', '该生效日已经登记过一次变更', { effectiveFrom });
    }
  }
  // 跨年开户段：结转方式逐指标校验
  const boundary = current ? false : isBoundaryVersion(data, plant, effectiveFrom);
  const carry = (payload.carryover && typeof payload.carryover === 'object') ? payload.carryover : {};
  for (const metric of monitor.PERMIT_METRICS) {
    const c = carry[metric] || {};
    if (boundary) {
      if (!CARRY_MODES.includes(c.mode)) errors['carryover.' + metric + '.mode'] = '请选择上年余额结转方式';
      if (c.mode === 'fixed' && (!Number.isFinite(Number(c.amount)) || Number(c.amount) < 0)) {
        errors['carryover.' + metric + '.amount'] = '指定结余量要是不小于 0 的数字（吨）';
      }
    }
  }
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '变更登记有几项没通过校验', errors);
  return { boundary };
}

function createPermitVersion(data, payload) {
  const plant = data.plants.find((p) => p.id === payload.plantId);
  if (!plant) throw new AppError(400, 'VALIDATION_FAILED', '变更登记没通过校验', { plantId: '排污单位不存在' });
  const { boundary } = validatePermitVersion(data, plant, payload, null);
  const version = {
    id: store.nextId('pv', data.permitVersions),
    plantId: plant.id,
    effectiveFrom: String(payload.effectiveFrom),
    codTons: store.round(Number(payload.codTons), 4),
    ammoniaTons: store.round(Number(payload.ammoniaTons), 4),
    documentRef: String(payload.documentRef).trim(),
    registeredBy: String(payload.registeredBy).trim(),
    registeredAt: store.nowText(),
    carryover: boundary ? normalizeCarryover(payload.carryover) : { COD: { mode: 'none', amount: 0 }, '氨氮': { mode: 'none', amount: 0 } },
    remark: String(payload.remark || ''),
  };
  data.permitVersions.push(version);
  return decorateVersion(data, version);
}

function updatePermitVersion(data, id, payload) {
  const version = data.permitVersions.find((v) => v.id === id);
  if (!version) throw new AppError(404, 'VERSION_NOT_FOUND', '这条变更登记不存在');
  const frozen = frozenVersionMap(data);
  if (frozen[id]) {
    throw new AppError(409, 'VERSION_FROZEN', '该版本已被已上报月报快照引用（' + frozen[id].reportId + ' 第 ' + frozen[id].seq + ' 次冻结），数值不能再改', frozen[id]);
  }
  const illegal = ['plantId', 'effectiveFrom', 'registeredAt'].filter((k) => payload[k] !== undefined);
  if (illegal.length) {
    throw new AppError(400, 'VALIDATION_FAILED', '排污单位、生效日、登记时刻不可修改', Object.fromEntries(illegal.map((k) => [k, '不可修改字段'])));
  }
  const plant = data.plants.find((p) => p.id === version.plantId);
  const merged = Object.assign({}, version, payload);
  validatePermitVersion(data, plant, merged, version);
  Object.assign(version, {
    codTons: store.round(Number(merged.codTons), 4),
    ammoniaTons: store.round(Number(merged.ammoniaTons), 4),
    documentRef: String(merged.documentRef).trim(),
    registeredBy: String(merged.registeredBy).trim(),
    remark: String(merged.remark !== undefined ? merged.remark : version.remark),
  });
  return decorateVersion(data, version);
}

function removePermitVersion(data, id) {
  const version = data.permitVersions.find((v) => v.id === id);
  if (!version) throw new AppError(404, 'VERSION_NOT_FOUND', '这条变更登记不存在');
  const frozen = frozenVersionMap(data);
  if (frozen[id]) {
    throw new AppError(409, 'VERSION_FROZEN', '该版本已被已上报月报快照引用，不能删除', frozen[id]);
  }
  const versions = monitor.plantVersions(data, version.plantId);
  if (versions[versions.length - 1].id !== id) {
    throw new AppError(409, 'VERSION_HAS_SUCCESSOR', '只能删除最后一条变更登记，中间版本要保留以维持分段链', { latest: versions[versions.length - 1].id });
  }
  data.permitVersions = data.permitVersions.filter((v) => v.id !== id);
  return { removed: id };
}

// 许可年台账：逐月给出分段构成、月许可/已用、年累计与剩余，以及该月冻结记录
function plantLedger(data, plantId, query) {
  const plant = data.plants.find((p) => p.id === plantId);
  if (!plant) throw new AppError(404, 'PLANT_NOT_FOUND', '这个排污单位不存在');
  const q = query || {};
  const monthSet = new Set();
  for (const r of data.readings) {
    const o = data.outlets.find((x) => x.id === r.outletId);
    if (o && o.plantId === plantId) monthSet.add(store.monthOf(r.at));
  }
  for (const v of monitor.plantVersions(data, plantId)) monthSet.add(v.effectiveFrom.slice(0, 7));
  for (const r of data.reports) if (r.plantId === plantId) monthSet.add(r.period);
  monthSet.add(String(plant.permitYearStart || data.settings.permitYearStart).slice(0, 7));
  const all = Array.from(monthSet).sort();
  const from = /^\d{4}-\d{2}$/.test(q.from) ? q.from : all[0];
  const to = /^\d{4}-\d{2}$/.test(q.to) ? q.to : all[all.length - 1];
  const months = [];
  let cur = from;
  while (cur <= to) {
    months.push(cur);
    const [y, m] = cur.split('-').map(Number);
    cur = (m === 12 ? y + 1 + '-01' : y + '-' + String(m + 1).padStart(2, '0'));
  }
  const rows = months.map((month) => {
    const acc = monitor.plantMonthAccounting(data, plantId, month);
    const frozenMonths = data.reports.filter((r) => r.plantId === plantId && r.period === month)
      .flatMap((r) => (r.snapshots || []).map((s) => ({
        reportId: r.id, status: r.status, seq: s.seq, savedAt: s.savedAt, savedBy: s.savedBy || '', versionIds: s.versionIds || [],
      })));
    return Object.assign({}, acc, { frozen: frozenMonths });
  });
  return { plant, months: rows };
}

function decoratePlant(data, plant, month) {
  const outlets = monitor.outletsOf(data, plant.id);
  return Object.assign({}, plant, {
    outletCount: outlets.length,
    deviceCount: data.devices.filter((d) => outlets.some((o) => o.id === d.outletId)).length,
    readingCount: data.readings.filter((r) => outlets.some((o) => o.id === r.outletId)).length,
    reportCount: data.reports.filter((r) => r.plantId === plant.id).length,
    outletList: outlets.map((o) => Object.assign({}, o, {
      deviceCount: data.devices.filter((d) => d.outletId === o.id).length,
      readingCount: data.readings.filter((r) => r.outletId === o.id).length,
    })),
  });
}

function listPlants(data, query) {
  const q = query || {};
  let rows = data.plants.slice();
  if (q.status) rows = rows.filter((p) => p.status === q.status);
  if (q.keyword) {
    const kw = String(q.keyword).toLowerCase();
    rows = rows.filter((p) => [p.code, p.name, p.industry].some((f) => String(f || '').toLowerCase().includes(kw)));
  }
  return rows.map((p) => decoratePlant(data, p)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function plantDetail(data, id) {
  const plant = data.plants.find((p) => p.id === id);
  if (!plant) throw new AppError(404, 'PLANT_NOT_FOUND', '这个排污单位不存在');
  const outlets = monitor.outletsOf(data, plant.id);
  return Object.assign({}, decoratePlant(data, plant), {
    outlets: outlets.map((o) => Object.assign({}, o, {
      devices: data.devices.filter((d) => d.outletId === o.id),
      deviceCount: data.devices.filter((d) => d.outletId === o.id).length,
      readingCount: data.readings.filter((r) => r.outletId === o.id).length,
    })),
    reports: data.reports.filter((r) => r.plantId === plant.id).map((r) => ({
      id: r.id, plantId: r.plantId, period: r.period, status: r.status,
      submittedAt: r.submittedAt, submittedBy: r.submittedBy, remark: r.remark,
      snapshotCount: Array.isArray(r.snapshots) ? r.snapshots.length : 0,
      frozen: Array.isArray(r.snapshots) && r.snapshots.length > 0,
    })).sort((a, b) => (a.period < b.period ? 1 : -1)),
    findings: (data.findings || []).filter((f) => f.plantId === plant.id),
  });
}

function validatePlant(payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编码不能为空';
  if (!String(merged.name || '').trim()) errors.name = '名称不能为空';
  if (!PLANT_STATUS.includes(merged.status)) errors.status = '状态只能是：' + PLANT_STATUS.join('、');
  if (!String(merged.permitNo || '').trim()) errors.permitNo = '排污许可证号不能为空';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createPlant(data, payload) {
  validatePlant(payload, null);
  const plant = {
    id: store.nextId('pt', data.plants),
    code: String(payload.code).trim(),
    name: String(payload.name).trim(),
    industry: String(payload.industry || '').trim(),
    status: payload.status,
    permitNo: String(payload.permitNo).trim(),
    permitYearStart: String(payload.permitYearStart || data.settings.permitYearStart),
    remark: String(payload.remark || ''),
  };
  data.plants.push(plant);
  return decoratePlant(data, plant);
}

function updatePlant(data, id, payload) {
  const plant = data.plants.find((p) => p.id === id);
  if (!plant) throw new AppError(404, 'PLANT_NOT_FOUND', '这个排污单位不存在');
  validatePlant(payload, plant);
  const merged = Object.assign({}, plant, payload);
  Object.assign(plant, {
    name: String(merged.name).trim(),
    industry: String(merged.industry || '').trim(),
    status: merged.status,
    permitNo: String(merged.permitNo).trim(),
    permitYearStart: String(merged.permitYearStart || plant.permitYearStart),
    remark: String(merged.remark || ''),
  });
  return decoratePlant(data, plant);
}

function removePlant(data, id) {
  const plant = data.plants.find((p) => p.id === id);
  if (!plant) throw new AppError(404, 'PLANT_NOT_FOUND', '这个排污单位不存在');
  const outlets = monitor.outletsOf(data, plant.id);
  const used = outlets.length + data.readings.filter((r) => outlets.some((o) => o.id === r.outletId)).length;
  if (used > 0) throw new AppError(409, 'PLANT_IN_USE', '名下还有排放口与监测数据，不能删除', { count: used });
  data.plants = data.plants.filter((p) => p.id !== id);
  data.permitVersions = data.permitVersions.filter((v) => v.plantId !== id);
  return { removed: id };
}

function listOutlets(data, query) {
  const q = query || {};
  let rows = data.outlets.slice();
  if (q.plantId) rows = rows.filter((o) => o.plantId === q.plantId);
  if (q.status) rows = rows.filter((o) => o.status === q.status);
  return rows.map((o) => {
    const plant = monitor.plantOf(data, o.plantId);
    return Object.assign({}, o, {
      plantCode: plant ? plant.code : '',
      plantName: plant ? plant.name : '',
      deviceCount: data.devices.filter((d) => d.outletId === o.id).length,
      readingCount: data.readings.filter((r) => r.outletId === o.id).length,
    });
  }).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function validateOutlet(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编码不能为空';
  if (!data.plants.some((p) => p.id === merged.plantId)) errors.plantId = '排污单位不存在';
  if (!OUTLET_TYPE.includes(merged.type)) errors.type = '类型只能是：' + OUTLET_TYPE.join('、');
  if (!OUTLET_STATUS.includes(merged.status)) errors.status = '状态只能是：' + OUTLET_STATUS.join('、');
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createOutlet(data, payload) {
  validateOutlet(data, payload, null);
  const outlet = {
    id: store.nextId('ol', data.outlets),
    code: String(payload.code).trim(),
    name: String(payload.name || '').trim(),
    plantId: payload.plantId,
    type: payload.type,
    status: payload.status,
    remark: String(payload.remark || ''),
  };
  data.outlets.push(outlet);
  return outlet;
}

function updateOutlet(data, id, payload) {
  const outlet = data.outlets.find((o) => o.id === id);
  if (!outlet) throw new AppError(404, 'OUTLET_NOT_FOUND', '这个排放口不存在');
  validateOutlet(data, payload, outlet);
  const merged = Object.assign({}, outlet, payload);
  Object.assign(outlet, {
    name: String(merged.name || '').trim(),
    plantId: merged.plantId,
    type: merged.type,
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  return outlet;
}

function removeOutlet(data, id) {
  const outlet = data.outlets.find((o) => o.id === id);
  if (!outlet) throw new AppError(404, 'OUTLET_NOT_FOUND', '这个排放口不存在');
  const used = data.readings.filter((r) => r.outletId === id).length;
  if (used > 0) throw new AppError(409, 'OUTLET_IN_USE', '这个排放口名下还有 ' + used + ' 条监测数据，不能删除', { count: used });
  data.devices = data.devices.filter((d) => d.outletId !== id);
  data.outlets = data.outlets.filter((o) => o.id !== id);
  return { removed: id };
}

function listDevices(data, query) {
  const q = query || {};
  let rows = data.devices.slice();
  if (q.outletId) rows = rows.filter((d) => d.outletId === q.outletId);
  if (q.metric) rows = rows.filter((d) => d.metric === q.metric);
  if (q.status) rows = rows.filter((d) => d.status === q.status);
  return rows.map((d) => {
    const outlet = monitor.outletOf(data, d.outletId);
    return Object.assign({}, d, {
      outletCode: outlet ? outlet.code : '',
      readingCount: data.readings.filter((r) => r.deviceId === d.id).length,
      invalidCount: data.readings.filter((r) => r.deviceId === d.id && r.flag !== '有效').length,
    });
  }).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function validateDevice(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编号不能为空';
  if (!data.outlets.some((o) => o.id === merged.outletId)) errors.outletId = '排放口不存在';
  if (!METRICS.includes(merged.metric)) errors.metric = '监测指标只能是：' + METRICS.join('、');
  if (!DEVICE_STATUS.includes(merged.status)) errors.status = '设备状态只能是：' + DEVICE_STATUS.join('、');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(merged.calibratedUntil || ''))) errors.calibratedUntil = '校准有效期要像 2026-12-31';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createDevice(data, payload) {
  validateDevice(data, payload, null);
  const device = {
    id: store.nextId('dv', data.devices),
    code: String(payload.code).trim(),
    outletId: payload.outletId,
    metric: payload.metric,
    model: String(payload.model || '').trim(),
    status: payload.status,
    calibratedUntil: String(payload.calibratedUntil),
    remark: String(payload.remark || ''),
  };
  data.devices.push(device);
  return device;
}

function updateDevice(data, id, payload) {
  const device = data.devices.find((d) => d.id === id);
  if (!device) throw new AppError(404, 'DEVICE_NOT_FOUND', '这个监测设备不存在');
  validateDevice(data, payload, device);
  const merged = Object.assign({}, device, payload);
  Object.assign(device, {
    outletId: merged.outletId,
    metric: merged.metric,
    model: String(merged.model || '').trim(),
    status: merged.status,
    calibratedUntil: String(merged.calibratedUntil),
    remark: String(merged.remark || ''),
  });
  return device;
}

function removeDevice(data, id) {
  const device = data.devices.find((d) => d.id === id);
  if (!device) throw new AppError(404, 'DEVICE_NOT_FOUND', '这个监测设备不存在');
  const used = data.readings.filter((r) => r.deviceId === id).length;
  if (used > 0) throw new AppError(409, 'DEVICE_IN_USE', '这台设备名下还有 ' + used + ' 条监测数据，不能删除', { count: used });
  data.devices = data.devices.filter((d) => d.id !== id);
  return { removed: id };
}

function listReadings(data, query) {
  const q = query || {};
  const rows = monitor.readingsOf(data, q);
  const limit = Number(q.limit) > 0 ? Number(q.limit) : 500;
  return {
    total: rows.length,
    returned: Math.min(rows.length, limit),
    rows: rows.slice(0, limit).map((r) => decorateReading(data, r)),
  };
}

function decorateReading(data, row) {
  const device = monitor.deviceOf(data, row.deviceId);
  const outlet = monitor.outletOf(data, row.outletId);
  return Object.assign({}, row, {
    deviceCode: device ? device.code : '',
    deviceStatus: device ? device.status : '',
    outletCode: outlet ? outlet.code : '',
    counted: monitor.isCounted(row, device, data.settings),
    concentration: monitor.effectiveConcentration(row, data.settings),
    oxygen: monitor.oxygenAt(data, row),
    flow: monitor.flowAt(data, row),
  });
}

function validateReading(data, payload) {
  const errors = {};
  if (!data.outlets.some((o) => o.id === payload.outletId)) errors.outletId = '排放口不存在';
  if (!data.devices.some((d) => d.id === payload.deviceId)) errors.deviceId = '监测设备不存在';
  if (!METRICS.includes(payload.metric)) errors.metric = '监测指标只能是：' + METRICS.join('、');
  if (!FLAGS.includes(payload.flag)) errors.flag = '数据标记只能是：' + FLAGS.join('、');
  if (!SOURCES.includes(payload.source)) errors.source = '来源只能是：' + SOURCES.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:00:00$/.test(String(payload.at || ''))) errors.at = '时刻要像 2026-09-01 08:00:00';
  if (payload.value === undefined || payload.value === '') errors.value = '数值不能为空';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这条监测数据没通过校验', errors);
}

function createReading(data, payload) {
  validateReading(data, payload);
  const reading = {
    id: store.nextId('rd', data.readings),
    outletId: payload.outletId,
    deviceId: payload.deviceId,
    metric: payload.metric,
    at: String(payload.at),
    value: Number(payload.value),
    flag: payload.flag,
    source: payload.source,
    operator: String(payload.operator || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.readings.push(reading);
  return decorateReading(data, reading);
}

function updateReading(data, id, payload) {
  const reading = data.readings.find((r) => r.id === id);
  if (!reading) throw new AppError(404, 'READING_NOT_FOUND', '这条监测数据不存在');
  validateReading(data, Object.assign({}, reading, payload));
  Object.assign(reading, {
    at: String(payload.at || reading.at),
    value: payload.value === undefined ? reading.value : Number(payload.value),
    flag: payload.flag || reading.flag,
    source: payload.source || reading.source,
    remark: payload.remark === undefined ? reading.remark : String(payload.remark),
  });
  return decorateReading(data, reading);
}

function removeReading(data, id) {
  const reading = data.readings.find((r) => r.id === id);
  if (!reading) throw new AppError(404, 'READING_NOT_FOUND', '这条监测数据不存在');
  data.readings = data.readings.filter((r) => r.id !== id);
  return { removed: id };
}

function listReports(data, query) {
  const q = query || {};
  let rows = data.reports.slice();
  if (q.plantId) rows = rows.filter((r) => r.plantId === q.plantId);
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  return rows.map((r) => {
    const plant = monitor.plantOf(data, r.plantId);
    const snapshotCount = Array.isArray(r.snapshots) ? r.snapshots.length : 0;
    return Object.assign({}, r, {
      plantCode: plant ? plant.code : '',
      plantName: plant ? plant.name : '',
      snapshotCount,
      frozen: snapshotCount > 0,
      snapshots: undefined
    });
  }).sort((a, b) => (a.period < b.period ? 1 : -1));
}

function reportDetail(data, id, query) {
  const report = data.reports.find((r) => r.id === id);
  if (!report) throw new AppError(404, 'REPORT_NOT_FOUND', '这张报表不存在');
  const plant = monitor.plantOf(data, report.plantId);
  const month = String(report.period).slice(0, 7);
  const outlets = monitor.outletsOf(data, report.plantId).map((o) => monitor.outletSummary(data, o.id, month));
  const snapshots = report.snapshots || [];
  const out = Object.assign({}, report, {
    plant, month, outlets,
    frozen: snapshots.length > 0,
    snapshot: snapshots.length ? snapshots[snapshots.length - 1] : null,
    snapshotHistory: snapshots.map((s) => ({ seq: s.seq, savedAt: s.savedAt, savedBy: s.savedBy, conclusion: s.conclusion, permitYear: s.permitYear })),
  });
  if (query && query.compare === '1') out.live = monitor.plantMonthAccounting(data, report.plantId, month);
  return out;
}

function createReport(data, payload) {
  const errors = {};
  if (!data.plants.some((p) => p.id === payload.plantId)) errors.plantId = '排污单位不存在';
  if (!/^\d{4}-\d{2}$/.test(String(payload.period || ''))) errors.period = '期间要像 2026-09';
  const status = REPORT_STATUS.includes(payload.status) ? payload.status : '草稿';
  if (status === '已上报' && !String(payload.submittedBy || '').trim()) errors.submittedBy = '上报时上报人不能为空';
  if (data.reports.some((r) => r.plantId === payload.plantId && r.period === payload.period)) {
    throw new AppError(409, 'REPORT_DUPLICATE_PERIOD', '这个单位这个月已经有一张月报了', { plantId: payload.plantId, period: payload.period });
  }
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这张报表没通过校验', errors);
  const report = {
    id: store.nextId('rp', data.reports),
    plantId: payload.plantId,
    period: String(payload.period),
    status,
    submittedAt: status === '已上报' ? store.nowText() : '',
    submittedBy: status === '已上报' ? String(payload.submittedBy).trim() : '',
    remark: String(payload.remark || ''),
    snapshots: [],
  };
  data.reports.push(report);
  if (status === '已上报') report.snapshots.push(monitor.buildReportSnapshot(data, report, report.submittedBy));
  return reportDetail(data, report.id, null);
}

function updateReport(data, id, payload) {
  const report = data.reports.find((r) => r.id === id);
  if (!report) throw new AppError(404, 'REPORT_NOT_FOUND', '这张报表不存在');
  if (payload.status && !REPORT_STATUS.includes(payload.status)) {
    throw new AppError(400, 'VALIDATION_FAILED', '状态只能是：' + REPORT_STATUS.join('、'), { status: '状态取值不对' });
  }
  // 已上报且已有冻结快照：只许改备注、退回；退回后快照保留
  // （存量老数据：状态已是已上报但没有快照时不加锁，允许补做第一次冻结）
  const hasSnapshots = (report.snapshots || []).length > 0;
  if (report.status === '已上报' && hasSnapshots) {
    const blocked = Object.keys(payload).filter((k) => !['status', 'remark'].includes(k));
    const illegalStatus = payload.status && payload.status !== '退回';
    if (blocked.length || illegalStatus) {
      const details = Object.fromEntries(blocked.map((k) => [k, '月报已上报冻结，该字段不能改']));
      if (illegalStatus) details.status = '已上报月报只能先退回';
      throw new AppError(409, 'REPORT_LOCKED', '这张月报已上报冻结：只能改备注或退回，退回后可重新上报生成新快照', details);
    }
  }
  const nextStatus = payload.status || report.status;
  const submitting = nextStatus === '已上报' && !(report.snapshots || []).length;
  let submittedBy = report.submittedBy;
  if (payload.submittedBy !== undefined) submittedBy = String(payload.submittedBy).trim();
  if (submitting && !submittedBy) {
    throw new AppError(400, 'VALIDATION_FAILED', '上报时上报人不能为空', { submittedBy: '上报人不能为空' });
  }
  if (payload.remark !== undefined) report.remark = String(payload.remark);
  if (payload.status) report.status = payload.status;
  if (submitting) {
    report.submittedAt = store.nowText();
    report.submittedBy = submittedBy;
    report.snapshots = report.snapshots || [];
    report.snapshots.push(monitor.buildReportSnapshot(data, report, submittedBy));
  }
  return reportDetail(data, id, null);
}

module.exports = {
  listPlants, plantDetail, createPlant, updatePlant, removePlant,
  listOutlets, createOutlet, updateOutlet, removeOutlet,
  listDevices, createDevice, updateDevice, removeDevice,
  listReadings, createReading, updateReading, removeReading, decorateReading,
  listReports, reportDetail, createReport, updateReport,
  listPermitVersions, permitDetail, createPermitVersion, updatePermitVersion, removePermitVersion, plantLedger,
  PLANT_STATUS, OUTLET_STATUS, OUTLET_TYPE, DEVICE_STATUS, METRICS, FLAGS, SOURCES, REPORT_STATUS, CARRY_MODES, CARRY_LABELS,
};
