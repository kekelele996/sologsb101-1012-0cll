/**
 * 模块：/loans 仪器周转库
 * 按借调单记出库、在途与归还；台阵的安装位、标定与超期由台阵台账侧维护。
 * 统一口径（utils/reconcile.ts）：出库即从原台阵出账；接收台阵登记安装位后才计入接收台阵；
 * 借调单未归还前不进超期；序列号对不上账的挂起，只退这一台。
 */
import { useMemo, useState } from 'react';
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
  CheckOutlined,
  DeleteOutlined,
  EnvironmentOutlined,
  PlusOutlined,
  CarOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import {
  checkoutLoan,
  registerLoanInstall,
  removeLoan,
  transitionLoan,
  selectLoans,
} from '@/stores/loanSlice';
import { type LoanSlip, type LoanState } from '@/types/loan';
import { useSerialRegistry } from '@/hooks/useSerialRegistry';
import { initDatabase } from '@/utils/db';

interface CheckoutFormValues {
  serialNo: string;
  lenderArrayId: string;
  borrowerArrayId: string;
  checkoutDate: dayjs.Dayjs | null;
  operator: string;
  remark: string;
}

interface InstallFormValues {
  installStationId: string;
  installDate: dayjs.Dayjs | null;
}

const STATE_COLOR: Record<LoanState, string> = {
  在途: 'orange',
  在借: 'blue',
  已归还: 'green',
};

const SUSPEND_TEXT: Record<string, string> = {
  'slip-without-ledger': '借调单有序列号，台账查无此仪器',
  'install-without-slip': '安装位与借调单对不上',
  'duplicate-install': '同一序列号登记了多个安装位',
};

