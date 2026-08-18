import crypto from 'crypto';
import { matchesModelFamily } from '../providers/openai/codex-model-routing.js';

const FULL_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const CODEX_ENDPOINT_PATHS = new Map([
    ['/v1/responses', '/v1/responses'],
    ['/openai-codex-oauth/v1/responses', '/v1/responses'],
    ['/v1/chat/completions', '/v1/chat/completions'],
    ['/openai-codex-oauth/v1/chat/completions', '/v1/chat/completions']
]);

const scheduleDiagnostics = {
    scheduledBypasses: 0,
    missingCalendarYears: new Set()
};

export function recordTemporaryRouteScheduleBypass(scheduleBypass) {
    if (!scheduleBypass || typeof scheduleBypass !== 'object') return;
    scheduleDiagnostics.scheduledBypasses += 1;
    if (scheduleBypass.calendarDegraded === true && Number.isInteger(Number(scheduleBypass.calendarYear))) {
        scheduleDiagnostics.missingCalendarYears.add(Number(scheduleBypass.calendarYear));
    }
}

export function getTemporaryRouteScheduleDiagnostics() {
    const missingCalendarYears = [...scheduleDiagnostics.missingCalendarYears].sort((a, b) => a - b);
    return {
        scheduledBypasses: scheduleDiagnostics.scheduledBypasses,
        calendarDegraded: missingCalendarYears.length > 0,
        missingCalendarYears
    };
}

export function resetTemporaryRouteScheduleDiagnosticsForTests() {
    scheduleDiagnostics.scheduledBypasses = 0;
    scheduleDiagnostics.missingCalendarYears.clear();
}

export function hashTemporaryRouteKey(value) {
    if (!value) return null;
    return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

function safelyEqualHash(expected, actual) {
    if (!FULL_SHA256_PATTERN.test(String(expected || ''))) return false;
    const expectedBuffer = Buffer.from(String(expected).toLowerCase());
    const actualBuffer = Buffer.from(String(actual || '').toLowerCase());
    return expectedBuffer.length === actualBuffer.length
        && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function matchesConfiguredModel(rule, model) {
    const exactModels = Array.isArray(rule?.models) ? rule.models : [];
    if (exactModels.includes(model)) return true;
    const modelFamilies = Array.isArray(rule?.modelFamilies) ? rule.modelFamilies : [];
    return modelFamilies.some(family => matchesModelFamily(model, family));
}

function normalizeTemporaryRoutePath(value) {
    return CODEX_ENDPOINT_PATHS.get(String(value || '')) || null;
}

function matchesConfiguredPath(rule, requestPath) {
    const normalizedRequestPath = normalizeTemporaryRoutePath(requestPath);
    if (!normalizedRequestPath || !Array.isArray(rule?.paths)) return false;
    return rule.paths.some(path => normalizeTemporaryRoutePath(path) === normalizedRequestPath);
}

function matchesSourceProvider(rule, originalProviderType) {
    const configured = Array.isArray(rule?.sourceProviderTypes)
        ? rule.sourceProviderTypes.filter(Boolean).map(String)
        : [];
    return configured.length === 0 || configured.includes(String(originalProviderType || ''));
}

function parseClockMinutes(value) {
    const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
}

function getZonedDateTimeParts(value, timezone) {
    const date = value instanceof Date ? value : new Date(value ?? Date.now());
    if (Number.isNaN(date.getTime())) return null;
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23'
        }).formatToParts(date);
        const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
        const year = Number(values.year);
        const month = Number(values.month);
        const day = Number(values.day);
        const hour = Number(values.hour);
        const minute = Number(values.minute);
        if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
        return {
            year,
            dateKey: `${values.year}-${values.month}-${values.day}`,
            weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
            minuteOfDay: hour * 60 + minute
        };
    } catch {
        return null;
    }
}

