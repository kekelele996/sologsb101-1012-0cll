/**
 * 仪器周转库 · 借调单模型与对账口径
 *
 * 职责划分：周转库（本文件 + loans 表）只管借调单的出库 / 在途 / 归还；
 * 台阵台账（instruments / calibrations）只管安装位、标定记录与超期名单。
 * 两边按序列号对账，对不上的单台挂起、单台退回，不牵连其他仪器。
 *
 * 统一口径（在账台数与按期标定率共用同一条）：
 * - 出库即出账：登记借调单（出库）那一刻仪器即从借出台阵在账扣除，
 *   不等接收台阵登安装位；在途期间挂在周转库账上，不算任何台阵在用。
 * - 一台序列号同一时间只算一个台阵在用：借出在途 / 对账挂起不占任何台阵账。
 * - 借调单没归还前不进超期：未归还（在途 / 已接收 / 已挂起）借调单覆盖的
 *   仪器不进超期名单，也不进按期标定率的超期分子。
 */
import type { Instrument, InstrumentState } from '@/types/instrument';

/** 借调单状态机：在途 → 已接收 → 已归还；在途可直接归还；对账异常挂起后可恢复或退回 */
export type LoanState = '在途' | '已接收' | '已归还' | '已挂起';

export const LOAN_STATES: LoanState[] = ['在途', '已接收', '已归还', '已挂起'];

/** 状态流转允许的下一步 */
export const LOAN_TRANSITIONS: Record<LoanState, LoanState[]> = {
  在途: ['已接收', '已归还', '已挂起'],
  已接收: ['已归还', '已挂起'],
  已挂起: ['在途', '已接收', '已归还'],
  已归还: [],
};

export function canTransitionLoan(from: LoanState, to: LoanState): boolean {
  return (LOAN_TRANSITIONS[from] ?? []).includes(to);
}