export default function LoanBoard() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const arrays = useAppSelector(selectArrays);
  const stations = useAppSelector(selectStations);
  const instruments = useAppSelector(selectInstruments);
  const loans = useAppSelector(selectLoans);
  const registry = useSerialRegistry();

  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [installTarget, setInstallTarget] = useState<LoanSlip | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [checkoutForm] = Form.useForm<CheckoutFormValues>();
  const [installForm] = Form.useForm<InstallFormValues>();

  const arrayName = (id: string): string => arrays.find((array) => array.id === id)?.name ?? '未知台阵';
  const stationName = (id: string | null): string =>
    id ? stations.find((station) => station.id === id)?.code ?? '未知台站' : '—';

  const instrumentBySerial = useMemo(() => {
    const map = new Map<string, { model: string; stationId: string }>();
    instruments.forEach((instrument) => map.set(instrument.serialNo, { model: instrument.model, stationId: instrument.stationId }));
    return map;
  }, [instruments]);

  /** 借调单列表（最新在前），挂起标记来自统一对账 */
  const rows = useMemo(() => {
    return loans
      .slice()
      .sort((a, b) => b.checkoutDate.localeCompare(a.checkoutDate) || b.createdAt - a.createdAt)
      .map((loan) => {
        const entry = registry.bySerial.get(loan.serialNo);
        return {
          loan,
          model: instrumentBySerial.get(loan.serialNo)?.model ?? '台账无此仪器',
          suspended: entry?.suspended ?? false,
          suspendReasons: entry?.suspendReasons ?? [],
          overdueSuspended: entry?.overdueSuspended ?? false,
        };
      });
  }, [loans, registry, instrumentBySerial]);

  const totals = useMemo(() => {
    const inTransit = loans.filter((loan) => loan.state === '在途').length;
    const onLoan = loans.filter((loan) => loan.state === '在借').length;
    const returned = loans.filter((loan) => loan.state === '已归还').length;
    const suspended = registry.suspended.length;
    return { inTransit, onLoan, returned, suspended, open: inTransit + onLoan };
  }, [loans, registry]);

  const openCheckout = () => {
    checkoutForm.setFieldsValue({
      serialNo: '',
      lenderArrayId: arrays[0]?.id,
      borrowerArrayId: arrays[1]?.id ?? arrays[0]?.id,
      checkoutDate: dayjs(),
      operator: '周渝',
      remark: '',
    });
    setCheckoutOpen(true);
  };

  const submitCheckout = async () => {
    const values = await checkoutForm.validateFields();
    setSubmitting(true);
    try {
      const serialNo = values.serialNo.trim();
      await dispatch(
        checkoutLoan({
          serialNo,
          lenderArrayId: values.lenderArrayId,
          borrowerArrayId: values.borrowerArrayId,
          checkoutDate: values.checkoutDate ? values.checkoutDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
          operator: values.operator.trim(),
          remark: values.remark?.trim() ?? '',
        })
      ).unwrap();
      message.success(`借调单已出库：${serialNo} 出库即从原台阵出账`);
      setCheckoutOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '出库登记失败');
    } finally {
      setSubmitting(false);
    }
  };

  const openInstall = (loan: LoanSlip) => {
    setInstallTarget(loan);
    const borrowerStations = stations.filter((station) => station.arrayId === loan.borrowerArrayId);
    installForm.setFieldsValue({
      installStationId: borrowerStations[0]?.id,
      installDate: dayjs(),
    });
  };

  const submitInstall = async () => {
    if (!installTarget) return;
    const values = await installForm.validateFields();
    setSubmitting(true);
    try {
      await dispatch(
        registerLoanInstall({
          id: installTarget.id,
          installStationId: values.installStationId,
          installDate: values.installDate ? values.installDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
        })
      ).unwrap();
      message.success('接收台阵已登记安装位，仪器计入接收台阵在账台数');
      setInstallTarget(null);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '安装位登记失败');
    } finally {
      setSubmitting(false);
    }
  };

  const returnLoan = async (loan: LoanSlip) => {
    try {
      await dispatch(transitionLoan({ id: loan.id, next: '已归还' })).unwrap();
      message.success('借调仪器已归还，重新计入原台阵在账台数');
    } catch (error) {
      message.error(typeof error === 'string' ? error : '归还失败');
    }
  };

  const borrowerStationOptions = stations
    .filter((station) => station.arrayId === installTarget?.borrowerArrayId)
    .map((station) => ({ label: station.code, value: station.id }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            仪器周转库 · 借调单
          </Typography.Title>
          <p className="gb-hint">
            周转库只凭借调单记出库、在途与归还；台阵安装位、标定记录与超期名单归台阵台账。
            出库即出账，接收台阵登记安装位后才计入接收台阵；借调单未归还前不进超期；序列号对不上账的挂起，只退这一台。
          </p>
        </div>
        <Space wrap>
          <Button icon={<CarOutlined />} onClick={() => void initDatabase()}>
            补齐演示数据
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCheckout}>
            出库登记
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="借调单总数" value={loans.length} suffix="张" tone="primary" />
        <StatBadge label="在途（两边不在账）" value={totals.inTransit} suffix="台" tone="warning" />
        <StatBadge label="在借（接收台阵在账）" value={totals.onLoan} suffix="台" tone="info" />
        <StatBadge label="已归还" value={totals.returned} suffix="台" tone="success" />
        <StatBadge
          label="对账挂起"
          value={totals.suspended}
          suffix="台"
          tone={totals.suspended > 0 ? 'danger' : 'success'}
          tip="序列号对不上账的仪器，只退出这一台的统计"
        />
      </div>

      {registry.suspended.length > 0 ? (
        <Alert
          type="error"
          showIcon
          message={`按序列号对账发现 ${registry.suspended.length} 台对不上账，已挂起（不计入任何台阵在账台数 / 按期标定率 / 超期名单）`}
          description={registry.suspended
            .map(
              (entry) =>
                `${entry.serialNo}：${entry.suspendReasons.map((reason) => SUSPEND_TEXT[reason]).join('、')}`
            )
            .join('；')}
        />
      ) : (
        <Alert type="success" showIcon message="周转库与台阵台账按序列号对账一致，无挂起仪器" />
      )}

      {rows.length === 0 ? (
        <EmptyPanel
          title="还没有借调单"
          description="台阵施工期借调仪器时，先在周转库做出库登记；仪器出库即从原台阵出账，进入在途。"
          actionText="出库登记"
          onAction={openCheckout}
        />
      ) : (
        <Card className="gb-panel" size="small" title={`借调单流转（${rows.length} 张）`}>
          <Table
            rowKey={(item) => item.loan.id}
            size="small"
            className="gb-table-compact"
            dataSource={rows}
            pagination={false}
            rowClassName={(item) => (item.suspended ? 'gb-row-danger' : '')}
            columns={[
              {
                title: '仪器 / 序列号',
                width: 230,
                render: (_: unknown, item) => (
                  <div>
                    <div>{item.model}</div>
                    <div className="gb-hint gb-mono">{item.loan.serialNo}</div>
                  </div>
                ),
              },
              {
                title: '借出方 → 接收方',
                width: 240,
                render: (_: unknown, item) => (
                  <span className="gb-mono">
                    {arrayName(item.loan.lenderArrayId)} → {arrayName(item.loan.borrowerArrayId)}
                  </span>
                ),
              },
              {
                title: '状态',
                width: 100,
                render: (_: unknown, item) => <Tag color={STATE_COLOR[item.loan.state]}>{item.loan.state}</Tag>,
              },
              { title: '出库日期', dataIndex: ['loan', 'checkoutDate'], width: 110, className: 'gb-mono' },
              {
                title: '接收台阵安装位',
                width: 150,
                render: (_: unknown, item) => (
                  <span className="gb-mono">
                    {stationName(item.loan.installStationId)}
                    {item.loan.installDate ? <span className="gb-hint">（{item.loan.installDate}）</span> : null}
                  </span>
                ),
              },
              { title: '归还日期', dataIndex: ['loan', 'returnDate'], width: 110, className: 'gb-mono',
                render: (value: string | null) => value ?? <span className="gb-hint">未归还</span> },
              {
                title: '对账',
                width: 180,
                render: (_: unknown, item) =>
                  item.suspended ? (
                    <Tag color="red">
                      挂起：{item.suspendReasons.map((reason) => SUSPEND_TEXT[reason]).join('、')}
                    </Tag>
                  ) : item.overdueSuspended ? (
                    <Tag color="blue">借调未归还，缓计超期</Tag>
                  ) : (
                    <Tag color="green">一致</Tag>
                  ),
              },
              {
                title: '操作',
                width: 250,
                render: (_: unknown, item) => (
                  <Space size={6}>
                    {item.loan.state === '在途' ? (
                      <Button
                        size="small"
                        type="primary"
                        icon={<EnvironmentOutlined />}
                        onClick={() => openInstall(item.loan)}
                      >
                        登记安装位
                      </Button>
                    ) : null}
                    {item.loan.state !== '已归还' ? (
                      <Button size="small" icon={<CheckOutlined />} onClick={() => void returnLoan(item.loan)}>
                        归还
                      </Button>
                    ) : null}
                    <Popconfirm
                      title="删除借调单"
                      description="删除后该序列号恢复按台阵台账安装位对账，确认删除？"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() =>
                        void dispatch(removeLoan(item.loan.id))
                          .unwrap()
                          .then(() => message.success('借调单已删除'))
                      }
                    >
                      <Button size="small" danger icon={<DeleteOutlined />}>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      )}

      <p className="gb-hint">
        口径说明：在账台数与按期标定率两边共用同一条序列号对账结果。出库（在途）时仪器不属于任何台阵；
        接收台阵登记安装位（在借）后计入接收台阵；归还后回原台阵。借调单未归还前即使物理超期也不进超期名单。
      </p>

      <Modal
        open={checkoutOpen}
        title="出库登记（新建借调单）"
        onCancel={() => setCheckoutOpen(false)}
        onOk={() => void submitCheckout()}
        confirmLoading={submitting}
        okText="出库（即刻从原台阵出账）"
        destroyOnClose
      >
        <Form form={checkoutForm} layout="vertical" preserve={false}>
          <Form.Item name="serialNo" label="仪器序列号" rules={[{ required: true, message: '请填写序列号' }]}>
            <Select
              showSearch
              placeholder="选择在账仪器（按序列号）"
              options={instruments.map((instrument) => {
                const station = stations.find((row) => row.id === instrument.stationId);
                const array = station ? arrays.find((row) => row.id === station.arrayId) : undefined;
                return {
                  label: `${instrument.serialNo} · ${instrument.model}（${array?.name ?? '—'} / ${station?.code ?? '—'}）`,
                  value: instrument.serialNo,
                };
              })}
              filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="lenderArrayId" label="借出方台阵（原台阵）" rules={[{ required: true }]}>
                <Select options={arrays.map((array) => ({ label: array.name, value: array.id }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="borrowerArrayId" label="接收台阵" rules={[{ required: true }]}>
                <Select options={arrays.map((array) => ({ label: array.name, value: array.id }))} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="checkoutDate" label="出库日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="operator" label="经办人" rules={[{ required: true, message: '请填写经办人' }]}>
                <Input maxLength={20} placeholder="如：周渝" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} placeholder="如：施工期借调，预计 30 天归还" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={!!installTarget}
        title={`接收台阵登记安装位 · ${installTarget?.serialNo ?? ''}`}
        onCancel={() => setInstallTarget(null)}
        onOk={() => void submitInstall()}
        confirmLoading={submitting}
        okText="登记并计入接收台阵"
        destroyOnClose
      >
        <Form form={installForm} layout="vertical" preserve={false}>
          <p className="gb-hint" style={{ marginTop: 0 }}>
            接收台阵：{installTarget ? arrayName(installTarget.borrowerArrayId) : ''}。登记后借调单由在途转为在借。
          </p>
          <Form.Item name="installStationId" label="安装台站（安装位）" rules={[{ required: true, message: '请选择安装台站' }]}>
            <Select
              options={borrowerStationOptions}
              notFoundContent="接收台阵还没有台站，请先到台站仪器页布设"
            />
          </Form.Item>
          <Form.Item name="installDate" label="安装日期" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