function resolveConfiguredWorkday(config, calendarName, dateParts) {
    const calendar = config?.workdayCalendars?.[calendarName];
    const yearConfig = calendar?.years?.[String(dateParts.year)] || calendar?.years?.[dateParts.year];
    if (!yearConfig) {
        return {
            isWorkday: dateParts.weekday >= 1 && dateParts.weekday <= 5,
            calendarDegraded: true
        };
    }
    const holidays = new Set(Array.isArray(yearConfig.holidays) ? yearConfig.holidays.map(String) : []);
    const makeupWorkdays = new Set(Array.isArray(yearConfig.makeupWorkdays) ? yearConfig.makeupWorkdays.map(String) : []);
    if (makeupWorkdays.has(dateParts.dateKey)) {
        return { isWorkday: true, calendarDegraded: false };
    }
    if (holidays.has(dateParts.dateKey)) {
        return { isWorkday: false, calendarDegraded: false };
    }
    return {
        isWorkday: dateParts.weekday >= 1 && dateParts.weekday <= 5,
        calendarDegraded: false
    };
}

function resolveTargetBlackout(rule, config, model, now) {
    const blackout = rule?.targetBlackout;
    if (!blackout || !matchesConfiguredModel(blackout, model)) return null;
    const startMinutes = parseClockMinutes(blackout.start);
    const endMinutes = parseClockMinutes(blackout.end);
    if (startMinutes === null || endMinutes === null || startMinutes >= endMinutes) return null;
    const timezone = String(blackout.timezone || 'Asia/Shanghai');
    const dateParts = getZonedDateTimeParts(now, timezone);
    if (!dateParts) return null;
    const calendarName = String(blackout.calendar || '');
    if (!calendarName) return null;
    const workday = resolveConfiguredWorkday(config, calendarName, dateParts);
    if (!workday.isWorkday) return null;
    if (dateParts.minuteOfDay < startMinutes || dateParts.minuteOfDay >= endMinutes) return null;
    if (!blackout.fallbackProviderType || !blackout.fallbackModel) return null;
    return {
        reason: 'scheduled_blackout',
        targetAttempted: false,
        fallbackProviderType: String(blackout.fallbackProviderType),
        fallbackModel: String(blackout.fallbackModel),
        calendarDegraded: workday.calendarDegraded,
        calendarYear: dateParts.year
    };
}

export function resolveTemporaryKeyModelRoute({
    config,
    apiKey,
    requestPath,
    model,
    originalProviderType,
    now = new Date()
}) {
    if (!apiKey || !requestPath || !model) return null;
    const keyHash = hashTemporaryRouteKey(apiKey);
    const rules = Array.isArray(config?.temporaryKeyModelRoutes)
        ? config.temporaryKeyModelRoutes
        : [];

    for (const rule of rules) {
        if (!rule || rule.enabled !== true) continue;
        if (!safelyEqualHash(rule.keyHash, keyHash)) continue;
        if (!matchesConfiguredPath(rule, requestPath)) continue;
        if (!matchesSourceProvider(rule, originalProviderType)) continue;
        if (!matchesConfiguredModel(rule, model)) continue;
        if (!rule.targetProviderType || !rule.targetModel) continue;

        const scheduleBypass = resolveTargetBlackout(rule, config, model, now);
        return {
            id: String(rule.id || 'temporary-key-model-route'),
            keyHash,
            requestedModel: model,
            originalProviderType,
            targetProviderType: String(rule.targetProviderType),
            targetModel: String(rule.targetModel),
            fallbackToOriginal: rule.fallbackToOriginal === true,
            preserveResponseModel: rule.preserveResponseModel === true,
            ...(scheduleBypass ? { scheduleBypass } : {})
        };
    }

    return null;
}

export function preserveTemporaryRouteResponseModel(value, requestedModel) {
    if (!value || typeof value !== 'object' || !requestedModel) return value;
    if (Array.isArray(value)) {
        return value.map(item => preserveTemporaryRouteResponseModel(item, requestedModel));
    }

    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
        key,
        key === 'model'
            ? requestedModel
            : preserveTemporaryRouteResponseModel(child, requestedModel)
    ]));
}
