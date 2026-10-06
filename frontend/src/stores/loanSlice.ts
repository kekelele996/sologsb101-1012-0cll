/**
 * 周转库 slice：维护借调单列表与筛选条件。
 * 周转库只管借调单的出库 / 在途 / 归还；仪器安装位仍归台阵台账（instruments 表），
 * 两边在同一事务里联动，保证「一台序列号同一时间只算一个台阵在用」。
 * 统一口径：出库即出账；借调单没归还前不进超期（见 types/loan.ts）。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type { Loan, LoanFilterState, LoanState } from '@/types/loan';
import { canTransitionLoan, createEmptyLoanFilter, isOnBookState } from '@/types/loan';
import type { InstrumentState } from '@/types/instrument';
import type { RootState } from '@/stores/store';

/** 选择器入参统一用 RootState */
type WithLoan = RootState;

export interface LoanSliceState {
  loans: Loan[];
  ready: boolean;
  error: string | null;
  filter: LoanFilterState;
  /** 最近一次操作回执（用于页面提示） */
  lastReceipt: string;
}

const initialState: LoanSliceState = {
  loans: [],
  ready: false,
  error: null,
  filter: createEmptyLoanFilter(),
  lastReceipt: '',
};

/** 仪器当前是否有未归还借调单（在途 / 已接收 / 已挂起） */
async function findOpenLoan(instrumentId: string, serialNo: string): Promise<Loan | undefined> {
  const rows = await db.loans
    .where('instrumentId')
    .equals(instrumentId)
    .or('serialNo')
    .equals(serialNo)
    .toArray();
  return rows.find((row) => row.state !== '已归还');
}

/**
 * 登记借调（出库）：出库即出账——借调单落库的同时仪器置「借出在途」，
 * 从借出台阵在账台数与按期标定率分母中扣除，不等接收台阵登安装位。
 */
export const createLoan = createAsyncThunk(
  'loan/createLoan',
  async (
    payload: { instrumentId: string; toArrayId: string; outDate: string; operator: string; remark: string; code: string },
    { rejectWithValue }
  ) => {
    const instrument = await db.instruments.get(payload.instrumentId);
    if (!instrument) return rejectWithValue('仪器档案不存在，无法登记借调');
    if (!isOnBookState(instrument.state)) {
      return rejectWithValue(`仪器当前状态为「${instrument.state}」，不在账上，不能重复出库`);
    }
    const open = await findOpenLoan(instrument.id, instrument.serialNo);
    if (open) {
      return rejectWithValue(`序列号「${instrument.serialNo}」已有未归还借调单 ${open.code}，一台序列号同一时间只算一个台阵在用`);
    }
    const station = await db.stations.get(instrument.stationId);
    if (!station) return rejectWithValue('仪器安装位（台站）不存在，请先完善台账');
    if (station.arrayId === payload.toArrayId) {
      return rejectWithValue('接收台阵不能与借出台阵相同');
    }
    const now = Date.now();
    const row: Loan = {
      id: createId('loan'),
      code: payload.code.trim(),
      serialNo: instrument.serialNo,
      instrumentId: instrument.id,
      fromArrayId: station.arrayId,
      fromStationId: station.id,
      toArrayId: payload.toArrayId,
      toStationId: null,
      outDate: payload.outDate,
      receiveDate: null,
      returnDate: null,
      state: '在途',
      holdFromState: null,
      holdReason: '',
      operator: payload.operator.trim(),
      remark: payload.remark.trim(),
      createdAt: now,
      updatedAt: now,
    };
    await db.transaction('rw', [db.loans, db.instruments], async () => {
      await db.loans.put(row);
      await db.instruments.update(instrument.id, { state: '借出在途', updatedAt: now } as never);
    });
    return row;
  }
);

/** 接收登位：接收台阵登好安装位，仪器迁入接收台站并计入接收台阵在账 */
export const receiveLoan = createAsyncThunk(
  'loan/receiveLoan',
  async (payload: { id: string; toStationId: string; receiveDate: string }, { rejectWithValue }) => {
    const loan = await db.loans.get(payload.id);
    if (!loan) return rejectWithValue('借调单不存在');
    if (!canTransitionLoan(loan.state, '已接收')) {
      return rejectWithValue(`状态机不允许从「${loan.state}」流转到「已接收」`);
    }
    const station = await db.stations.get(payload.toStationId);
    if (!station) return rejectWithValue('接收台站不存在');
    if (station.arrayId !== loan.toArrayId) return rejectWithValue('所选台站不属于借调单的接收台阵');
    const now = Date.now();
    await db.transaction('rw', [db.loans, db.instruments], async () => {
      await db.loans.update(payload.id, {
        state: '已接收',
        toStationId: payload.toStationId,
        receiveDate: payload.receiveDate,
        updatedAt: now,
      } as never);
      if (loan.instrumentId) {
        await db.instruments.update(loan.instrumentId, {
          stationId: payload.toStationId,
          installDate: payload.receiveDate,
          state: '在用',
          updatedAt: now,
        } as never);
      }
    });
    return { id: payload.id, next: '已接收' as LoanState };
  }
);

