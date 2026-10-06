/** 仪器类型 */
export type InstrumentType = '宽频带' | '短周期' | '强震';

export const INSTRUMENT_TYPES: InstrumentType[] = ['宽频带', '短周期', '强震'];

/**
 * 仪器状态。
 * 「借出在途」「对账挂起」由周转库借调单与对账处置驱动，不开放手工登记；
 * 这两种状态不计入任何台阵在账（出库即出账，见 types/loan.ts 统一口径）。
 */
export type InstrumentState = '在用' | '待标定' | '已停用' | '借出在途' | '对账挂起';

/** 登记表单可选的状态（驱动型状态不在其列） */
export const INSTRUMENT_STATES: InstrumentState[] = ['在用', '待标定', '已停用'];

/** 状态标签颜色（Ant Design Tag color），各页面统一渲染 */
export const INSTRUMENT_STATE_COLORS: Record<InstrumentState, string> = {
  在用: 'green',
  待标定: 'orange',
  已停用: 'default',
  借出在途: 'blue',
  对账挂起: 'red',
};

/** 标定周期（天）：超过该天数未标定即视为超期 */
export const CALIBRATION_CYCLE_DAYS = 365;

/** 仪器：安装于台站的观测设备 */
export interface Instrument {
  id: string;
  /** 所属台站 */
  stationId: string;
  /** 仪器类型 */
  type: InstrumentType;
  /** 型号 */
  model: string;
  /** 序列号（全局唯一） */
  serialNo: string;
  /** 安装日期 */
  installDate: string;
  /** 状态 */
  state: InstrumentState;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 仪器登记草稿（存于 instrumentSlice） */
export interface InstrumentDraft {
  stationId: string;
  type: InstrumentType;
  model: string;
  serialNo: string;
  installDate: string;
  state: InstrumentState;
  remark: string;
}

export function createEmptyInstrumentDraft(): InstrumentDraft {
  return {
    stationId: '',
    type: '宽频带',
    model: '',
    serialNo: '',
    installDate: new Date().toISOString().slice(0, 10),
    state: '在用',
    remark: ''
  };
}

/** 常用型号（表单联想用） */
export const COMMON_MODELS: Record<InstrumentType, string[]> = {
  宽频带: ['CMG-3ESPC', 'STS-2.5', 'Trillium-120', 'Trillium-Compact'],
  短周期: ['FSS-3B', 'L-4C-3D', 'CDJ-S2C'],
  强震: ['ES-T', 'CMG-5TDE', 'ETNA2', 'GL-P2B']
};

/**
 * 计算距下次标定的天数：正数表示剩余天数，负数表示已超期天数。
 * 以最近一次标定日期（无标定则用安装日期）为基准。
 */
export function daysUntilDue(lastCalibrationDate: string | null, installDate: string): number {
  const base = lastCalibrationDate ?? installDate;
  const baseTime = Date.parse(`${base}T00:00:00`);
  if (!Number.isFinite(baseTime)) return CALIBRATION_CYCLE_DAYS;
  const dueTime = baseTime + CALIBRATION_CYCLE_DAYS * 86400000;
  const diff = dueTime - Date.now();
  return Math.round(diff / 86400000);
}
