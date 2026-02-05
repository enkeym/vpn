import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as schema from '../database/schema';
import { DRIZZLE } from 'src/database/database.module';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { desc, eq } from 'drizzle-orm';

export type TFamilyMember = typeof schema.familyMembers.$inferSelect;

@Injectable()
export class FamilyService {
  private readonly logger = new Logger(FamilyService.name);

  constructor(
    @Inject(DRIZZLE) private db: BetterSQLite3Database<typeof schema>,
  ) {}

  /**
   * Добавление члена группы по telegramId
   * displayName опционален - если не указан, будет использован telegramId
   */
  async addMember(
    addedBy: string,
    telegramId: string,
    displayName?: string,
  ): Promise<TFamilyMember> {
    // Проверяем, нет ли уже такого пользователя
    const existingById = await this.db.query.familyMembers.findFirst({
      where: eq(schema.familyMembers.telegramId, telegramId),
    });
    if (existingById) {
      throw new Error('Пользователь с таким ID уже в группе');
    }

    const [member] = await this.db
      .insert(schema.familyMembers)
      .values({
        telegramId,
        displayName: displayName || null,
        addedBy,
      })
      .returning();

    const name = displayName || telegramId;
    this.logger.log(`Добавлен член группы: ${name}`);
    return member;
  }

  async removeMemberById(memberId: string): Promise<void> {
    await this.db
      .delete(schema.familyMembers)
      .where(eq(schema.familyMembers.id, memberId));

    this.logger.log(`Удален член группы: ${memberId}`);
  }

  /**
   * Поиск члена группы по ID (поддерживает как полный UUID, так и сокращённый)
   */
  async findMemberById(memberId: string): Promise<TFamilyMember> {
    // Сначала пробуем найти по полному ID
    let member = await this.db.query.familyMembers.findFirst({
      where: eq(schema.familyMembers.id, memberId),
    });

    // Если не нашли и ID короткий, ищем по prefix
    if (!member && memberId.length < 36) {
      const members = await this.db.query.familyMembers.findMany();
      member = members.find((m) => m.id.startsWith(memberId));
    }

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

  /**
   * Проверка доступа: только по telegramId
   */
  async isMember(telegramId: string): Promise<boolean> {
    const byId = await this.findMemberByTelegramId(telegramId);
    return !!byId;
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
   * Поддерживает как полный ID, так и сокращённый (первые 8 символов)
   */
  async isMemberOwnedByAdmin(memberId: string, adminId: string): Promise<boolean> {
    // Сначала пробуем найти по полному ID
    let member = await this.db.query.familyMembers.findFirst({
      where: eq(schema.familyMembers.id, memberId),
    });

    // Если не нашли, ищем по partial ID
    if (!member && memberId.length < 36) {
      const members = await this.db.query.familyMembers.findMany();
      member = members.find((m) => m.id.startsWith(memberId));
    }

    return member?.addedBy === adminId;
  }

  /**
   * Обновить displayName участника
   */
  async updateDisplayName(memberId: string, displayName: string): Promise<void> {
    await this.db
      .update(schema.familyMembers)
      .set({ displayName })
      .where(eq(schema.familyMembers.id, memberId));

    this.logger.log(`Обновлено имя участника ${memberId}: ${displayName}`);
  }

  /**
   * Получить отображаемое имя участника
   */
  getDisplayName(member: TFamilyMember): string {
    return member.displayName || member.telegramId;
  }
}
