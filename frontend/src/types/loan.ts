/**
 * 借调单（仪器周转库）：台阵施工期互相借调流动观测仪器的流转凭证。
 * 周转库只凭借调单记「出库 → 在途 → （接收台阵登记安装位）在借 → 归还」，
 * 不记台阵的安装位与标定；台阵台账另行登记安装位、标定记录与超期名单。
 */

/** 借调单状态机：在途 → 在借 → 已归还（在途也可直接归还，即接收方未登安装位即退回） */
export type LoanState = '在途' | '在借' | '已归还';

export const LOAN_STATES: LoanState[] = ['在途', '在借', '已归还'];

/** 未归还（仍在周转中）的状态：在途 / 在借。借调单未归还前仪器不进任何台阵超期名单 */
export const OPEN_LOAN_STATES: LoanState[] = ['在途', '在借'];

/** 状态流转允许的下一步 */
export const LOAN_TRANSITIONS: Record<LoanState, LoanState[]> = {
  在途: ['在借', '已归还'],
  在借: ['已归还'],
  已归还: [],
};

/** 借调单：一台序列号一张单，同一序列号同一时间至多一张未归还借调单 */
export interface LoanSlip {
  id: string;
  /** 借调仪器序列号（对账主键） */
  serialNo: string;
  /** 借出方台阵（仪器原台阵 / 归属台阵） */
  lenderArrayId: string;
  /** 借入方台阵（接收台阵） */
  borrowerArrayId: string;
  /** 借调单状态 */
  state: LoanState;
  /** 出库日期：出库那一刻即从借出方台阵在账台数出账 */
  checkoutDate: string;
  /** 接收台阵登记安装位日期（在途转在借） */
  installDate: string | null;
  /** 接收台阵登记的安装台站 */
  installStationId: string | null;
  /** 归还日期：归还后仪器重新计入借出方台阵在账台数 */
  returnDate: string | null;
  /** 经办人 */
  operator: string;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 借调单草稿（出库登记用） */
export interface LoanDraft {
  serialNo: string;
  lenderArrayId: string;
  borrowerArrayId: string;
  checkoutDate: string;
  operator: string;
  remark: string;
}

export function createEmptyLoanDraft(): LoanDraft {
  return {
    serialNo: '',
    lenderArrayId: '',
    borrowerArrayId: '',
    checkoutDate: new Date().toISOString().slice(0, 10),
    operator: '',
    remark: '',
  };
}

/** 是否未归还（在途 / 在借） */
export function isOpenLoan(state: LoanState): boolean {
  return OPEN_LOAN_STATES.includes(state);
}

/** 是否允许状态流转 */
export function canTransitionLoan(from: LoanState, to: LoanState): boolean {
  return (LOAN_TRANSITIONS[from] ?? []).includes(to);
}
