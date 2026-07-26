"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var XrayAccessLogWatcherService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.XrayAccessLogWatcherService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const fs_1 = require("fs");
const readline_1 = require("readline");
const xray_service_1 = require("../xray/xray.service");
const device_limit_service_1 = require("./device-limit.service");
const LOG_LINE_RE = /from (\S+?):\d+ accepted .*\[reality-direct[^\]]*\].*email: (\S+)/;
const MAX_LOG_SIZE_BYTES = 20 * 1024 * 1024;
let XrayAccessLogWatcherService = XrayAccessLogWatcherService_1 = class XrayAccessLogWatcherService {
    xrayService;
    deviceLimitService;
    logger = new common_1.Logger(XrayAccessLogWatcherService_1.name);
    lastOffset = 0;
    running = false;
    constructor(xrayService, deviceLimitService) {
        this.xrayService = xrayService;
        this.deviceLimitService = deviceLimitService;
    }
    async tick() {
        if (this.running)
            return;
        this.running = true;
        try {
            await this.processNewLines();
        }
        catch (error) {
            this.logger.error(`Ошибка обработки access-log: ${error instanceof Error ? error.message : error}`);
        }
        finally {
            this.running = false;
        }
    }
    async processNewLines() {
        const logPath = this.xrayService.getAccessLogPath();
        if (!(0, fs_1.existsSync)(logPath))
            return;
        let size;
        try {
            size = (0, fs_1.statSync)(logPath).size;
        }
        catch {
            return;
        }
        if (size < this.lastOffset) {
            this.lastOffset = 0;
        }
        if (size > MAX_LOG_SIZE_BYTES) {
            try {
                (0, fs_1.truncateSync)(logPath, 0);
            }
            catch (error) {
                this.logger.warn(`Не удалось усечь access-log: ${error instanceof Error ? error.message : error}`);
            }
            this.lastOffset = 0;
            return;
        }
        if (size <= this.lastOffset)
            return;
        const start = this.lastOffset;
        this.lastOffset = size;
        const stream = (0, fs_1.createReadStream)(logPath, { start, end: size - 1 });
        stream.on('error', (error) => {
            this.logger.warn(`Не удалось прочитать access-log: ${error instanceof Error ? error.message : error}`);
        });
        const rl = (0, readline_1.createInterface)({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
            const match = LOG_LINE_RE.exec(line);
            if (!match)
                continue;
            const [, ip, peerName] = match;
            try {
                await this.deviceLimitService.recordSighting(peerName, ip);
            }
            catch (error) {
                this.logger.error(`recordSighting(${peerName}, ${ip}) упал: ${error instanceof Error ? error.message : error}`);
            }
        }
    }
};
exports.XrayAccessLogWatcherService = XrayAccessLogWatcherService;
__decorate([
    (0, schedule_1.Interval)(30_000),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], XrayAccessLogWatcherService.prototype, "tick", null);
exports.XrayAccessLogWatcherService = XrayAccessLogWatcherService = XrayAccessLogWatcherService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [xray_service_1.XrayService,
        device_limit_service_1.DeviceLimitService])
], XrayAccessLogWatcherService);
//# sourceMappingURL=xray-access-log-watcher.service.js.map