/** 归还：借调闭环，仪器迁回原安装位并恢复在账；归还后重新进入超期考核 */
export const returnLoan = createAsyncThunk(
  'loan/returnLoan',
  async (payload: { id: string; returnDate: string }, { rejectWithValue }) => {
    const loan = await db.loans.get(payload.id);
    if (!loan) return rejectWithValue('借调单不存在');
    if (!canTransitionLoan(loan.state, '已归还')) {
      return rejectWithValue(`状态机不允许从「${loan.state}」流转到「已归还」`);
    }
    const now = Date.now();
    await db.transaction('rw', [db.loans, db.instruments], async () => {
      await db.loans.update(payload.id, {
        state: '已归还',
        returnDate: payload.returnDate,
        updatedAt: now,
      } as never);
      if (loan.instrumentId) {
        await db.instruments.update(loan.instrumentId, {
          stationId: loan.fromStationId,
          state: '在用',
          updatedAt: now,
        } as never);
      }
    });
    return { id: payload.id, next: '已归还' as LoanState };
  }
);

/** 挂起这一台：对账对不上先挂起，退出在账与超期考核，只影响当前序列号 */
export const holdLoan = createAsyncThunk(
  'loan/holdLoan',
  async (payload: { id: string; reason: string }, { rejectWithValue }) => {
    const loan = await db.loans.get(payload.id);
    if (!loan) return rejectWithValue('借调单不存在');
    if (!canTransitionLoan(loan.state, '已挂起')) {
      return rejectWithValue(`状态机不允许从「${loan.state}」流转到「已挂起」`);
    }
    const now = Date.now();
    await db.transaction('rw', [db.loans, db.instruments], async () => {
      await db.loans.update(payload.id, {
        state: '已挂起',
        holdFromState: loan.state,
        holdReason: payload.reason.trim(),
        updatedAt: now,
      } as never);
      if (loan.instrumentId) {
        await db.instruments.update(loan.instrumentId, { state: '对账挂起', updatedAt: now } as never);
      }
    });
    return { id: payload.id, next: '已挂起' as LoanState };
  }
);

/** 解除挂起：恢复到挂起前状态（在途 → 借出在途；已接收 → 在用） */
export const unholdLoan = createAsyncThunk(
  'loan/unholdLoan',
  async (payload: { id: string }, { rejectWithValue }) => {
    const loan = await db.loans.get(payload.id);
    if (!loan) return rejectWithValue('借调单不存在');
    if (loan.state !== '已挂起') return rejectWithValue('借调单不在挂起状态');
    const restored: LoanState = loan.holdFromState ?? '在途';
    const instrumentState: InstrumentState = restored === '已接收' ? '在用' : '借出在途';
    const now = Date.now();
    await db.transaction('rw', [db.loans, db.instruments], async () => {
      await db.loans.update(payload.id, {
        state: restored,
        holdFromState: null,
        updatedAt: now,
      } as never);
      if (loan.instrumentId) {
        await db.instruments.update(loan.instrumentId, { state: instrumentState, updatedAt: now } as never);
      }
    });
    return { id: payload.id, next: restored };
  }
);

/**
 * 退回这一台：对账挂起后的单台处置——仪器退回原安装位、借调单按归还闭环。
 * 只作用于当前序列号，不牵连其他借调单与仪器。
 */
export const rejectLoanInstrument = createAsyncThunk(
  'loan/rejectLoanInstrument',
  async (payload: { id: string; returnDate: string }, { rejectWithValue }) => {
    const loan = await db.loans.get(payload.id);
    if (!loan) return rejectWithValue('借调单不存在');
    if (loan.state !== '已挂起') return rejectWithValue('只有已挂起的借调单才能退回');
    const now = Date.now();
    await db.transaction('rw', [db.loans, db.instruments], async () => {
      await db.loans.update(payload.id, {
        state: '已归还',
        returnDate: payload.returnDate,
        holdReason: loan.holdReason ? `${loan.holdReason}；对账退回原台阵` : '对账退回原台阵',
        updatedAt: now,
      } as never);
      if (loan.instrumentId) {
        await db.instruments.update(loan.instrumentId, {
          stationId: loan.fromStationId,
          state: '在用',
          updatedAt: now,
        } as never);
      }
    });
    return { id: payload.id, next: '已归还' as LoanState };
  }
);

