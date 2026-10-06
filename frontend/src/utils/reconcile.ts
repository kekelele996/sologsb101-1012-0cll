/**
 * 序列号对账与统一口径引擎（周转库 ↔ 台阵台账共用的唯一口径）。
 *
 * 两条台账各管各的，但在账台数、按期标定率、超期名单全部由本文件的派生结果给出，
 * 不允许任何页面各算各的，保证两边同一条口径：
 *
 * 1. 一台序列号同一时间只算一个台阵在用：
 *    - 借调单「出库」那一刻即从借出方（原台阵）出账；
 *    - 在途期间不属于任何台阵（两边在账台数都不含它）；
 *    - 接收台阵登记安装位（借调单转「在借」）才计入接收台阵在账台数；
 *    - 「已归还」后重新计入借出方（原台阵）在账台数。
 * 2. 借调单未归还（在途 / 在借）前，无论是否物理超期，一律不进任何台阵超期名单。
 * 3. 两边按序列号对账：台阵台账的安装位序列号与周转库状态对不上的，挂起该序列号，
 *    只把这一台排除出统计（只退这一台），不影响其他仪器。
 */
import type { SeisArray } from '@/types/array';
import type { SeisStation } from '@/types/station';
import type { Instrument } from '@/types/instrument';
import type { Calibration } from '@/types/calibration';
import type { LoanSlip } from '@/types/loan';
import { isOpenLoan } from '@/types/loan';
import { CALIBRATION_CYCLE_DAYS, daysUntilDue } from '@/types/instrument';

/** 仪器当前在用归属（一个序列号同一时刻至多归属一个台阵，或在途无归属） */
export type SerialCustody =
  | { kind: 'array'; arrayId: string; stationId: string; /** 是否借调借入 */ onLoan: boolean }
  | { kind: 'in-transit'; arrayId: string };

/** 挂起原因 */
export type SuspendReason =
  | 'slip-without-ledger' // 周转库有未结借调单，台账查无此序列号
  | 'install-without-slip' // 台账显示装在非原台阵，却没有对应的未归还借调单
  | 'duplicate-install'; // 同一序列号在台阵台账登记了多个安装位

export interface SerialEntry {
  serialNo: string;
  instrument: Instrument | null;
  /** 最新一条借调单（按出库时间） */
  loan: LoanSlip | null;
  /** 在用归属；null 表示无归属（挂起且无法判定） */
  custody: SerialCustody | null;
  /** 是否挂起（对账不符，退出统计） */
  suspended: boolean;
  suspendReasons: SuspendReason[];
  /** 最近一次标定 */
  latestCalibration: Calibration | null;
  /** 距下次标定天数（负数为已超期）——物理口径 */
  dueInDays: number;
  /** 是否物理超期 */
  physicallyOverdue: boolean;
  /** 是否因未归还借调而暂缓计入超期名单 */
  overdueSuspended: boolean;
  /** 最终是否计入超期名单（物理超期且未被借调暂缓、未挂起） */
  overdue: boolean;
  /** 最终是否按期（在账、未超期、未挂起） */
  onSchedule: boolean;
}

export interface ReconcileInput {
  arrays: SeisArray[];
  stations: SeisStation[];
  instruments: Instrument[];
  calibrations: Calibration[];
  loans: LoanSlip[];
}

export interface ArrayLedgerStat {
  arrayId: string;
  /** 在账台数（同一序列号只计一次） */
  accountCount: number;
  /** 其中借入台数 */
  borrowedInCount: number;
  /** 借出台数（未归还，含在途与在借） */
  lentOutCount: number;
  /** 在途台数（已出库、接收台阵尚未登记安装位） */
  inTransitCount: number;
  /** 参与按期标定率分母的台数（在账且未挂起） */
  ratedCount: number;
  /** 按期台数 */
  onScheduleCount: number;
  /** 超期台数（借调未归还不进超期） */
  overdueCount: number;
  /** 挂起台数（对账不符，只退这一台） */
  suspendedCount: number;
  /** 按期标定率（0-100） */
  onScheduleRate: number;
}