/** 借调单：一台序列号一张单，出库 / 接收登位 / 归还全程留痕 */
export interface Loan {
  id: string;
  /** 借调单号（业务编号，如 JD-20261006-01） */
  code: string;
  /** 对账键：仪器序列号 */
  serialNo: string;
  /** 关联仪器档案 id（台账查无此序列号时为 null，等待对账处置） */
  instrumentId: string | null;
  /** 借出台阵 */
  fromArrayId: string;
  /** 原安装位（借出台站），归还时迁回 */
  fromStationId: string;
  /** 接收台阵 */
  toArrayId: string;
  /** 接收安装位（接收登位后回填） */
  toStationId: string | null;
  /** 出库日期：登记借调单即出库，出库即出账 */
  outDate: string;
  /** 接收登位日期（接收台阵登好安装位的日期） */
  receiveDate: string | null;
  /** 归还日期 */
  returnDate: string | null;
  /** 状态 */
  state: LoanState;
  /** 挂起前状态（解除挂起时恢复） */
  holdFromState: LoanState | null;
  /** 挂起 / 退回原因（对账处置留痕） */
  holdReason: string;
  /** 经办人 */
  operator: string;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 周转库页筛选条件（存于 loanSlice） */
export interface LoanFilterState {
  keyword: string;
  states: LoanState[];
}

export function createEmptyLoanFilter(): LoanFilterState {
  return { keyword: '', states: [] };
}

/* ------------------------------ 统一口径 ------------------------------ */

/** 由借调 / 对账驱动的仪器状态：不计入任何台阵在账（出库即出账） */
export const OFF_BOOK_STATES: InstrumentState[] = ['借出在途', '对账挂起'];

/** 在账口径：借出在途与对账挂起不占任何台阵账，其余状态按 stationId 归属台阵 */
export function isOnBookState(state: InstrumentState): boolean {
  return !OFF_BOOK_STATES.includes(state);
}

/** 未归还借调单覆盖的仪器 id 集合：借调单没归还前不进超期名单 */
export function loanCoveredInstrumentIds(loans: Loan[]): Set<string> {
  const ids = new Set<string>();
  loans.forEach((loan) => {
    if (loan.state !== '已归还' && loan.instrumentId) ids.add(loan.instrumentId);
  });
  return ids;
}

/* ------------------------------ 按序列号对账 ------------------------------ */

/** 对账异常：一台序列号一条，挂起与退回都只作用于这一台 */
export interface ReconcileIssue {
  key: string;
  serialNo: string;
  /** 台账侧仪器（查无档案时为 null） */
  instrumentId: string | null;
  /** 周转库侧借调单（无单时为 null） */
  loanId: string | null;
  reason: string;
}

/**
 * 周转库 vs 台阵台账按序列号对账。
 * 已挂起的借调单 / 仪器不参与核对（已在处置中），其余逐台核对：
 * 1. 周转库有未归还单，台账查无此序列号或有重复档案；
 * 2. 借调单在途，但台账未做出库（状态不对）或安装位已离开借出台站；
 * 3. 借调单已接收，但安装位不在接收台站或台账仍挂借出在途；
 * 4. 台账标记借出在途，但周转库没有未归还借调单；
 * 5. 同一序列号在台账中有多台档案（两头在账）。
 */
export function reconcileLedger(loans: Loan[], instruments: Instrument[]): ReconcileIssue[] {
  const issues: ReconcileIssue[] = [];
  const bySerial = new Map<string, Instrument[]>();
  instruments.forEach((instrument) => {
    const list = bySerial.get(instrument.serialNo) ?? [];
    list.push(instrument);
    bySerial.set(instrument.serialNo, list);
  });

  const openLoans = loans.filter((loan) => loan.state !== '已归还');
  const activeLoans = openLoans.filter((loan) => loan.state !== '已挂起');
  const serialsWithOpenLoan = new Set(openLoans.map((loan) => loan.serialNo));

  activeLoans.forEach((loan) => {
    const matches = bySerial.get(loan.serialNo) ?? [];
    const base = { serialNo: loan.serialNo, loanId: loan.id };
    if (matches.length === 0) {
      issues.push({ ...base, key: `${loan.id}:missing`, instrumentId: null, reason: '周转库有未归还借调单，台阵台账查无此序列号' });
      return;
    }
    if (matches.length > 1) {
      issues.push({ ...base, key: `${loan.id}:dup`, instrumentId: matches[0].id, reason: `同一序列号在台账中有 ${matches.length} 台档案，两头在账` });
      return;
    }
    const instrument = matches[0];
    if (loan.state === '在途') {
      if (instrument.state !== '借出在途') {
        issues.push({ ...base, key: `${loan.id}:state`, instrumentId: instrument.id, reason: `借调单在途（已出库），但台账状态为「${instrument.state}」，未做出库` });
      } else if (instrument.stationId !== loan.fromStationId) {
        issues.push({ ...base, key: `${loan.id}:site`, instrumentId: instrument.id, reason: '借调单在途，但安装位已离开借出台站（接收方未按单登位）' });
      }
    }
    if (loan.state === '已接收') {
      if (instrument.stationId !== loan.toStationId) {
        issues.push({ ...base, key: `${loan.id}:recv`, instrumentId: instrument.id, reason: '借调单已接收，但安装位不在接收台站' });
      } else if (instrument.state === '借出在途') {
        issues.push({ ...base, key: `${loan.id}:recvstate`, instrumentId: instrument.id, reason: '借调单已接收登位，但台账仍挂「借出在途」' });
      }
    }
  });

  instruments.forEach((instrument) => {
    if (instrument.state !== '借出在途') return;
    const hasOpenLoan = openLoans.some(
      (loan) => loan.instrumentId === instrument.id || loan.serialNo === instrument.serialNo
    );
    if (!hasOpenLoan) {
      issues.push({
        key: `${instrument.id}:noloan`,
        serialNo: instrument.serialNo,
        instrumentId: instrument.id,
        loanId: null,
        reason: '台账标记「借出在途」，但周转库没有未归还借调单',
      });
    }
  });

  bySerial.forEach((list, serialNo) => {
    if (list.length > 1 && !serialsWithOpenLoan.has(serialNo)) {
      issues.push({
        key: `${serialNo}:dup`,
        serialNo,
        instrumentId: list[0].id,
        loanId: null,
        reason: `同一序列号在台账中有 ${list.length} 台档案，两头在账`,
      });
    }
  });

  return issues;
}