/** 无单挂起：台账标记借出在途但周转库无单时，只挂起这台仪器 */
export const holdInstrument = createAsyncThunk(
  'loan/holdInstrument',
  async (instrumentId: string) => {
    await db.instruments.update(instrumentId, { state: '对账挂起', updatedAt: Date.now() } as never);
    return instrumentId;
  }
);

/** 无单解除挂起：人工确认后恢复在用 */
export const unholdInstrument = createAsyncThunk(
  'loan/unholdInstrument',
  async (instrumentId: string) => {
    await db.instruments.update(instrumentId, { state: '在用', updatedAt: Date.now() } as never);
    return instrumentId;
  }
);

/** 删除借调单：仅已归还可删（未归还的单据必须走归还 / 退回流程闭环） */
export const removeLoan = createAsyncThunk(
  'loan/removeLoan',
  async (id: string, { rejectWithValue }) => {
    const loan = await db.loans.get(id);
    if (!loan) return rejectWithValue('借调单不存在');
    if (loan.state !== '已归还') return rejectWithValue('未归还的借调单不能删除，请先归还或退回');
    await db.loans.delete(id);
    return id;
  }
);

const loanSlice = createSlice({
  name: 'loan',
  initialState,
  reducers: {
    setLoans(state, action: PayloadAction<Loan[]>) {
      state.loans = action.payload;
      state.ready = true;
      state.error = null;
    },
    patchLoanFilter(state, action: PayloadAction<Partial<LoanFilterState>>) {
      state.filter = { ...state.filter, ...action.payload };
    },
    resetLoanFilter(state) {
      state.filter = createEmptyLoanFilter();
    },
    setLoanError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createLoan.fulfilled, (state, action) => {
        state.lastReceipt = `借调单 ${action.payload.code} 已登记出库：序列号 ${action.payload.serialNo} 即从借出台阵出账，在途期间不进超期`;
        state.error = null;
      })
      .addCase(createLoan.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '借调登记失败';
      })
      .addCase(receiveLoan.fulfilled, (state) => {
        state.lastReceipt = '接收台阵已登安装位：仪器计入接收台阵在账，借调单未归还前仍不进超期';
        state.error = null;
      })
      .addCase(receiveLoan.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '接收登位失败';
      })
      .addCase(returnLoan.fulfilled, (state) => {
        state.lastReceipt = '借调单已归还：仪器迁回原安装位并恢复在账，重新进入超期考核';
        state.error = null;
      })
      .addCase(returnLoan.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '归还登记失败';
      })
      .addCase(holdLoan.fulfilled, (state) => {
        state.lastReceipt = '已挂起这一台：退出在账与超期考核，待人工处置';
        state.error = null;
      })
      .addCase(holdLoan.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '挂起失败';
      })
      .addCase(unholdLoan.fulfilled, (state, action) => {
        state.lastReceipt = `已解除挂起，借调单恢复到「${action.payload.next}」`;
        state.error = null;
      })
      .addCase(unholdLoan.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '解除挂起失败';
      })
      .addCase(rejectLoanInstrument.fulfilled, (state) => {
        state.lastReceipt = '已退回这一台：仪器回到原安装位，借调单按归还闭环';
        state.error = null;
      })
      .addCase(rejectLoanInstrument.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '退回失败';
      })
      .addCase(removeLoan.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '删除借调单失败';
      });
  },
});

export const { setLoans, patchLoanFilter, resetLoanFilter, setLoanError } = loanSlice.actions;

let started = false;

/** 启动借调单表实时订阅（幂等） */
export function startLoanSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Loan>(() => db.loans).subscribe((rows) => {
    dispatch(setLoans(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectLoanState = (state: WithLoan): LoanSliceState => state.loan;
export const selectLoans = (state: WithLoan): Loan[] => state.loan.loans;
export const selectLoanReady = (state: WithLoan): boolean => state.loan.ready;
export const selectLoanFilter = (state: WithLoan): LoanFilterState => state.loan.filter;
export const selectLoanReceipt = (state: WithLoan): string => state.loan.lastReceipt;
export const selectLoanError = (state: WithLoan): string | null => state.loan.error;

/** 未归还（在途 / 已接收 / 已挂起）的借调单 */
export const selectOpenLoans = (state: WithLoan): Loan[] =>
  state.loan.loans.filter((row) => row.state !== '已归还');

export default loanSlice.reducer;
