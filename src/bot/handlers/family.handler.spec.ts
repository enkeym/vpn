import { Context } from 'grammy';
import { FamilyService } from 'src/family/family.service';
import { PeersService } from 'src/peers/peers.service';
import { BotUi } from '../ui/bot.ui';
import { FamilyHandler } from './family.handler';
import { MainHandler } from './main.handler';

describe('FamilyHandler admin guards', () => {
  const addMember = jest.fn();
  const findMemberById = jest.fn();
  const removeMemberById = jest.fn();
  const getMembersByAdmin = jest.fn();
  const isMemberOwnedByAdmin = jest.fn();
  const getPeersByTelegramId = jest.fn();
  const deletePeersByNames = jest.fn();
  const isAdmin = jest.fn();
  let handler: FamilyHandler;

  beforeEach(() => {
    jest.clearAllMocks();
    getMembersByAdmin.mockResolvedValue([]);
    isMemberOwnedByAdmin.mockResolvedValue(true);
    getPeersByTelegramId.mockResolvedValue([]);

    handler = new FamilyHandler(
      {
        addMember,
        findMemberById,
        removeMemberById,
        getMembersByAdmin,
        isMemberOwnedByAdmin,
      } as unknown as FamilyService,
      {
        getPeersByTelegramId,
        deletePeersByNames,
      } as unknown as PeersService,
      { isAdmin } as unknown as MainHandler,
    );
  });

  function createContext(text: string) {
    const reply = jest.fn().mockResolvedValue({ message_id: 42 });
    const ctx = {
      from: { id: 100 },
      message: { message_id: 5, text },
      chat: { id: 777 },
      api: { deleteMessage: jest.fn().mockResolvedValue(true) },
      editMessageText: jest.fn().mockResolvedValue(true),
      answerCallbackQuery: jest.fn().mockResolvedValue(true),
      reply,
    } as unknown as Context;
    return { ctx, reply };
  }

  it('rejects adding the administrator themselves by numeric id', async () => {
    const { ctx, reply } = createContext('100');

    await handler.handleAddMemberInput(ctx);

    expect(addMember).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      BotUi.cannotAddAdminSelf,
      expect.anything(),
    );
  });

  it('rejects adding another administrator by numeric id', async () => {
    isAdmin.mockImplementation((id: string) => id === '101');
    const { ctx, reply } = createContext('101');

    await handler.handleAddMemberInput(ctx);

    expect(addMember).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(BotUi.cannotAddAdmin, expect.anything());
  });

  it('removes only the membership of an administrator member', async () => {
    isAdmin.mockImplementation((id: string) => id === '101');
    findMemberById.mockResolvedValue({ id: 'member-1', telegramId: '101' });
    const { ctx } = createContext('');

    await handler.removeMember(ctx, 'member-1');

    expect(getPeersByTelegramId).not.toHaveBeenCalled();
    expect(deletePeersByNames).not.toHaveBeenCalled();
    expect(removeMemberById).toHaveBeenCalledWith('member-1');
  });
});
