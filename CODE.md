     private registerCommands() {
       this.bot.command('start', async (ctx) => this.showMainMenu(ctx));

       // Обработка кнопки "Назад в меню"
       this.bot.callbackQuery('main_menu', async (ctx) => {
         await ctx.answerCallbackQuery();
         await this.showMainMenu(ctx);
       });

       this.bot.callbackQuery('create_config', async (ctx) => {
         await ctx.answerCallbackQuery();
         await this.handleCreateConfig(ctx);
       });

       this.bot.callbackQuery('list_configs', async (ctx) => {
         await ctx.answerCallbackQuery();
         await this.showConfigsList(ctx);
       });

       this.bot.callbackQuery(/^manage_peer:(.+)$/, async (ctx) => {
         await ctx.answerCallbackQuery();
         const peerName = ctx.match[1];
         await this.showPeerDetails(ctx, peerName);
       });

       this.bot.callbackQuery(/^toggle_peer:(.+)$/, async (ctx) => {
         const peerName = ctx.match[1];
         await this.togglePeer(ctx, peerName);
         await ctx.answerCallbackQuery('Статус изменен');
       });

       this.bot.callbackQuery(/^delete_peer:(.+)$/, async (ctx) => {
         const peerName = ctx.match[1];
         await this.deletePeer(ctx, peerName);
         await ctx.answerCallbackQuery('Конфиг удален');
       });
     }

     // --- Методы UI ---

     private async showMainMenu(ctx: Context) {
       const keyboard = new InlineKeyboard()
         .text('🆕 Создать конфиг', 'create_config')
         .row()
         .text('📂 Мои конфиги', 'list_configs');

       const text = '👋 *VPN Manager*\n\nВыберите действие:';

       try {
         await ctx.editMessageText(text, {
           reply_markup: keyboard,
           parse_mode: 'Markdown',
         });
       } catch {
         await ctx.reply(text, { reply_markup: keyboard, parse_mode: 'Markdown' });
       }
     }

     private async handleCreateConfig(ctx: Context) {
       if (!ctx.from) return;

       try {
         await ctx.editMessageText('⏳ *Создаю конфигурацию...*', {
           parse_mode: 'Markdown',
         });

         const { config, peer } = await this.peersService.createPeer({
           telegramId: String(ctx.from.id),
           username: ctx.from.username,
         });

         await ctx.replyWithDocument(
           new InputFile(Buffer.from(config), `${peer.name}.conf`),
           {
             caption: `✅ Конфиг *${peer.name}* создан!\nIP: \`${peer.ip}\``,
             parse_mode: 'Markdown',
           },
         );

         await this.showMainMenu(ctx);
       } catch (error) {
         this.logger.error(error);
         const errorMsg = error instanceof Error ? error.message : String(error);
         await ctx.editMessageText(`❌ *Ошибка:* ${errorMsg}`, {
           parse_mode: 'Markdown',
           reply_markup: new InlineKeyboard().text('⬅️ В меню', 'main_menu'),
         });
       }
     }

     private async showConfigsList(ctx: Context) {
       if (!ctx.from) return;

       const peers = await this.peersService.getPeersByTelegramId(
         String(ctx.from.id),
       );

       if (peers.length === 0) {
         return ctx.editMessageText('📂 *У вас пока нет активных конфигураций.*', {
           parse_mode: 'Markdown',
           reply_markup: new InlineKeyboard()
             .text('🆕 Создать', 'create_config')
             .row()
             .text('⬅️ Назад', 'main_menu'),
         });
       }

       const keyboard = new InlineKeyboard();
       peers.forEach((peer) => {
         const statusIcon = peer.paused ? '🔴' : '🟢';
         keyboard
           .text(`${statusIcon} ${peer.name} (${peer.ip})`, `manage_peer:${peer.name}`)
           .row();
       });
       keyboard.text('⬅️ Назад в меню', 'main_menu');

       await ctx.editMessageText(`📂 *Ваши конфигурации (${peers.length}):*`, {
         reply_markup: keyboard,
         parse_mode: 'Markdown',
       });
     }

     private async showPeerDetails(ctx: Context, peerName: string) {
       try {
         const peer = await this.peersService.findPeer(peerName);

         const status = peer.paused ? '🔴 Приостановлен' : '🟢 Активен';
         const toggleBtnText = peer.paused ? '▶️ Включить' : '⏸️ Пауза';

         const keyboard = new InlineKeyboard()
           .text(toggleBtnText, `toggle_peer:${peerName}`)
           .text('🗑️ Удалить', `delete_peer:${peerName}`)
           .row()
           .text('⬅️ К списку', 'list_configs');

         const text =
           `⚙️ *Управление конфигом*\n\n` +
           `🏷 Имя: \`${peer.name}\`\n` +
           `🌐 IP: \`${peer.ip}\`\n` +
           `📊 Статус: ${status}\n` +
           `📅 Создан: ${peer.createdAt ? new Date(peer.createdAt).toLocaleDateString() : 'Неизвестно'}`;

         await ctx.editMessageText(text, {
           reply_markup: keyboard,
           parse_mode: 'Markdown',
         });
       } catch (error) {
         await ctx.answerCallbackQuery({
           text: 'Конфиг не найден',
           show_alert: true,
         });
         await this.showConfigsList(ctx);
       }
     }

     private async togglePeer(ctx: Context, peerName: string) {
       try {
         await this.peersService.updatedPeer(peerName);
         await this.showPeerDetails(ctx, peerName);
       } catch (error) {
         this.logger.error(`Ошибка переключения: ${error}`);
         await ctx.answerCallbackQuery({
           text: 'Ошибка изменения статуса',
           show_alert: true,
         });
       }
     }

     private async deletePeer(ctx: Context, peerName: string) {
       try {
         await this.peersService.deletePeer(peerName);
         await ctx.answerCallbackQuery({ text: 'Конфиг удален' });
         await this.showConfigsList(ctx);
       } catch (error) {
         this.logger.error(`Ошибка удаления: ${error}`);
         await ctx.answerCallbackQuery({
           text: 'Ошибка удаления',
           show_alert: true,
         });
       }
     }
