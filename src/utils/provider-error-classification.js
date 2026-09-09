const TRANSIENT_HTTP_STATUSES = new Set([
    408, 429, 502, 503, 504, 520, 521, 522, 523, 524
]);

const TRANSIENT_NETWORK_CODES = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ENOTFOUND',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'EPIPE',
    'EAI_AGAIN',
    'ECONNABORTED',
    'ESOCKETTIMEDOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'HEALTH_CHECK_TIMEOUT',
    'ABORTED'
]);

const TRANSIENT_MESSAGE_MARKERS = [
    'health check timed out',
    'socket hang up',
    'fetch failed',
    'econnreset',
    'etimedout',
    'enotfound',
    'econnrefused',
    'und_err_'
];
const TRANSIENT_STATUS_IN_MESSAGE = /\b(408|429|502|503|504|520|521|522|523|524)\b/;
const ABORTED_MESSAGE = /\baborted\b/;

function getHttpStatus(error) {
    const candidates = [
        error?.response?.status,
        error?.statusCode,
        error?.status
    ];
    for (const value of candidates) {
        const num = parseInt(value, 10);
        if (!Number.isNaN(num) && num >= 100 && num < 600) {
            return num;
        }
    }
    return null;
}

export function isTransientProviderJitterError(error) {
    if (error == null || error === false) return false;
    if (typeof error === 'string') {
        return isTransientProviderJitterError({ message: error });
    }
    if (typeof error !== 'object') return false;

    const status = getHttpStatus(error);
    if (status === 401 || status === 403) return false;
    if (TRANSIENT_HTTP_STATUSES.has(status)) return true;

    const code = String(error.code || '').toUpperCase();
    if (TRANSIENT_NETWORK_CODES.has(code)) return true;

    const message = String(error.message || '').toLowerCase();
    if (TRANSIENT_STATUS_IN_MESSAGE.test(message) || ABORTED_MESSAGE.test(message)) return true;
    return TRANSIENT_MESSAGE_MARKERS.some(marker => message.includes(marker));
}
