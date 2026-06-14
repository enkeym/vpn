import { Injectable } from '@nestjs/common';

/** Координаты сообщения с главным меню (для редактирования вместо нового reply) */
export interface MainMenuAnchor {
  chatId: number;
  messageId: number;
}

/**
 * Единое хранилище «якорей» главного меню по пользователям.
 * Используется и презентером меню, и сервисом счетов, поэтому вынесено отдельно.
 */
@Injectable()
export class MainMenuAnchorStore {
  private readonly anchors = new Map<string, MainMenuAnchor>();

  get(telegramId: string): MainMenuAnchor | undefined {
    return this.anchors.get(telegramId);
  }

  set(telegramId: string, anchor: MainMenuAnchor): void {
    this.anchors.set(telegramId, anchor);
  }

  delete(telegramId: string): void {
    this.anchors.delete(telegramId);
  }
}
