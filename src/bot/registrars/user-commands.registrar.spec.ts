import { Bot, Context } from 'grammy';
import { PeersService } from 'src/peers/peers.service';
import { MainHandler } from '../handlers/main.handler';
import { PeerCreateHandler } from '../handlers/peer-create.handler';
import { PeerManageHandler } from '../handlers/peer-manage.handler';
import { PeerDeleteHandler } from '../handlers/peer-delete.handler';
import { InvoiceService } from '../invoice/invoice.service';
import { MainMenuService } from '../menu/main-menu.service';
import { PaymentService } from 'src/payment/payment.service';
import { AutopayHandler } from '../handlers/autopay.handler';
import { UserCommandsRegistrar } from './user-commands.registrar';

describe('UserCommandsRegistrar peer callback ownership', () => {
  const callbacks = new Map<string, unknown>();
  const findPeer = jest.fn();
  const showVlessQrCode = jest.fn();
  const togglePeer = jest.fn();
  let registrar: UserCommandsRegistrar;

  beforeEach(() => {
    callbacks.clear();
    findPeer.mockReset().mockResolvedValue({ telegramId: '200' });
    showVlessQrCode.mockReset();
    togglePeer.mockReset();

    registrar = new UserCommandsRegistrar(
      {} as MainHandler,
      {} as PeerCreateHandler,
      {
        showVlessQrCode,
        togglePeer,
      } as unknown as PeerManageHandler,
      {} as PeerDeleteHandler,
      { findPeer } as unknown as PeersService,
      {} as InvoiceService,
      {} as MainMenuService,
      {} as PaymentService,
      {} as AutopayHandler,
    );

    const bot = {
      command: jest.fn(),
      callbackQuery: (trigger: string | RegExp, handler: unknown) => {
        callbacks.set(String(trigger), handler);
      },
    } as unknown as Bot;
    registrar.register(bot, (userId) => userId === '100');
  });

  function context(userId: number, match: string[]) {
    const answerCallbackQuery = jest.fn().mockResolvedValue(true);
    return {
      ctx: {
        from: { id: userId },
        match,
        answerCallbackQuery,
      } as unknown as Context,
      answerCallbackQuery,
    };
  }

  async function invoke(pattern: RegExp, ctx: Context): Promise<void> {
    const handler = callbacks.get(String(pattern));
    if (typeof handler !== 'function')
      throw new Error('Callback was not registered');
    await (handler as (context: Context) => Promise<unknown>)(ctx);
  }

  it('denies a foreign peer VLESS QR callback before returning its data', async () => {
    const { ctx, answerCallbackQuery } = context(300, [
      'vless_qr:peer-a',
      'peer-a',
    ]);

    await invoke(/^vless_qr:(.+)$/, ctx);

    expect(findPeer).toHaveBeenCalledWith('peer-a');
    expect(showVlessQrCode).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Нет доступа к этому конфигу',
      show_alert: true,
    });
  });

  it('denies a foreign peer mutation callback', async () => {
    const { ctx, answerCallbackQuery } = context(300, [
      'toggle_peer:peer-a',
      'peer-a',
    ]);

    await invoke(/^toggle_peer:(.+)$/, ctx);

    expect(togglePeer).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Нет доступа к этому конфигу',
      show_alert: true,
    });
  });

  it('allows the peer owner and an administrator', async () => {
    const { ctx: ownerContext } = context(200, ['vless_qr:peer-a', 'peer-a']);
    await invoke(/^vless_qr:(.+)$/, ownerContext);

    expect(showVlessQrCode).toHaveBeenCalledWith(ownerContext, 'peer-a');

    findPeer.mockClear();
    const { ctx: adminContext } = context(100, ['vless_qr:peer-a', 'peer-a']);
    await invoke(/^vless_qr:(.+)$/, adminContext);

    expect(findPeer).not.toHaveBeenCalled();
    expect(showVlessQrCode).toHaveBeenCalledWith(adminContext, 'peer-a');
  });
});
