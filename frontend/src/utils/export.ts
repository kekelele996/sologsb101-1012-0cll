/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入；
 * 以及按台阵汇总的几何与标定结论生成。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload,
} from '@/utils/db';
import type { ResponseVerdict } from '@/types/calibration';
import type { LoanSlip } from '@/types/loan';
import { apertureKm, centroid, haversineKm, round, stationDistances } from '@/utils/geo';
import { buildSerialRegistry } from '@/utils/reconcile';

/** 备份集合键名 */
export const BACKUP_KEYS = ['arrays', 'stations', 'instruments', 'calibrations', 'replaces', 'loans'] as const;
export type BackupKey = (typeof BACKUP_KEYS)[number];

export type CountMap = Record<BackupKey, number>;

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [arrays, stations, instruments, calibrations, replaces, loans] = await Promise.all([
    db.arrays.toArray(),
    db.stations.toArray(),
    db.instruments.toArray(),
    db.calibrations.toArray(),
    db.replaces.toArray(),
    db.loans.toArray(),
  ]);
  return {
    app: 'gbseisarray',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    arrays,
    stations,
    instruments,
    calibrations,
    replaces,
    loans,
  };
}

/** 校验外部 JSON 是否为本站可识别的备份文件 */
export function validateBackup(input: unknown): {
  ok: boolean;
  errors: string[];
  payload: BackupPayload | null;
} {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null };
  }
  const obj = input as Partial<BackupPayload>;
  if (obj.app !== undefined && obj.app !== 'gbseisarray') {
    errors.push('app 字段应为 gbseisarray，文件来源不明');
  }
  for (const key of ['arrays', 'stations', 'instruments', 'calibrations', 'replaces'] as const) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`);
  }
  if (obj.loans !== undefined && !Array.isArray(obj.loans)) {
    errors.push('loans 字段应为数组');
  }
  if (errors.length > 0) return { ok: false, errors, payload: null };
  const payload: BackupPayload = {
    app: 'gbseisarray',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    arrays: obj.arrays ?? [],
    stations: obj.stations ?? [],
    instruments: obj.instruments ?? [],
    calibrations: obj.calibrations ?? [],
    replaces: obj.replaces ?? [],
    loans: obj.loans ?? [],
  };
  return { ok: true, errors, payload };
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    arrays: payload.arrays.length,
    stations: payload.stations.length,
    instruments: payload.instruments.length,
    calibrations: payload.calibrations.length,
    replaces: payload.replaces.length,
    loans: payload.loans?.length ?? 0,
  };
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload();
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
  stampBackupTime(payload.exportedAt);
  return { fileName, counts: countPayload(payload) };
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file, 'utf-8');
  });
}

/** 导入快照：overwrite=true 先清空全部表，否则按主键合并 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  if (overwrite) await clearAllTables();
  await db.transaction(
    'rw',
    [db.arrays, db.stations, db.instruments, db.calibrations, db.replaces, db.loans],
    async () => {
      await db.arrays.bulkPut(payload.arrays);
      await db.stations.bulkPut(payload.stations);
      await db.instruments.bulkPut(payload.instruments);
      await db.calibrations.bulkPut(payload.calibrations);
      await db.replaces.bulkPut(payload.replaces);
      if (payload.loans) await db.loans.bulkPut(payload.loans);
    }
  );
  return countPayload(payload);
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const arrayMap = new Map<string, string>();
  const stationMap = new Map<string, string>();
  const instrumentMap = new Map<string, string>();

  const arrays = payload.arrays.map((row) => {
    const id = createId('arr');
    arrayMap.set(row.id, id);
    return { ...row, id };
  });
  const stations = payload.stations.map((row) => {
    const id = createId('stn');
    stationMap.set(row.id, id);
    return { ...row, id, arrayId: arrayMap.get(row.arrayId) ?? row.arrayId };
  });
  const instruments = payload.instruments.map((row) => {
    const id = createId('ins');
    instrumentMap.set(row.id, id);
    return { ...row, id, stationId: stationMap.get(row.stationId) ?? row.stationId };
  });
  const calibrations = payload.calibrations.map((row) => ({
    ...row,
    id: createId('cal'),
    instrumentId: instrumentMap.get(row.instrumentId) ?? row.instrumentId,
  }));
  const replaces = payload.replaces.map((row) => ({
    ...row,
    id: createId('rpl'),
    instrumentId: instrumentMap.get(row.instrumentId) ?? row.instrumentId,
  }));
  const loans: LoanSlip[] = (payload.loans ?? []).map((row) => ({
    ...row,
    id: createId('loan'),
    lenderArrayId: arrayMap.get(row.lenderArrayId) ?? row.lenderArrayId,
    borrowerArrayId: arrayMap.get(row.borrowerArrayId) ?? row.borrowerArrayId,
    installStationId: row.installStationId ? stationMap.get(row.installStationId) ?? row.installStationId : null,
  }));
  return { ...payload, arrays, stations, instruments, calibrations, replaces, loans };
}

/** 按台阵汇总的几何与标定结论 */
export interface ArrayGeometrySummary {
  arrayId: string;
  arrayName: string;
  state: string;
  department: string;
  deployDate: string;
  /** 数据库登记的孔径 */
  recordedApertureKm: number;
  /** 由经纬度实算的孔径（最大台间距） */
  computedApertureKm: number;
  stationCount: number;
  /** 在账台数（同一序列号只计一次，统一对账口径） */
  instrumentCount: number;
  /** 借入 / 借出（未结）/ 在途 / 挂起台数 */
  borrowedInCount: number;
  lentOutCount: number;
  inTransitCount: number;
  suspendedCount: number;
  /** 几何中心 */
  center: { lat: number; lng: number } | null;
  /** 最大台间距的两端台站码与方位角 */
  maxPair: { fromCode: string; toCode: string; km: number } | null;
  /** 最小台间距（km） */
  minSpacingKm: number;
  /** 平均台间距（km） */
  meanSpacingKm: number;
  calibrationCount: number;
  unqualifiedCount: number;
  overdueCount: number;
  /** 按期标定率（统一对账口径，借调未归还不进超期） */
  onScheduleRate: number;
  pendingReplaceCount: number;
  conclusion: string;
}

/** 由快照计算台阵几何与标定结论（供 /geometry 页展示） */
export function buildArraySummaries(payload: BackupPayload): ArrayGeometrySummary[] {
  const loans = payload.loans ?? [];
  const registry = buildSerialRegistry({
    arrays: payload.arrays,
    stations: payload.stations,
    instruments: payload.instruments,
    calibrations: payload.calibrations,
    loans,
  });

  return payload.arrays.map((array) => {
    const stations = payload.stations.filter((station) => station.arrayId === array.id);
    const ledger = registry.arrayStats.get(array.id);

    // 在账仪器：以统一对账归属到本台阵的序列号为准
    const accountInstruments = registry.entries.filter(
      (entry) => !entry.suspended && entry.custody?.kind === 'array' && entry.custody.arrayId === array.id
    );
    const accountInstrumentIds = new Set(
      accountInstruments.map((entry) => entry.instrument?.id).filter((id): id is string => !!id)
    );
    const calibrations = payload.calibrations.filter((calibration) =>
      accountInstrumentIds.has(calibration.instrumentId)
    );
    const replaces = payload.replaces.filter((replace) => accountInstrumentIds.has(replace.instrumentId));

    const points = stations.map((station) => ({
      id: station.id,
      code: station.code,
      lat: station.lat,
      lng: station.lng,
    }));
    const distances = stationDistances(points);
    const computed = apertureKm(points);
    const center = centroid(points);
    const minSpacingKm = distances.length === 0 ? 0 : distances[distances.length - 1].km;
    const meanSpacingKm =
      distances.length === 0
        ? 0
        : round(distances.reduce((sum, row) => sum + row.km, 0) / distances.length, 3);

    const unqualifiedCount = calibrations.filter(
      (calibration) => calibration.responseVerdict === '不合格'
    ).length;
    // 超期台数直接取统一对账结果（借调未归还、挂起的都不含）
    const overdueCount = ledger?.overdueCount ?? 0;
    const accountCount = ledger?.accountCount ?? 0;
    const pendingReplaceCount = replaces.filter((replace) => replace.state !== '已复核').length;

    const conclusionParts: string[] = [
      `${stations.length} 个台站、在账 ${accountCount} 台`,
      `实算孔径 ${computed} km`,
      `累计 ${calibrations.length} 次标定`,
    ];
    if ((ledger?.borrowedInCount ?? 0) > 0) conclusionParts.push(`借入 ${ledger?.borrowedInCount} 台`);
    if ((ledger?.lentOutCount ?? 0) > 0) conclusionParts.push(`借出未归还 ${ledger?.lentOutCount} 台`);
    if ((ledger?.inTransitCount ?? 0) > 0) conclusionParts.push(`在途 ${ledger?.inTransitCount} 台`);
    if (unqualifiedCount > 0) conclusionParts.push(`${unqualifiedCount} 次标定不合格`);
    if (overdueCount > 0) conclusionParts.push(`${overdueCount} 台超期未标定`);
    if ((ledger?.suspendedCount ?? 0) > 0) conclusionParts.push(`挂起 ${ledger?.suspendedCount} 台`);
    if (pendingReplaceCount > 0) conclusionParts.push(`${pendingReplaceCount} 条更换未闭环`);

    return {
      arrayId: array.id,
      arrayName: array.name,
      state: array.state,
      department: array.department,
      deployDate: array.deployDate,
      recordedApertureKm: array.apertureKm,
      computedApertureKm: computed,
      stationCount: stations.length,
      instrumentCount: accountCount,
      borrowedInCount: ledger?.borrowedInCount ?? 0,
      lentOutCount: ledger?.lentOutCount ?? 0,
      inTransitCount: ledger?.inTransitCount ?? 0,
      suspendedCount: ledger?.suspendedCount ?? 0,
      center,
      maxPair:
        distances.length === 0
          ? null
          : {
              fromCode: distances[0].fromCode,
              toCode: distances[0].toCode,
              km: distances[0].km,
            },
      minSpacingKm,
      meanSpacingKm,
      calibrationCount: calibrations.length,
      unqualifiedCount,
      overdueCount,
      onScheduleRate: ledger?.onScheduleRate ?? 0,
      pendingReplaceCount,
      conclusion: conclusionParts.join('，'),
    };
  });
}

/** 判定结论统计 */
export function verdictCounts(calibrations: Array<{ responseVerdict: ResponseVerdict }>): Record<
  ResponseVerdict,
  number
> {
  const counts: Record<ResponseVerdict, number> = { 合格: 0, 不合格: 0, 待判定: 0 };
  calibrations.forEach((calibration) => {
    counts[calibration.responseVerdict] += 1;
  });
  return counts;
}

/** 样例：台站与台阵中心的最远距离（km），用于几何页展示各台站辐射距离 */
export function stationRadialDistances(
  points: Array<{ id: string; code: string; lat: number; lng: number }>,
  center: { lat: number; lng: number } | null
): Array<{ id: string; code: string; km: number }> {
  if (!center) return [];
  return points
    .map((point) => ({ id: point.id, code: point.code, km: haversineKm(center, point) }))
    .sort((a, b) => b.km - a.km);
}
