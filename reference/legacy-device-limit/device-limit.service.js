"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var DeviceLimitService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeviceLimitService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const schedule_1 = require("@nestjs/schedule");
const drizzle_orm_1 = require("drizzle-orm");
const schema = __importStar(require("../database/schema"));
const database_module_1 = require("../database/database.module");
const notification_service_1 = require("../notification/notification.service");
const ip_range_check_1 = __importDefault(require("ip-range-check"));
const PRIMARY_STALE_MS = 5 * 60_000;
const OVERLAP_THRESHOLD_MS = 5 * 60_000;
const MIN_CHALLENGER_SIGHTINGS = 3;
const MAX_AUTO_BANS_PER_DAY_DEFAULT = 3;
const STATE_ENTRY_TTL_MS = 30 * 60_000;
function parsePositiveInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
function isValidIp(ip) {
    return /^[0-9a-fA-F:.%]{2,45}$/.test(ip);
}
let DeviceLimitService = DeviceLimitService_1 = class DeviceLimitService {
    db;
    configService;
    notificationService;
    logger = new common_1.Logger(DeviceLimitService_1.name);
    enabled;
    banMinutes;
    maxAutoBansPerDay;
    whitelistCidrs;
    state = new Map();
    constructor(db, configService, notificationService) {
        this.db = db;
        this.configService = configService;
        this.notificationService = notificationService;
        this.enabled =
            this.configService.get('DEVICE_LIMIT_ENABLED', 'false') ===
                'true';
        this.banMinutes = parsePositiveInt(this.configService.get('DEVICE_LIMIT_BAN_MINUTES'), 60);
        this.maxAutoBansPerDay = parsePositiveInt(this.configService.get('DEVICE_LIMIT_MAX_BANS_PER_DAY'), MAX_AUTO_BANS_PER_DAY_DEFAULT);
        this.whitelistCidrs = this.configService
            .get('DEVICE_LIMIT_WHITELIST_CIDRS', '')
            .split(',')
            .map((cidr) => cidr.trim())
            .filter((cidr) => cidr.length > 0);
    }
    isWhitelisted(ip) {
        if (this.whitelistCidrs.length === 0)
            return false;
        try {
            return (0, ip_range_check_1.default)(ip, this.whitelistCidrs);
        }
        catch {
            return false;
        }
    }
    async recordSighting(peerName, ip) {
        if (!this.enabled || !ip || !peerName || !isValidIp(ip))
            return;
        if (this.isWhitelisted(ip)) {
            return;
        }
        const now = Date.now();
        const existing = this.state.get(peerName);
        if (!existing || existing.primaryIp === ip) {
            this.state.set(peerName, { primaryIp: ip, primaryLastSeenAt: now });
            return;
        }
        const primaryIsStale = now - existing.primaryLastSeenAt > PRIMARY_STALE_MS;
        if (primaryIsStale) {
            this.state.set(peerName, { primaryIp: ip, primaryLastSeenAt: now });
            return;
        }
        if (existing.challengerIp !== ip) {
            existing.challengerIp = ip;
            existing.challengerFirstSeenAt = now;
            existing.challengerSightings = 1;
            return;
        }
        existing.challengerSightings = (existing.challengerSightings ?? 0) + 1;
        const overlapMs = now - (existing.challengerFirstSeenAt ?? now);
        if (overlapMs < OVERLAP_THRESHOLD_MS ||
            existing.challengerSightings < MIN_CHALLENGER_SIGHTINGS) {
            return;
        }
        await this.flagSecondDevice(peerName, ip);
        existing.challengerIp = undefined;
        existing.challengerFirstSeenAt = undefined;
        existing.challengerSightings = undefined;
    }
    async recentAutoBanCount(peerName) {
        const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);
        const recent = await this.db.query.peerIpBans.findMany({
            where: (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema.peerIpBans.peerName, peerName), (0, drizzle_orm_1.gte)(schema.peerIpBans.bannedAt, dayAgo)),
            columns: { id: true },
        });
        return recent.length;
    }
    async flagSecondDevice(peerName, ip) {
        if (await this.hasActiveFlag(peerName)) {
            return;
        }
        if ((await this.recentAutoBanCount(peerName)) >= this.maxAutoBansPerDay) {
            this.logger.warn(`Лимит уведомлений: конфиг "${peerName}" уже уведомлялся ${this.maxAutoBansPerDay}+ раз за 24ч — пропускаю`);
            return;
        }
        const expiresAt = new Date(Date.now() + this.banMinutes * 60_000);
        try {
            await this.db
                .insert(schema.peerIpBans)
                .values({ peerName, ip, expiresAt });
        }
        catch (error) {
            this.logger.error(`Не удалось записать обнаружение для "${peerName}" (${ip}): ${error instanceof Error ? error.message : error}`);
            return;
        }
        this.logger.warn(`Обнаружено второе устройство на конфиге "${peerName}" (IP ${ip}) — уведомление владельцу отправлено, бан НЕ применялся`);
        await this.notifyOwner(peerName);
    }
    async hasActiveFlag(peerName) {
        const active = await this.db.query.peerIpBans.findFirst({
            where: (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema.peerIpBans.peerName, peerName), (0, drizzle_orm_1.gt)(schema.peerIpBans.expiresAt, new Date())),
            columns: { id: true },
        });
        return !!active;
    }
    async notifyOwner(peerName) {
        try {
            const peer = await this.db.query.peers.findFirst({
                where: (0, drizzle_orm_1.eq)(schema.peers.name, peerName),
                columns: { telegramId: true },
            });
            if (!peer?.telegramId)
                return;
            await this.notificationService.notifyUser(peer.telegramId, 'Обнаружено второе устройство', 'Похоже, вы пользуетесь одной ссылкой сразу на нескольких устройствах.\n\n' +
                'Одна ссылка рассчитана на одно устройство. Чтобы подключить ещё одно, ' +
                'оформите вторую ссылку в боте — так VPN будет работать стабильно на всех устройствах.');
        }
        catch (error) {
            this.logger.error(`Не удалось уведомить владельца конфига "${peerName}": ${error instanceof Error ? error.message : error}`);
        }
    }
    pruneStaleState() {
        const cutoff = Date.now() - STATE_ENTRY_TTL_MS;
        for (const [peerName, st] of this.state) {
            const lastActivity = Math.max(st.primaryLastSeenAt, st.challengerFirstSeenAt ?? 0);
            if (lastActivity < cutoff) {
                this.state.delete(peerName);
            }
        }
    }
    cleanupState() {
        if (!this.enabled)
            return;
        this.pruneStaleState();
    }
    async listActiveBans() {
        const bans = await this.db.query.peerIpBans.findMany({
            where: (0, drizzle_orm_1.gt)(schema.peerIpBans.expiresAt, new Date()),
            orderBy: (t, { desc }) => [desc(t.bannedAt)],
        });
        if (bans.length === 0)
            return [];
        const peerNames = [...new Set(bans.map((b) => b.peerName))];
        const owners = await this.db.query.peers.findMany({
            where: (0, drizzle_orm_1.inArray)(schema.peers.name, peerNames),
            columns: { name: true, telegramId: true, username: true },
        });
        const ownerByName = new Map(owners.map((o) => [o.name, o]));
        return bans.map((ban) => {
            const owner = ownerByName.get(ban.peerName);
            return {
                id: ban.id,
                peerName: ban.peerName,
                ip: ban.ip,
                bannedAt: ban.bannedAt,
                expiresAt: ban.expiresAt,
                telegramId: owner?.telegramId ?? null,
                username: owner?.username ?? null,
            };
        });
    }
    async unban(banId) {
        const ban = await this.db.query.peerIpBans.findFirst({
            where: (0, drizzle_orm_1.eq)(schema.peerIpBans.id, banId),
        });
        if (!ban)
            return false;
        await this.db
            .update(schema.peerIpBans)
            .set({ expiresAt: new Date() })
            .where((0, drizzle_orm_1.eq)(schema.peerIpBans.id, banId));
        return true;
    }
};
exports.DeviceLimitService = DeviceLimitService;
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_5_MINUTES),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], DeviceLimitService.prototype, "cleanupState", null);
exports.DeviceLimitService = DeviceLimitService = DeviceLimitService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(database_module_1.DRIZZLE)),
    __metadata("design:paramtypes", [Function, config_1.ConfigService,
        notification_service_1.NotificationService])
], DeviceLimitService);
//# sourceMappingURL=device-limit.service.js.map