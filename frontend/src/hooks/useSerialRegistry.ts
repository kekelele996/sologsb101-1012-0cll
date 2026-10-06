/**
 * useSerialRegistry：周转库借调单与台阵台账按序列号对账的统一口径。
 * 在账台数、按期标定率、超期名单都从这里取，各页面不再各算各的。
 * 被台阵台账、台站仪器、合格评定、几何视图与仪器周转库消费。
 */
import { useMemo } from 'react';
import { useSelector } from 'react-redux';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import { selectCalibrations } from '@/stores/calibrationSlice';
import { selectLoans } from '@/stores/loanSlice';
import { buildSerialRegistry, type ReconcileResult } from '@/utils/reconcile';

export function useSerialRegistry(): ReconcileResult {
  const arrays = useSelector(selectArrays);
  const stations = useSelector(selectStations);
  const instruments = useSelector(selectInstruments);
  const calibrations = useSelector(selectCalibrations);
  const loans = useSelector(selectLoans);

  return useMemo(
    () => buildSerialRegistry({ arrays, stations, instruments, calibrations, loans }),
    [arrays, stations, instruments, calibrations, loans]
  );
}
