import { resolveSubscriptionFormat } from './subscription-format.interface';

describe('resolveSubscriptionFormat', () => {
  it.each([
    'Happ/3.0',
    'v2rayNG/1.10',
    'Streisand/1.6',
    'NekoBox/1.4',
    'NekoBox/Android',
    'nekobox',
    undefined,
  ])('serves VLESS base64 to %s', (userAgent) => {
    expect(resolveSubscriptionFormat(userAgent, undefined)).toBe('base64');
  });

  it.each(['Hiddify/2.0', 'sing-box/1.14', 'Karing/1.2'])(
    'serves sing-box JSON to %s',
    (userAgent) => {
      expect(resolveSubscriptionFormat(userAgent, undefined)).toBe('singbox');
    },
  );

  it('honors explicit format overrides for recognized clients', () => {
    expect(resolveSubscriptionFormat('Hiddify/2.0', 'base64')).toBe('base64');
    expect(resolveSubscriptionFormat('Happ/3.0', 'singbox')).toBe('singbox');
    expect(resolveSubscriptionFormat('NekoBox/1.4', 'singbox')).toBe('singbox');
  });

  it('ignores an unsupported override and detects the client', () => {
    expect(resolveSubscriptionFormat('NekoBox/1.4', 'invalid')).toBe('base64');
  });
});
