/**
 * 模块 6：/loans 仪器周转库
 * 按借调单记出库 / 在途 / 归还；与台阵台账各管各的——台账管安装位、标定与超期名单，
 * 周转库管借调流转。两边按序列号对账，对不上的单台挂起、单台退回。
 * 统一口径：出库即出账；一台序列号同一时间只算一个台阵在用；借调单没归还前不进超期。
 * 复用 <StatBadge>、<FilterBar>、<EmptyPanel>。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  AuditOutlined,
  DeleteOutlined,
  ExportOutlined,
  ImportOutlined,
  PlusOutlined,
  RollbackOutlined,
  StopOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import FilterBar from '@/components/common/FilterBar';
import type { FilterModel } from '@/types/filter';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import {
  createLoan,
  holdInstrument,
  holdLoan,
  patchLoanFilter,
  receiveLoan,
  rejectLoanInstrument,
  removeLoan,
  resetLoanFilter,
  returnLoan,
  selectLoanError,
  selectLoanFilter,
  selectLoanReceipt,
  selectLoans,
  unholdInstrument,
  unholdLoan,
} from '@/stores/loanSlice';
import {
  LOAN_STATES,
  isOnBookState,
  loanCoveredInstrumentIds,
  reconcileLedger,
  type Loan,
  type LoanState,
  type ReconcileIssue,
} from '@/types/loan';
import type { Instrument } from '@/types/instrument';
import { initDatabase } from '@/utils/db';

interface LoanFormValues {
  instrumentId: string;
  toArrayId: string;
  code: string;
  outDate: dayjs.Dayjs | null;
  operator: string;
  remark: string;
}

interface ReceiveFormValues {
  toStationId: string;
  receiveDate: dayjs.Dayjs | null;
}

/** 借调单行：附带双方台阵名与仪器档案 */
interface LoanRow {
  loan: Loan;
  instrument: Instrument | null;
  fromArrayName: string;
  toArrayName: string;
  fromStationCode: string;
  toStationCode: string;
}

/** 挂起处置行：借调单挂起与无单挂起仪器统一展示 */
interface HeldRow {
  key: string;
  serialNo: string;
  source: string;
  reason: string;
  loan: Loan | null;
  instrumentId: string | null;
}

const LOAN_STATE_COLOR: Record<LoanState, string> = {
  在途: 'blue',
  已接收: 'gold',
  已归还: 'green',
  已挂起: 'red',
};

