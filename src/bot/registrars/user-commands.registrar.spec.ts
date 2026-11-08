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
  const showQrCode = jest.fn();
  const togglePeer = jest.fn();
  const showEditDescriptionPrompt = jest.fn();
  const deletePeer = jest.fn();
  let registrar: UserCommandsRegistrar;

  beforeEach(() => {
    callbacks.clear();
    findPeer.mockReset().mockResolvedValue({ telegramId: '200' });
    showQrCode.mockReset();
    togglePeer.mockReset();
    showEditDescriptionPrompt.mockReset();
    deletePeer.mockReset();

    registrar = new UserCommandsRegistrar(
      {} as MainHandler,
      {} as PeerCreateHandler,
      {
        showQrCode,
        togglePeer,
        showEditDescriptionPrompt,
      } as unknown as PeerManageHandler,
      { deletePeer } as unknown as PeerDeleteHandler,
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
    registrar.register(bot, (userId) => userId === '100' || userId === '101');
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

  it('denies a foreign peer legacy QR callback before returning its data', async () => {
    const { ctx, answerCallbackQuery } = context(300, [
      'vless_qr:peer-a',
      'peer-a',
    ]);

    await invoke(/^vless_qr:(.+)$/, ctx);

    expect(findPeer).toHaveBeenCalledWith('peer-a');
    expect(showQrCode).not.toHaveBeenCalled();
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

    expect(showQrCode).toHaveBeenCalledWith(ownerContext, 'peer-a');

    findPeer.mockClear();
    const { ctx: adminContext } = context(100, ['vless_qr:peer-a', 'peer-a']);
    await invoke(/^vless_qr:(.+)$/, adminContext);

    expect(findPeer).not.toHaveBeenCalled();
    expect(showQrCode).toHaveBeenCalledWith(adminContext, 'peer-a');
  });

  it('denies an administrator mutating another administrator config', async () => {
    findPeer.mockResolvedValue({ telegramId: '100' });
    const { ctx, answerCallbackQuery } = context(101, [
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

  it('allows an administrator mutating a non-admin config', async () => {
    const { ctx } = context(100, ['toggle_peer:peer-a', 'peer-a']);

    await invoke(/^toggle_peer:(.+)$/, ctx);

    expect(findPeer).toHaveBeenCalledWith('peer-a');
    expect(togglePeer).toHaveBeenCalledWith(ctx, 'peer-a', true);
  });

  it('allows the config owner to edit its description', async () => {
    const { ctx } = context(200, ['edit_description:peer-a', 'peer-a']);

    await invoke(/^edit_description:(.+)$/, ctx);

    expect(showEditDescriptionPrompt).toHaveBeenCalledWith(
      ctx,
      'peer-a',
      false,
    );
  });

  it('allows the config owner to delete own config', async () => {
    const { ctx } = context(200, ['delete_peer:peer-a', 'peer-a']);

    await invoke(/^delete_peer:(.+)$/, ctx);

    expect(deletePeer).toHaveBeenCalledWith(ctx, 'peer-a', false);
  });
});
