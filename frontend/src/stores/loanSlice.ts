/**
 * 借调（周转库）slice：维护借调单列表与草稿。
 * 周转库只管「出库 → 在途 → 在借 → 归还」，按序列号记；
 * 安装位、标定与超期由台阵台账侧依据统一对账口径（utils/reconcile.ts）派生。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type { LoanSlip, LoanDraft, LoanState } from '@/types/loan';
import { canTransitionLoan, createEmptyLoanDraft, isOpenLoan } from '@/types/loan';
import type { RootState } from '@/stores/store';

type WithLoan = RootState;

export interface LoanSliceState {
  loans: LoanSlip[];
  ready: boolean;
  error: string | null;
  draft: LoanDraft;
  lastReceipt: string;
}

const initialState: LoanSliceState = {
  loans: [],
  ready: false,
  error: null,
  draft: createEmptyLoanDraft(),
  lastReceipt: '',
};

/** 同一序列号是否已有未归还借调单（一个序列号同一时间只能在一张未结单上） */
export async function findOpenLoanBySerial(
  serialNo: string,
  excludeId?: string
): Promise<LoanSlip | undefined> {
  const rows = await db.loans.where('serialNo').equals(serialNo).toArray();
  return rows.find((row) => row.id !== excludeId && isOpenLoan(row.state));
}

/** 出库登记：借调单一经保存即「出库」，仪器立刻从借出方台阵出账 */
export const checkoutLoan = createAsyncThunk(
  'loan/checkoutLoan',
  async (payload: Omit<LoanSlip, 'id' | 'createdAt' | 'updatedAt' | 'state' | 'installDate' | 'installStationId' | 'returnDate'>,
    { rejectWithValue }
  ) => {
    const conflict = await findOpenLoanBySerial(payload.serialNo);
    if (conflict) {
      return rejectWithValue(
        `序列号「${payload.serialNo}」已有未归还借调单（${conflict.state}），不能重复出库`
      );
    }
    if (payload.lenderArrayId === payload.borrowerArrayId) {
      return rejectWithValue('借出方与接收台阵不能是同一个台阵');
    }
    const now = Date.now();
    const row: LoanSlip = {
      ...payload,
      state: '在途',
      installDate: null,
      installStationId: null,
      returnDate: null,
      id: createId('loan'),
      createdAt: now,
      updatedAt: now,
    };
    await db.loans.put(row);
    return row;
  }
);

/**
 * 接收台阵登记安装位：在途 → 在借。
 * 登记那一刻仪器才计入接收台阵在账台数（与出库即出账为同一条口径的两端）。
 */
export const registerLoanInstall = createAsyncThunk(
  'loan/registerLoanInstall',
  async (payload: { id: string; installStationId: string; installDate: string },
    { rejectWithValue }
  ) => {
    const loan = await db.loans.get(payload.id);
    if (!loan) return rejectWithValue('借调单不存在');
    if (!canTransitionLoan(loan.state, '在借')) {
      return rejectWithValue(`借调单当前为「${loan.state}」，不能登记安装位`);
    }
    const now = Date.now();
    await db.loans.update(payload.id, {
      state: '在借',
      installStationId: payload.installStationId,
      installDate: payload.installDate,
      updatedAt: now,
    } as never);
    return { ...payload, state: '在借' as LoanState };
  }
);

/** 推进借调单状态（在途→在借/已归还，在借→已归还） */
export const transitionLoan = createAsyncThunk(
  'loan/transitionLoan',
  async (payload: { id: string; next: LoanState; returnDate?: string },
    { rejectWithValue }
  ) => {
    const loan = await db.loans.get(payload.id);
    if (!loan) return rejectWithValue('借调单不存在');
    if (!canTransitionLoan(loan.state, payload.next)) {
      return rejectWithValue(`不允许从「${loan.state}」流转到「${payload.next}」`);
    }
    const now = Date.now();
    const patch: Partial<LoanSlip> = { state: payload.next, updatedAt: now };
    if (payload.next === '已归还') {
      patch.returnDate = payload.returnDate ?? new Date(now).toISOString().slice(0, 10);
    }
    await db.loans.update(payload.id, patch as never);
    return payload;
  }
);

export const updateLoan = createAsyncThunk(
  'loan/updateLoan',
  async (payload: { id: string; patch: Partial<LoanSlip> }, { rejectWithValue }) => {
    if (payload.patch.serialNo) {
      const conflict = await findOpenLoanBySerial(payload.patch.serialNo, payload.id);
      if (conflict) return rejectWithValue('该序列号已有未归还借调单');
    }
    await db.loans.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

export const removeLoan = createAsyncThunk('loan/removeLoan', async (id: string) => {
  await db.loans.delete(id);
  return id;
});

const loanSlice = createSlice({
  name: 'loan',
  initialState,
  reducers: {
    setLoans(state, action: PayloadAction<LoanSlip[]>) {
      state.loans = action.payload;
      state.ready = true;
      state.error = null;
    },
    setLoanError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    patchDraft(state, action: PayloadAction<Partial<LoanDraft>>) {
      state.draft = { ...state.draft, ...action.payload };
    },
    resetDraft(state) {
      state.draft = createEmptyLoanDraft();
    },
    setReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(checkoutLoan.fulfilled, (state, action) => {
        state.lastReceipt = `借调单已出库：${action.payload.serialNo} 已从原台阵出账，在途期间两边均不在账`;
        state.error = null;
      })
      .addCase(checkoutLoan.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '出库登记失败';
      })
      .addCase(registerLoanInstall.fulfilled, (state, action) => {
        state.lastReceipt = `接收台阵已登记安装位，借调单 ${action.payload.id} 转为在借，计入接收台阵在账台数`;
      })
      .addCase(transitionLoan.fulfilled, (state, action) => {
        state.lastReceipt =
          action.payload.next === '已归还'
            ? '借调仪器已归还，重新计入原台阵在账台数'
            : `借调单已流转到「${action.payload.next}」`;
      })
      .addCase(transitionLoan.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '借调单流转失败';
      });
  },
});

export const { setLoans, setLoanError, patchDraft, resetDraft, setReceipt } = loanSlice.actions;

let started = false;

/** 启动借调单表实时订阅（幂等） */
export function startLoanSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<LoanSlip>(() => db.loans).subscribe((rows) => {
    dispatch(setLoans(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectLoanState = (state: WithLoan): LoanSliceState => state.loan;
export const selectLoans = (state: WithLoan): LoanSlip[] => state.loan.loans;
export const selectLoanReady = (state: WithLoan): boolean => state.loan.ready;
export const selectLoanDraft = (state: WithLoan): LoanDraft => state.loan.draft;
export const selectLoanReceipt = (state: WithLoan): string => state.loan.lastReceipt;

/** 未归还借调单（在途 + 在借） */
export const selectOpenLoans = (state: WithLoan): LoanSlip[] =>
  state.loan.loans.filter((loan) => isOpenLoan(loan.state));

export default loanSlice.reducer;
