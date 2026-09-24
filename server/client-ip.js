/**
 * OpenVibe.Media — who the client is.
 *
 * Media sits behind nginx on the same host (deploy/nginx/openvibe.media.conf), which sets
 * X-Forwarded-For / X-Real-IP / CF-Connecting-IP from its own $remote_addr. Only that loopback peer
 * is trusted (Express 'trust proxy' = loopback): req.ip is the forwarded address when the request
 * came through the local proxy and the socket address otherwise, so a caller that reaches the port
 * directly cannot choose its IP by sending the headers itself. Code reads req.ip, never the headers.
 */
'use strict';

const TRUST_PROXY = 'loopback';

/** The client's address as Express resolved it under TRUST_PROXY. */
function clientIp(req) {
    return String((req && (req.ip || (req.socket && req.socket.remoteAddress))) || 'unknown');
}

module.exports = { TRUST_PROXY, clientIp };
