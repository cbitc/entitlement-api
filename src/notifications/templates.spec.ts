import { describe, expect, it } from 'vitest';
import {
  escapeNotificationHtml,
  formatNotificationMoney,
  renderNotification,
} from './templates';
import type { TemplateContext } from './notifications.types';

const context: TemplateContext = {
  appName: 'Entitlement Portal',
  webUrl: 'https://portal.example',
  timeZone: 'Asia/Shanghai',
};

const paymentPayload = {
  orderId: 'order-1',
  orderNumber: 'ORD1',
  productName: 'AI Platform',
  planName: 'Standard',
  interval: 'MONTH' as const,
  amountCents: 9900,
  currency: 'cny',
  paidAt: '2026-10-27T00:00:00.000Z',
  startsAt: null,
  endsAt: '2026-11-27T00:00:00.000Z',
};

describe('notification templates', () => {
  it('renders a receipt with the formatted amount and local time', () => {
    const mail = renderNotification(
      'PAYMENT_SUCCEEDED',
      paymentPayload,
      context,
    );

    expect(mail.subject).toBe('支付成功 · AI Platform Standard');
    expect(mail.text).toContain('¥99.00');
    expect(mail.text).toContain('2026年11月27日');
    expect(mail.html).toContain('https://portal.example/orders');
  });

  it('names the boundary when a renewal was paid early', () => {
    const mail = renderNotification(
      'PAYMENT_SUCCEEDED',
      {
        ...paymentPayload,
        startsAt: '2026-11-27T00:00:00.000Z',
        endsAt: null,
      },
      context,
    );

    expect(mail.text).toContain('新周期将在');
    expect(mail.text).not.toContain('有效期至');
  });

  it('tells a paused subscription apart from an unpaid one', () => {
    const paused = renderNotification(
      'SUBSCRIPTION_EXPIRED',
      {
        subscriptionId: 'sub-1',
        productName: 'AI Platform',
        planName: 'Standard',
        endedAt: '2026-10-27T00:00:00.000Z',
        paused: true,
      },
      context,
    );

    expect(paused.text).toContain('暂停状态下到期');
  });

  it('escapes user-controlled text in the HTML body', () => {
    const mail = renderNotification(
      'PAYMENT_SUCCEEDED',
      {
        ...paymentPayload,
        productName: '<script>alert(1)</script>',
      },
      context,
    );

    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('formats money and escapes the helper independently', () => {
    expect(formatNotificationMoney(123456, 'cny')).toContain('1,234.56');
    expect(escapeNotificationHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});
