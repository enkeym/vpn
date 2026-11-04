import { Logger } from '@nestjs/common';
import { Context, InputFile } from 'grammy';
import { PeersService } from 'src/peers/peers.service';
import { sendPeerQrCodeMessage } from './peer-media';

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
