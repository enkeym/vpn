import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as schema from '../database/schema';
import { DRIZZLE } from 'src/database/database.module';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { desc, eq, or } from 'drizzle-orm';

export type TFamilyMember = typeof schema.familyMembers.$inferSelect;

@Injectable()
export class FamilyService {
  private readonly logger = new Logger(FamilyService.name);

  constructor(
    @Inject(DRIZZLE) private db: BetterSQLite3Database<typeof schema>,
  ) {}

  /**
   * Добавление члена группы по username ИЛИ telegramId
   */
  async addMember(
    addedBy: string,
    options: { username?: string; telegramId?: string },
  ): Promise<TFamilyMember> {
    const { username, telegramId } = options;

    if (!username && !telegramId) {
      throw new Error('Нужно указать username или telegramId');
    }

    // Проверяем, нет ли уже такого пользователя
    if (telegramId) {
      const existingById = await this.db.query.familyMembers.findFirst({
        where: eq(schema.familyMembers.telegramId, telegramId),
      });
      if (existingById) {
        throw new Error('Пользователь с таким ID уже в группе');
      }
    }

    if (username) {
      const existingByUsername = await this.db.query.familyMembers.findFirst({
        where: eq(schema.familyMembers.username, username),
      });
      if (existingByUsername) {
        throw new Error('Пользователь с таким username уже в группе');
      }
    }

    const [member] = await this.db
      .insert(schema.familyMembers)
      .values({
        telegramId: telegramId || null,
        username: username || null,
        addedBy,
      })
      .returning();

    const displayName = username ? `@${username}` : telegramId;
    this.logger.log(`Добавлен член группы: ${displayName}`);
    return member;
  }

  async removeMemberById(memberId: string): Promise<void> {
    await this.db
      .delete(schema.familyMembers)
      .where(eq(schema.familyMembers.id, memberId));

    this.logger.log(`Удален член группы: ${memberId}`);
  }

  async findMemberById(memberId: string): Promise<TFamilyMember> {
    const member = await this.db.query.familyMembers.findFirst({
      where: eq(schema.familyMembers.id, memberId),
    });

    if (!member) {
      throw new NotFoundException(`Член группы не найден`);
    }

    return member;
  }

  async findMemberByTelegramId(
    telegramId: string,
  ): Promise<TFamilyMember | null> {
    const member = await this.db.query.familyMembers.findFirst({
      where: eq(schema.familyMembers.telegramId, telegramId),
    });
    return member ?? null;
  }

  async findMemberByUsername(username: string): Promise<TFamilyMember | null> {
    const member = await this.db.query.familyMembers.findFirst({
      where: eq(schema.familyMembers.username, username),
    });
    return member ?? null;
  }

  /**
   * Проверка доступа: по telegramId или username
   */
  async isMember(telegramId: string, username?: string): Promise<boolean> {
    // Сначала проверяем по telegramId
    const byId = await this.findMemberByTelegramId(telegramId);
    if (byId) return true;

    // Если не нашли по ID, проверяем по username
    if (username) {
      const byUsername = await this.findMemberByUsername(username);
      if (byUsername) return true;
    }

    return false;
  }

  /**
   * Привязка telegramId к записи, добавленной по username
   */
  async bindTelegramId(username: string, telegramId: string): Promise<void> {
    const member = await this.findMemberByUsername(username);
    if (!member) return;

    // Если telegramId уже привязан - ничего не делаем
    if (member.telegramId) return;

    await this.db
      .update(schema.familyMembers)
      .set({ telegramId })
      .where(eq(schema.familyMembers.id, member.id));

    this.logger.log(`Привязан telegramId ${telegramId} к @${username}`);
  }

  async getAllMembers(): Promise<TFamilyMember[]> {
    return await this.db.query.familyMembers.findMany({
      orderBy: [desc(schema.familyMembers.createdAt)],
    });
  }

  /**
   * Получить членов группы конкретного админа
   */
  async getMembersByAdmin(adminId: string): Promise<TFamilyMember[]> {
    return await this.db.query.familyMembers.findMany({
      where: eq(schema.familyMembers.addedBy, adminId),
      orderBy: [desc(schema.familyMembers.createdAt)],
    });
  }

  /**
   * Проверить, что член группы принадлежит админу
   */
  async isMemberOwnedByAdmin(memberId: string, adminId: string): Promise<boolean> {
    const member = await this.db.query.familyMembers.findFirst({
      where: eq(schema.familyMembers.id, memberId),
    });
    return member?.addedBy === adminId;
  }

  async updateMemberData(
    memberId: string,
    data: { username?: string | null; telegramId?: string | null },
  ): Promise<void> {
    await this.db
      .update(schema.familyMembers)
      .set(data)
      .where(eq(schema.familyMembers.id, memberId));
  }
}