export interface ReconcileResult {
  /** 按序列号归集的台账（含在途、含挂起） */
  entries: SerialEntry[];
  /** 序列号 → 台账条目 */
  bySerial: Map<string, SerialEntry>;
  /** 各台阵在账 / 标定口径统计 */
  arrayStats: Map<string, ArrayLedgerStat>;
  /** 挂起条目（对不上账的序列号，只退这一台） */
  suspended: SerialEntry[];
  /** 在途条目（已出库、尚未登记安装位） */
  inTransit: SerialEntry[];
  /** 全局超期名单（借调未归还的不在内） */
  overdueEntries: SerialEntry[];
}

function latestCalibrationOf(calibrations: Calibration[], instrumentId: string): Calibration | null {
  const rows = calibrations
    .filter((calibration) => calibration.instrumentId === instrumentId)
    .sort((a, b) => b.date.localeCompare(a.date));
  return rows[0] ?? null;
}

/** 借调单有序列号、台账无仪器：构造一条挂起记录（只退这一台） */
function buildMissingInstrumentEntry(loan: LoanSlip): SerialEntry {
  return {
    serialNo: loan.serialNo,
    instrument: null,
    loan,
    custody: loan.state === '在途' ? { kind: 'in-transit', arrayId: loan.lenderArrayId } : null,
    suspended: true,
    suspendReasons: ['slip-without-ledger'],
    latestCalibration: null,
    dueInDays: CALIBRATION_CYCLE_DAYS,
    physicallyOverdue: false,
    overdueSuspended: isOpenLoan(loan.state),
    overdue: false,
    onSchedule: false,
  };
}

/**
 * 统一对账：以序列号为主键，把台阵台账安装位与周转库借调单对齐。
 */
export function buildSerialRegistry(input: ReconcileInput): ReconcileResult {
  const { arrays, stations, instruments, calibrations, loans } = input;

  const stationOfId = new Map(stations.map((station) => [station.id, station]));
  const arrayOfStation = (stationId: string): string | undefined => stationOfId.get(stationId)?.arrayId;

  // 同一序列号的最新借调单（按出库日期、再按创建时间兜底）
  const latestLoanBySerial = new Map<string, LoanSlip>();
  loans.forEach((loan) => {
    const prev = latestLoanBySerial.get(loan.serialNo);
    if (
      !prev ||
      loan.checkoutDate > prev.checkoutDate ||
      (loan.checkoutDate === prev.checkoutDate && loan.createdAt >= prev.createdAt)
    ) {
      latestLoanBySerial.set(loan.serialNo, loan);
    }
  });

  // 按序列号归集仪器（正常情况下序列号全局唯一；出现多个安装位即挂起）
  const instrumentsBySerial = new Map<string, Instrument[]>();
  instruments.forEach((instrument) => {
    const list = instrumentsBySerial.get(instrument.serialNo) ?? [];
    list.push(instrument);
    instrumentsBySerial.set(instrument.serialNo, list);
  });

  const entries: SerialEntry[] = [];

  // 借调单有、台账没有的序列号：直接挂起
  latestLoanBySerial.forEach((loan, serialNo) => {
    if (!instrumentsBySerial.has(serialNo)) {
      entries.push(buildMissingInstrumentEntry(loan));
    }
  });

  instrumentsBySerial.forEach((sameSerial, serialNo) => {
    const loan = latestLoanBySerial.get(serialNo) ?? null;
    const latest = sameSerial
      .slice()
      .sort((a, b) => b.installDate.localeCompare(a.installDate) || b.updatedAt - a.updatedAt)[0];
    const ledgerArrayId = arrayOfStation(latest.stationId); // 台账安装位所在台阵

    const suspendReasons: SuspendReason[] = [];
    if (sameSerial.length > 1) suspendReasons.push('duplicate-install');

    let custody: SerialCustody | null = null;

    if (loan && isOpenLoan(loan.state)) {
      if (loan.state === '在借') {
        // 出库即已从原台阵出账；接收台阵在借调单上登记安装位后计入借入台阵（借调单为准）。
        // 借调单已带借入台阵的安装位，即视为接收台阵已登记；原台阵台账残留旧安装位属正常出账，不挂起。
        const installArrayId = loan.installStationId ? arrayOfStation(loan.installStationId) : undefined;
        const registeredAtBorrower =
          !!loan.installStationId && installArrayId === loan.borrowerArrayId;
        custody = {
          kind: 'array',
          arrayId: loan.borrowerArrayId,
          stationId: loan.installStationId ?? latest.stationId,
          onLoan: true,
        };
        if (!registeredAtBorrower) {
          // 单已在借却没有登记到借入台阵的安装位：安装位待核，挂起这一台
          suspendReasons.push('install-without-slip');
        }
      } else {
        // 在途：出库即出账，接收台阵尚未登记安装位 → 不属于任何台阵
        custody = { kind: 'in-transit', arrayId: loan.lenderArrayId };
      }
    } else if (loan && loan.state === '已归还') {
      // 归还后回到原台阵在账
      custody = { kind: 'array', arrayId: loan.lenderArrayId, stationId: latest.stationId, onLoan: false };
      if (ledgerArrayId && ledgerArrayId !== loan.lenderArrayId) {
        suspendReasons.push('install-without-slip');
      }
    } else if (ledgerArrayId) {
      // 无借调单：以台账安装位为在账归属
      custody = { kind: 'array', arrayId: ledgerArrayId, stationId: latest.stationId, onLoan: false };
    }

    const latestCalibration = latestCalibrationOf(calibrations, latest.id);
    const dueInDays = daysUntilDue(latestCalibration ? latestCalibration.date : null, latest.installDate);
    const physicallyOverdue = dueInDays < 0;
    const overdueSuspended = !!loan && isOpenLoan(loan.state);
    const suspended = suspendReasons.length > 0;
    const overdue = physicallyOverdue && !overdueSuspended && !suspended;

    entries.push({
      serialNo,
      instrument: latest,
      loan,
      custody,
      suspended,
      suspendReasons,
      latestCalibration,
      dueInDays,
      physicallyOverdue,
      overdueSuspended,
      overdue,
      onSchedule: custody?.kind === 'array' && !overdue && !suspended,
    });
  });

  return aggregate(entries, arrays);
}

