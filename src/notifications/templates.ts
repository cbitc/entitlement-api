import type { NotificationType } from '@prisma/client';
import type {
  NotificationPayloadByType,
  RenderedMail,
  TemplateContext,
} from './notifications.types';

const INTERVAL_LABELS: Record<'MONTH' | 'YEAR', string> = {
  MONTH: '月付',
  YEAR: '年付',
};

/**
 * Message copy is deliberately not translated at runtime: the customer portal
 * is Chinese, so the mail speaks the same language. A second locale would mean
 * a locale column on the outbox row, not a conditional in this file.
 */
const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const formatMoney = (cents: number, currency: string): string =>
  new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);

const formatTime = (iso: string, ctx: TemplateContext): string =>
  new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: ctx.timeZone,
  }).format(new Date(iso));

interface MailLine {
  readonly label: string;
  readonly value: string;
}

const textBody = (
  greeting: string,
  lines: readonly MailLine[],
  footer: string,
): string =>
  [
    greeting,
    '',
    ...lines.map((line) => `${line.label}：${line.value}`),
    '',
    footer,
  ].join('\n');

const htmlBody = (
  title: string,
  greeting: string,
  lines: readonly MailLine[],
  footer: string,
  cta: { readonly label: string; readonly url: string } | null,
  ctx: TemplateContext,
): string => {
  const rows = lines
    .map(
      (line) =>
        `<tr><td style="padding:4px 16px 4px 0;color:#6e7781">${escapeHtml(
          line.label,
        )}</td><td style="padding:4px 0;color:#1f2328">${escapeHtml(
          line.value,
        )}</td></tr>`,
    )
    .join('');

  const button = cta
    ? `<p style="margin:24px 0"><a href="${escapeHtml(
        cta.url,
      )}" style="display:inline-block;padding:10px 20px;border-radius:6px;background:#0969da;color:#ffffff;text-decoration:none">${escapeHtml(
        cta.label,
      )}</a></p>`
    : '';

  return [
    "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;line-height:1.6;max-width:560px;margin:0 auto;padding:24px\">",
    `<h2 style="margin:0 0 16px;color:#1f2328">${escapeHtml(title)}</h2>`,
    `<p style="margin:0 0 16px;color:#1f2328">${escapeHtml(greeting)}</p>`,
    `<table style="border-collapse:collapse;margin:0 0 16px">${rows}</table>`,
    button,
    `<p style="margin:16px 0 0;color:#1f2328">${escapeHtml(footer)}</p>`,
    `<hr style="border:none;border-top:1px solid #d0d7de;margin:24px 0 12px" />`,
    `<p style="margin:0;color:#6e7781;font-size:12px">此邮件由 ${escapeHtml(
      ctx.appName,
    )} 自动发送，请勿直接回复。</p>`,
    '</div>',
  ].join('');
};

const paymentSucceeded = (
  payload: NotificationPayloadByType['PAYMENT_SUCCEEDED'],
  ctx: TemplateContext,
): RenderedMail => {
  const lines: MailLine[] = [
    { label: '订单号', value: payload.orderNumber },
    { label: '产品', value: payload.productName },
    { label: '套餐', value: payload.planName },
    { label: '计费周期', value: INTERVAL_LABELS[payload.interval] },
    {
      label: '支付金额',
      value: formatMoney(payload.amountCents, payload.currency),
    },
    { label: '支付时间', value: formatTime(payload.paidAt, ctx) },
  ];

  if (payload.endsAt) {
    lines.push({ label: '有效期至', value: formatTime(payload.endsAt, ctx) });
  }

  const title = '支付成功';
  const greeting = payload.startsAt
    ? `我们已收到你的续费，新周期将在 ${formatTime(
        payload.startsAt,
        ctx,
      )} 自动开始。`
    : '我们已收到你的付款，订阅已生效。';
  const footer = payload.startsAt
    ? '在周期边界之前，当前权益保持不变。'
    : '你现在就可以在客户端激活设备并开始使用。';

  return {
    subject: `支付成功 · ${payload.productName} ${payload.planName}`,
    text: textBody(greeting, lines, footer),
    html: htmlBody(
      title,
      greeting,
      lines,
      footer,
      {
        label: '查看订单',
        url: `${ctx.webUrl}/orders`,
      },
      ctx,
    ),
  };
};

const subscriptionExpired = (
  payload: NotificationPayloadByType['SUBSCRIPTION_EXPIRED'],
  ctx: TemplateContext,
): RenderedMail => {
  const lines: MailLine[] = [
    { label: '产品', value: payload.productName },
    { label: '套餐', value: payload.planName },
    { label: '到期时间', value: formatTime(payload.endedAt, ctx) },
  ];

  const title = '订阅已到期';
  const greeting = payload.paused
    ? '你的订阅在暂停状态下到期，权益已停止。'
    : '你的订阅已到期，权益已停止。';
  const footer = payload.paused
    ? '如需继续使用，请重新订阅。'
    : '如需继续使用，请前往目录重新订阅。';

  return {
    subject: `订阅已到期 · ${payload.productName}`,
    text: textBody(greeting, lines, footer),
    html: htmlBody(
      title,
      greeting,
      lines,
      footer,
      {
        label: '前往目录',
        url: `${ctx.webUrl}/catalog`,
      },
      ctx,
    ),
  };
};

const refundIssued = (
  payload: NotificationPayloadByType['REFUND_ISSUED'],
  ctx: TemplateContext,
): RenderedMail => {
  const lines: MailLine[] = [
    { label: '订单号', value: payload.orderNumber },
    {
      label: '退款金额',
      value: formatMoney(payload.amountCents, payload.currency),
    },
    { label: '退款原因', value: payload.reason },
    { label: '退款时间', value: formatTime(payload.completedAt, ctx) },
  ];

  const title = '退款已到账';
  const greeting = '你的退款已原路退回，实际到账时间以支付渠道为准。';
  const footer = '如对本次退款有疑问，请联系客服。';

  return {
    subject: `退款已到账 · 订单 ${payload.orderNumber}`,
    text: textBody(greeting, lines, footer),
    html: htmlBody(
      title,
      greeting,
      lines,
      footer,
      {
        label: '查看订单',
        url: `${ctx.webUrl}/orders`,
      },
      ctx,
    ),
  };
};

/**
 * The one place that knows which copy belongs to which event.
 *
 * Kept pure and synchronous so the dispatcher can be unit tested without a
 * database or a transport, and so a template failure cannot half-send a batch.
 */
export const renderNotification = (
  type: NotificationType,
  payload: unknown,
  ctx: TemplateContext,
): RenderedMail => {
  switch (type) {
    case 'PAYMENT_SUCCEEDED':
      return paymentSucceeded(
        payload as NotificationPayloadByType['PAYMENT_SUCCEEDED'],
        ctx,
      );
    case 'SUBSCRIPTION_EXPIRED':
      return subscriptionExpired(
        payload as NotificationPayloadByType['SUBSCRIPTION_EXPIRED'],
        ctx,
      );
    case 'REFUND_ISSUED':
      return refundIssued(
        payload as NotificationPayloadByType['REFUND_ISSUED'],
        ctx,
      );
    default:
      throw new Error(`Unknown notification type: ${String(type)}`);
  }
};

export const escapeNotificationHtml = escapeHtml;
export const formatNotificationMoney = formatMoney;
export const formatNotificationTime = formatTime;
