import { Logger } from '@nestjs/common';
import { Api, Context, InputFile } from 'grammy';
import { PeersService, TPeer } from 'src/peers/peers.service';
import { sendCreatedPeerMessage, sendPeerQrCodeMessage } from './peer-media';

describe('sendCreatedPeerMessage', () => {
  const peer: TPeer = {
    telegramId: '123',
    name: 'peer-a',
    publicKey: 'test-public',
    privateKey: 'test-private',
    ip: '10.9.0.2',
    endpoint: 'direct.example.test:51820',
  };

  it('sends links instead of a file when the AWG config is empty', async () => {
    const sendMessage = jest.fn().mockResolvedValue({ message_id: 7 });
    const sendDocument = jest.fn();
    const api = {
      sendMessage,
      sendDocument,
    } as unknown as Api;
    const peersService = {
      getPeerVlessText: jest.fn().mockResolvedValue('`vless://peer-a`'),
    } as unknown as PeersService;

    const message = await sendCreatedPeerMessage(
      api,
      1,
      peersService,
      peer,
      '',
      '✅ Конфиг создан',
      false,
      'https://sub.example.test/sub/uuid',
    );

    expect(sendDocument).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      1,
      expect.stringContaining('vless://peer-a'),
      expect.objectContaining({ parse_mode: 'Markdown' }),
    );
    expect(sendMessage.mock.calls[0][1]).toContain(
      'https://sub.example.test/sub/uuid',
    );
    expect(message).toEqual({ message_id: 7 });
  });

  it('sends the AWG file when the config is present', async () => {
    const sendMessage = jest.fn();
    const sendDocument = jest.fn().mockResolvedValue({ message_id: 8 });
    const api = {
      sendMessage,
      sendDocument,
    } as unknown as Api;
    const peersService = {
      getPeerVlessText: jest.fn(),
    } as unknown as PeersService;

    await sendCreatedPeerMessage(
      api,
      1,
      peersService,
      peer,
      '[Interface]\nPrivateKey = test',
      '✅ Конфиг создан',
      false,
      'https://sub.example.test/sub/uuid',
    );

    expect(sendDocument).toHaveBeenCalledWith(
      1,
      expect.any(InputFile),
      expect.objectContaining({ caption: '✅ Конфиг создан' }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('sendPeerQrCodeMessage', () => {
  it('sends an AWG QR below the photo limit as the original PNG document', async () => {
    const qrBuffer = Buffer.alloc(24);
    qrBuffer.writeUInt32BE(1100, 16);
    const replyWithDocument = jest.fn().mockResolvedValue({ message_id: 42 });
    const replyWithPhoto = jest.fn();
    const setQrMessageId = jest.fn();
    const ctx = {
      chat: { id: 1 },
      replyWithDocument,
      replyWithPhoto,
    } as unknown as Context;
    const peersService = {
      generatePeerQrCode: jest.fn().mockResolvedValue(qrBuffer),
      setQrMessageId,
    } as unknown as PeersService;
    const logger = { log: jest.fn(), error: jest.fn() } as unknown as Logger;

    await sendPeerQrCodeMessage(ctx, peersService, 'peer-a', logger);

    expect(qrBuffer.readUInt32BE(16)).toBeLessThan(1280);
    expect(replyWithDocument).toHaveBeenCalledWith(
      expect.any(InputFile),
      expect.objectContaining({ parse_mode: 'Markdown' }),
    );
    expect(replyWithDocument.mock.calls[0][0]).toMatchObject({
      fileData: qrBuffer,
      filename: 'peer-a_qr.png',
    });
    expect(replyWithPhoto).not.toHaveBeenCalled();
    expect(setQrMessageId).toHaveBeenCalledWith('peer-a', 42);
  });
});