function emptyStat(arrayId: string): ArrayLedgerStat {
  return {
    arrayId,
    accountCount: 0,
    borrowedInCount: 0,
    lentOutCount: 0,
    inTransitCount: 0,
    ratedCount: 0,
    onScheduleCount: 0,
    overdueCount: 0,
    suspendedCount: 0,
    onScheduleRate: 0,
  };
}

function aggregate(entries: SerialEntry[], arrays: SeisArray[]): ReconcileResult {
  const bySerial = new Map(entries.map((entry) => [entry.serialNo, entry]));
  const arrayStats = new Map<string, ArrayLedgerStat>(
    arrays.map((array) => [array.id, emptyStat(array.id)])
  );

  const statOf = (arrayId: string): ArrayLedgerStat => {
    let stat = arrayStats.get(arrayId);
    if (!stat) {
      // 借调单引用的台阵已被删除等兜底情形
      stat = emptyStat(arrayId);
      arrayStats.set(arrayId, stat);
    }
    return stat;
  };

  entries.forEach((entry) => {
    // 挂起的这一台只计挂起，不计借出 / 在途 / 在账 / 按期 / 超期（只退这一台）
    if (entry.suspended) {
      const owner =
        entry.custody?.kind === 'array'
          ? entry.custody.arrayId
          : entry.custody?.kind === 'in-transit'
            ? entry.custody.arrayId
            : entry.loan?.lenderArrayId;
      if (owner) statOf(owner).suspendedCount += 1;
      return;
    }

    if (entry.loan && isOpenLoan(entry.loan.state)) {
      statOf(entry.loan.lenderArrayId).lentOutCount += 1;
    }

    if (!entry.custody) return;

    if (entry.custody.kind === 'in-transit') {
      statOf(entry.custody.arrayId).inTransitCount += 1;
      return; // 在途：两边都不在账
    }

    const stat = statOf(entry.custody.arrayId);
    stat.accountCount += 1;
    if (entry.custody.onLoan) stat.borrowedInCount += 1;
    stat.ratedCount += 1;
    if (entry.overdue) stat.overdueCount += 1;
    else stat.onScheduleCount += 1;
  });

  arrayStats.forEach((stat) => {
    stat.onScheduleRate =
      stat.ratedCount === 0 ? 0 : Number(((stat.onScheduleCount / stat.ratedCount) * 100).toFixed(1));
  });

  return {
    entries,
    bySerial,
    arrayStats,
    suspended: entries.filter((entry) => entry.suspended),
    inTransit: entries.filter((entry) => entry.custody?.kind === 'in-transit'),
    overdueEntries: entries.filter((entry) => entry.overdue),
  };
}
