import type { Logger } from '@nestjs/common';
import { Api, Context, InputFile } from 'grammy';
import type { PeersService, TPeer } from 'src/peers/peers.service';
import { BotUi } from '../ui/bot.ui';

export async function sendCreatedPeerMessage(
  api: Api,
  chatId: string | number,
  peersService: PeersService,
  peer: TPeer,
  config: string,
  caption: string,
  _isAdmin: boolean,
  subscriptionUrl: string | null = null,
  keyboard = BotUi.configDeliveredKeyboard(peer.name),
) {
  const options = {
    parse_mode: 'Markdown' as const,
    reply_markup: keyboard,
  };
  if (config) {
    return api.sendDocument(
      chatId,
      new InputFile(Buffer.from(config), `${peer.name}.conf`),
      { ...options, caption },
    );
  }
  const links = await peersService.getPeerVlessText(peer.name);
  return api.sendMessage(
    chatId,
    BotUi.configDeliveryText(caption, links, subscriptionUrl),
    { ...options, link_preview_options: { is_disabled: true } },
  );
}

/**
 * QR-код и файл конфига отправляются отдельным сообщением поверх карточки конфига —
 * карточка при этом остаётся нетронутой выше. Поэтому возврат «« К конфигу» не
 * редактирует и не пересоздаёт карточку, а просто удаляет медиа-сообщение
 * (closeMediaMessage): редактировать текст у фото/документа Telegram не даёт, и
 * попытка это сделать оставляла висеть медиа и плодила дубликат меню.
 *
 * Единая точка для всех веток (свои конфиги, клиент админа, член группы «Семья») —
 * раньше эта логика была продублирована трижды и расходилась между ветками.
 */

export async function sendPeerQrCodeMessage(
  ctx: Context,
  peersService: PeersService,
  peerName: string,
  logger: Logger,
): Promise<void> {
  if (!ctx.chat) return;

  try {
    const startedAt = Date.now();
    const qrBuffer = await peersService.generatePeerQrCode(peerName);
    const generatedAt = Date.now();

    const file = new InputFile(qrBuffer, `${peerName}_qr.png`);
    const options = {
      caption: `📷 *QR-код для конфига* \`${peerName}\`\n\n_Отсканируйте в приложении AmneziaVPN_`,
      parse_mode: 'Markdown' as const,
      reply_markup: BotUi.closeMediaKeyboard(),
    };
    const message = await ctx.replyWithDocument(file, options);
    logger.log(
      `QR ${peerName}: генерация ${generatedAt - startedAt}мс, ` +
        `отправка в Telegram ${Date.now() - generatedAt}мс`,
    );
    await peersService.setQrMessageId(peerName, message.message_id);
  } catch (error) {
    logger.error(`Ошибка генерации QR: ${error}`);
    await ctx
      .answerCallbackQuery({
        text: 'Ошибка генерации QR-кода',
        show_alert: true,
      })
      .catch(() => {});
  }
}

export async function sendPeerConfigFileMessage(
  ctx: Context,
  peersService: PeersService,
  peerName: string,
  logger: Logger,
): Promise<void> {
  if (!ctx.chat) return;

  try {
    const startedAt = Date.now();
    const config = await peersService.getPeerConfigString(peerName);
    const builtAt = Date.now();

    const message = await ctx.replyWithDocument(
      new InputFile(Buffer.from(config), `${peerName}.conf`),
      {
        caption: `📄 *Файл конфига* \`${peerName}\`\n\n_Импортируйте в приложение AmneziaVPN_`,
        parse_mode: 'Markdown',
        reply_markup: BotUi.closeMediaKeyboard(),
      },
    );
    logger.log(
      `Файл ${peerName}: сборка конфига ${builtAt - startedAt}мс, ` +
        `отправка в Telegram ${Date.now() - builtAt}мс`,
    );
    await peersService.setFileMessageId(peerName, message.message_id);
  } catch (error) {
    logger.error(`Ошибка отправки файла конфига: ${error}`);
    await ctx
      .answerCallbackQuery({
        text: 'Ошибка получения файла конфига',
        show_alert: true,
      })
      .catch(() => {});
  }
}

/**
 * Закрыть сообщение с QR/файлом: карточка конфига уже есть выше, поэтому нового
 * сообщения не создаём — иначе в чате оставался бы дубликат меню.
 */
export async function closeMediaMessage(ctx: Context): Promise<void> {
  await ctx.deleteMessage().catch(() => {
    // Сообщение уже удалено или старше 48 ч — Telegram удалить не даст
  });
}