export default function LoanBoard() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const arrays = useAppSelector(selectArrays);
  const stations = useAppSelector(selectStations);
  const instruments = useAppSelector(selectInstruments);
  const loans = useAppSelector(selectLoans);
  const filter = useAppSelector(selectLoanFilter);
  const receipt = useAppSelector(selectLoanReceipt);
  const sliceError = useAppSelector(selectLoanError);

  const [loanModalOpen, setLoanModalOpen] = useState(false);
  const [receiveTarget, setReceiveTarget] = useState<Loan | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loanForm] = Form.useForm<LoanFormValues>();
  const [receiveForm] = Form.useForm<ReceiveFormValues>();

  useEffect(() => {
    if (arrays.length === 0) void initDatabase();
  }, [arrays.length]);

  /** 回执与错误只提示新产生的，避免从其他页面返回时重复弹出 */
  const lastReceiptRef = useRef(receipt);
  const lastErrorRef = useRef(sliceError);
  useEffect(() => {
    if (receipt && receipt !== lastReceiptRef.current) message.success(receipt);
    lastReceiptRef.current = receipt;
  }, [message, receipt]);

  useEffect(() => {
    if (sliceError && sliceError !== lastErrorRef.current) message.error(sliceError);
    lastErrorRef.current = sliceError;
  }, [message, sliceError]);

  const arrayNameOf = useMemo(() => {
    const map = new Map(arrays.map((row) => [row.id, row.name]));
    return (id: string): string => map.get(id) ?? '未知台阵';
  }, [arrays]);

  const stationCodeOf = useMemo(() => {
    const map = new Map(stations.map((row) => [row.id, row.code]));
    return (id: string | null): string => (id ? map.get(id) ?? '未知台站' : '—');
  }, [stations]);

  /** 周转库 vs 台阵台账按序列号对账（已挂起的不重复报，进入待处置清单） */
  const issues = useMemo<ReconcileIssue[]>(() => reconcileLedger(loans, instruments), [instruments, loans]);

  /** 挂起中的借调单与无单挂起仪器：对账处置区 */
  const heldLoans = useMemo(() => loans.filter((loan) => loan.state === '已挂起'), [loans]);
  const heldInstruments = useMemo(
    () =>
      instruments.filter(
        (instrument) =>
          instrument.state === '对账挂起' &&
          !heldLoans.some((loan) => loan.instrumentId === instrument.id)
      ),
    [heldLoans, instruments]
  );

  const heldRows = useMemo<HeldRow[]>(
    () => [
      ...heldLoans.map((loan) => ({
        key: loan.id,
        serialNo: loan.serialNo,
        source: `借调单 ${loan.code}`,
        reason: loan.holdReason || '人工挂起',
        loan,
        instrumentId: loan.instrumentId,
      })),
      ...heldInstruments.map((instrument) => ({
        key: instrument.id,
        serialNo: instrument.serialNo,
        source: '台阵台账（无借调单）',
        reason: '台账挂起，周转库无对应借调单',
        loan: null,
        instrumentId: instrument.id,
      })),
    ],
    [heldInstruments, heldLoans]
  );

  const rows = useMemo<LoanRow[]>(() => {
    const keyword = filter.keyword.trim();
    return loans
      .map((loan) => {
        const instrument = instruments.find((row) => row.id === loan.instrumentId) ?? null;
        return {
          loan,
          instrument,
          fromArrayName: arrayNameOf(loan.fromArrayId),
          toArrayName: arrayNameOf(loan.toArrayId),
          fromStationCode: stationCodeOf(loan.fromStationId),
          toStationCode: stationCodeOf(loan.toStationId),
        };
      })
      .filter((row) => {
        if (filter.states.length > 0 && !filter.states.includes(row.loan.state)) return false;
        if (keyword.length > 0) {
          const haystack = `${row.loan.code}${row.loan.serialNo}${row.loan.operator}${row.fromArrayName}${row.toArrayName}${row.instrument?.model ?? ''}`;
          if (!haystack.includes(keyword)) return false;
        }
        return true;
      })
      .sort((a, b) => b.loan.outDate.localeCompare(a.loan.outDate));
  }, [arrayNameOf, filter.keyword, filter.states, instruments, loans, stationCodeOf]);

  const totals = useMemo(() => {
    const countOf = (state: LoanState): number => loans.filter((loan) => loan.state === state).length;
    return {
      transit: countOf('在途'),
      received: countOf('已接收'),
      returned: countOf('已归还'),
      held: countOf('已挂起'),
      issues: issues.length,
    };
  }, [issues.length, loans]);

  /** 可借出的仪器：在账（非借出 / 非挂起）且无未归还借调单 */
  const loanableInstruments = useMemo(() => {
    const covered = loanCoveredInstrumentIds(loans);
    return instruments.filter(
      (instrument) => isOnBookState(instrument.state) && !covered.has(instrument.id)
    );
  }, [instruments, loans]);

  const filterModel: FilterModel = { keyword: filter.keyword, states: filter.states };

  const handleFilterChange = (next: FilterModel) => {
    dispatch(
      patchLoanFilter({
        keyword: next.keyword,
        states: ((next.states as string[]) ?? []) as LoanState[],
      })
    );
  };

  const openCreate = () => {
    loanForm.setFieldsValue({
      instrumentId: loanableInstruments[0]?.id ?? '',
      toArrayId: '',
      code: `JD-${dayjs().format('YYYYMMDD')}-${String(loans.length + 1).padStart(2, '0')}`,
      outDate: dayjs(),
      operator: '',
      remark: '',
    });
    setLoanModalOpen(true);
  };

  const submitLoan = async () => {
    const values = await loanForm.validateFields();
    setSubmitting(true);
    try {
      await dispatch(
        createLoan({
          instrumentId: values.instrumentId,
          toArrayId: values.toArrayId,
          code: values.code,
          outDate: values.outDate ? values.outDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
          operator: values.operator,
          remark: values.remark ?? '',
        })
      ).unwrap();
      setLoanModalOpen(false);
    } catch {
      // 错误文案已由 slice 提示
    } finally {
      setSubmitting(false);
    }
  };

  const openReceive = (loan: Loan) => {
    setReceiveTarget(loan);
    receiveForm.setFieldsValue({ toStationId: '', receiveDate: dayjs() });
  };

  const submitReceive = async () => {
    if (!receiveTarget) return;
    const values = await receiveForm.validateFields();
    setSubmitting(true);
    try {
      await dispatch(
        receiveLoan({
          id: receiveTarget.id,
          toStationId: values.toStationId,
          receiveDate: values.receiveDate ? values.receiveDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
        })
      ).unwrap();
      setReceiveTarget(null);
    } catch {
      // 错误文案已由 slice 提示
    } finally {
      setSubmitting(false);
    }
  };

  const handleReturn = async (loan: Loan) => {
    await dispatch(returnLoan({ id: loan.id, returnDate: dayjs().format('YYYY-MM-DD') })).unwrap();
  };

  const handleHold = async (loan: Loan, reason: string) => {
    await dispatch(holdLoan({ id: loan.id, reason })).unwrap();
  };

  const handleReject = async (loan: Loan) => {
    await dispatch(rejectLoanInstrument({ id: loan.id, returnDate: dayjs().format('YYYY-MM-DD') })).unwrap();
  };

  /** 对账异常行的处置：有单挂起单、无单挂起仪器，均只作用于这一台 */
  const handleIssueHold = async (issue: ReconcileIssue) => {
    if (issue.loanId) {
      await dispatch(holdLoan({ id: issue.loanId, reason: issue.reason })).unwrap();
    } else if (issue.instrumentId) {
      await dispatch(holdInstrument(issue.instrumentId)).unwrap();
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            仪器周转库 · 借调单管理
          </Typography.Title>
          <p className="gb-hint">
            周转库按借调单记出库、在途与归还；台阵台账另管安装位、标定记录与超期名单，两边按序列号对账。
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={loanableInstruments.length === 0}>
          登记借调（出库）
        </Button>
      </div>

      <Alert
        type="info"
        showIcon
        message="统一口径：登记借调单出库那一刻仪器即从借出台阵出账（不等接收台阵登安装位）；在账台数与按期标定率共用这条口径。一台序列号同一时间只算一个台阵在用；借调单没归还前，该仪器不进任何台阵的超期名单。"
      />

      <div className="gb-stats-row">
        <StatBadge label="在途（已出库）" value={totals.transit} suffix="单" tone="info" />
        <StatBadge label="已接收未归还" value={totals.received} suffix="单" tone="warning" />
        <StatBadge label="已归还" value={totals.returned} suffix="单" tone="success" />
        <StatBadge
          label="对账挂起"
          value={totals.held}
          suffix="单"
          tone={totals.held > 0 ? 'danger' : 'default'}
        />
        <StatBadge
          label="对不上的"
          value={totals.issues}
          suffix="台"
          tone={totals.issues > 0 ? 'danger' : 'success'}
          tip="周转库与台阵台账按序列号对账的异常台数"
        />
      </div>

      {issues.length > 0 ? (
        <Card
          className="gb-panel"
          size="small"
          title={
            <Space>
              <AuditOutlined />
              <span>对账异常（{issues.length} 台）——对不上的先挂起来，只退这一台</span>
            </Space>
          }
        >
          <Table
            rowKey={(issue) => issue.key}
            size="small"
            className="gb-table-compact"
            dataSource={issues}
            pagination={false}
            columns={[
              {
                title: '序列号',
                dataIndex: 'serialNo',
                width: 220,
                render: (value: string) => <span className="gb-mono">{value}</span>,
              },
              { title: '对不上的原因', dataIndex: 'reason' },
              {
                title: '处置',
                width: 140,
                render: (_: unknown, issue: ReconcileIssue) => (
                  <Popconfirm
                    title="挂起这一台"
                    description="挂起后该序列号退出在账与超期考核，只影响这一台。确认挂起？"
                    okText="挂起"
                    cancelText="取消"
                    onConfirm={() => void handleIssueHold(issue)}
                  >
                    <Button size="small" danger icon={<StopOutlined />}>
                      挂起这台
                    </Button>
                  </Popconfirm>
                ),
              },
            ]}
          />
        </Card>
      ) : null}

      {heldRows.length > 0 ? (
        <Card className="gb-panel" size="small" title={`挂起处置中（${heldRows.length} 台）`}>
          <Table
            rowKey={(row) => row.key}
            size="small"
            className="gb-table-compact"
            pagination={false}
            dataSource={heldRows}
            columns={[
              {
                title: '序列号',
                dataIndex: 'serialNo',
                width: 220,
                render: (value: string) => <span className="gb-mono">{value}</span>,
              },
              { title: '挂起来源', dataIndex: 'source', width: 200 },
              { title: '挂起原因', dataIndex: 'reason' },
              {
                title: '处置',
                width: 260,
                render: (_: unknown, row: HeldRow) => (
                  <Space size={6}>
                    {row.loan ? (
                      <>
                        <Popconfirm
                          title="退回这一台"
                          description="仪器退回原安装位、借调单按归还闭环，只退这一台。确认退回？"
                          okText="退回"
                          cancelText="取消"
                          onConfirm={() => row.loan && void handleReject(row.loan)}
                        >
                          <Button size="small" type="primary" icon={<RollbackOutlined />}>
                            退回原台阵
                          </Button>
                        </Popconfirm>
                        <Button
                          size="small"
                          icon={<UndoOutlined />}
                          onClick={() => row.loan && void dispatch(unholdLoan({ id: row.loan.id })).unwrap()}
                        >
                          解除挂起
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="small"
                        icon={<UndoOutlined />}
                        onClick={() =>
                          row.instrumentId && void dispatch(unholdInstrument(row.instrumentId)).unwrap()
                        }
                      >
                        解除挂起（恢复在用）
                      </Button>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      ) : null}

      <FilterBar
        modelValue={filterModel}
        selects={[
          {
            key: 'states',
            label: '借调单状态',
            options: LOAN_STATES.map((state) => ({ label: state, value: state })),
          },
        ]}
        keywordPlaceholder="搜索单号 / 序列号 / 台阵 / 经办人"
        onChange={handleFilterChange}
        onReset={() => dispatch(resetLoanFilter())}
      />

      {rows.length === 0 ? (
        <EmptyPanel
          title={loans.length === 0 ? '还没有借调单' : '没有符合条件的借调单'}
          description="台阵施工期互相借调时，先在这里登记借调单出库：仪器即刻从借出台阵出账，接收台阵登好安装位后再入接收台阵的账。"
          actionText="登记借调（出库）"
          secondaryText="重置筛选"
          onAction={openCreate}
          onSecondary={() => dispatch(resetLoanFilter())}
        />
      ) : (
        <Table
          rowKey={(row) => row.loan.id}
          className="gb-table-compact"
          dataSource={rows}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          columns={[
            {
              title: '借调单号',
              width: 170,
              render: (_: unknown, row: LoanRow) => (
                <div>
                  <div className="gb-mono">{row.loan.code}</div>
                  <div className="gb-hint">{row.loan.operator || '未填经办人'}</div>
                </div>
              ),
            },
            {
              title: '序列号 / 型号',
              width: 220,
              render: (_: unknown, row: LoanRow) => (
                <div>
                  <div className="gb-mono">{row.loan.serialNo}</div>
                  <div className="gb-hint">{row.instrument ? `${row.instrument.model} · ${row.instrument.type}` : '台账查无此机'}</div>
                </div>
              ),
            },
            {
              title: '借出 → 接收',
              width: 240,
              render: (_: unknown, row: LoanRow) => (
                <div>
                  <div>
                    {row.fromArrayName} <ExportOutlined /> {row.toArrayName}
                  </div>
                  <div className="gb-hint gb-mono">
                    {row.fromStationCode} → {row.loan.state === '在途' ? '在途未登位' : row.toStationCode}
                  </div>
                </div>
              ),
            },
            {
              title: '出库 / 登位 / 归还',
              width: 200,
              render: (_: unknown, row: LoanRow) => (
                <div className="gb-mono">
                  <div>出库 {row.loan.outDate}</div>
                  <div className="gb-hint">
                    {row.loan.receiveDate ? `登位 ${row.loan.receiveDate}` : '未登位'} ·{' '}
                    {row.loan.returnDate ? `归还 ${row.loan.returnDate}` : '未归还'}
                  </div>
                </div>
              ),
            },
            {
              title: '状态',
              width: 110,
              render: (_: unknown, row: LoanRow) => (
                <Tag color={LOAN_STATE_COLOR[row.loan.state]}>{row.loan.state}</Tag>
              ),
            },
            { title: '备注', dataIndex: ['loan', 'remark'], ellipsis: true },
            {
              title: '操作',
              width: 280,
              render: (_: unknown, row: LoanRow) => (
                <Space size={6} wrap>
                  {row.loan.state === '在途' ? (
                    <Button size="small" type="primary" icon={<ImportOutlined />} onClick={() => openReceive(row.loan)}>
                      接收登位
                    </Button>
                  ) : null}
                  {row.loan.state === '在途' || row.loan.state === '已接收' ? (
                    <>
                      <Popconfirm
                        title="登记归还"
                        description="仪器将迁回原安装位并恢复在账，归还后重新进入超期考核。确认归还？"
                        okText="归还"
                        cancelText="取消"
                        onConfirm={() => void handleReturn(row.loan)}
                      >
                        <Button size="small" icon={<RollbackOutlined />}>
                          归还
                        </Button>
                      </Popconfirm>
                      <Button size="small" danger icon={<StopOutlined />} onClick={() => void handleHold(row.loan, '人工挂起')}>
                        挂起
                      </Button>
                    </>
                  ) : null}
                  {row.loan.state === '已挂起' ? (
                    <>
                      <Popconfirm
                        title="退回这一台"
                        description="仪器退回原安装位、借调单按归还闭环，只退这一台。确认退回？"
                        okText="退回"
                        cancelText="取消"
                        onConfirm={() => void handleReject(row.loan)}
                      >
                        <Button size="small" type="primary" icon={<RollbackOutlined />}>
                          退回原台阵
                        </Button>
                      </Popconfirm>
                      <Button size="small" icon={<UndoOutlined />} onClick={() => void dispatch(unholdLoan({ id: row.loan.id })).unwrap()}>
                        解除挂起
                      </Button>
                    </>
                  ) : null}
                  {row.loan.state === '已归还' ? (
                    <Popconfirm
                      title="删除借调单"
                      description="仅删除已闭环的单据，不影响仪器档案。确认删除？"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => void dispatch(removeLoan(row.loan.id)).unwrap()}
                    >
                      <Button size="small" danger icon={<DeleteOutlined />}>
                        删除
                      </Button>
                    </Popconfirm>
                  ) : null}
                </Space>
              ),
            },
          ]}
        />
      )}

      <p className="gb-hint">
        在账台数与按期标定率以台阵台账为准：借出在途与对账挂起的仪器不占任何台阵账；
        接收台阵登好安装位后仪器才计入接收台阵在账，但借调单未归还前仍不进超期名单。
      </p>

      <Modal
        open={loanModalOpen}
        title="登记借调（出库即出账）"
        onCancel={() => setLoanModalOpen(false)}
        onOk={() => void submitLoan()}
        confirmLoading={submitting}
        okText="登记出库"
        width={620}
        destroyOnClose
      >
        <Form form={loanForm} layout="vertical" preserve={false}>
          <Form.Item
            name="instrumentId"
            label="借出仪器（仅在账且未借出的可借）"
            rules={[{ required: true, message: '请选择要借出的仪器' }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择仪器（台阵 / 台站 / 型号 / 序列号）"
              options={loanableInstruments.map((instrument) => {
                const station = stations.find((row) => row.id === instrument.stationId);
                const arrayName = station ? arrayNameOf(station.arrayId) : '未知台阵';
                return {
                  label: `${arrayName} / ${station?.code ?? '未知台站'} · ${instrument.model}（${instrument.serialNo}）`,
                  value: instrument.id,
                };
              })}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="toArrayId" label="接收台阵" rules={[{ required: true, message: '请选择接收台阵' }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="借往哪个台阵"
                  options={arrays.map((array) => ({ label: array.name, value: array.id }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="outDate" label="出库日期" rules={[{ required: true, message: '请选择出库日期' }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="code" label="借调单号" rules={[{ required: true, message: '请填写借调单号' }]}>
                <Input maxLength={40} placeholder="如：JD-20261006-01" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="operator" label="经办人" rules={[{ required: true, message: '请填写经办人' }]}>
                <Input maxLength={20} placeholder="如：周渝" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} placeholder="如：施工期加密观测借调" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={receiveTarget !== null}
        title={`接收登位 · ${receiveTarget?.serialNo ?? ''}`}
        onCancel={() => setReceiveTarget(null)}
        onOk={() => void submitReceive()}
        confirmLoading={submitting}
        okText="登记安装位"
        destroyOnClose
      >
        <p className="gb-hint">
          接收台阵：{receiveTarget ? arrayNameOf(receiveTarget.toArrayId) : ''}。
          登好安装位后仪器计入接收台阵在账；借调单未归还前仍不进超期名单。
        </p>
        <Form form={receiveForm} layout="vertical" preserve={false}>
          <Form.Item name="toStationId" label="安装台站" rules={[{ required: true, message: '请选择安装台站' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择接收台阵的台站"
              options={stations
                .filter((station) => station.arrayId === receiveTarget?.toArrayId)
                .map((station) => ({ label: `${station.code}（${station.bedrock}）`, value: station.id }))}
            />
          </Form.Item>
          <Form.Item name="receiveDate" label="登位日期" rules={[{ required: true, message: '请选择登位日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
