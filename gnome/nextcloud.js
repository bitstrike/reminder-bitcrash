// Nextcloud Login Flow v2 + CalDAV calendar discovery/fetch
// ES module for GNOME Shell 46 extension reminder@bitcrash

import Soup from 'gi://Soup';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Secret from 'gi://Secret';

const UUID = 'reminder@bitcrash';

const SCHEMA = new Secret.Schema(
    'org.cinnamon.applet.reminder.nextcloud',
    Secret.SchemaFlags.NONE,
    {server: Secret.SchemaAttributeType.STRING}
);

// ---- HTTP helpers ----

function _newSession() {
    const session = new Soup.Session();
    session.timeout = 30;
    return session;
}

function _syncRequest(session, method, url, headers, body) {
    const msg = Soup.Message.new(method, url);
    if (!msg) return null;
    if (headers) {
        for (const key in headers)
            msg.request_headers.append(key, headers[key]);
    }
    if (body) {
        const contentType = (headers && headers['Content-Type']) || 'application/xml';
        msg.set_request_body_from_bytes(contentType, new GLib.Bytes(body));
    }
    const bytes = session.send_and_read(msg, null);
    return {
        status: msg.get_status(),
        body: bytes ? new TextDecoder().decode(bytes.get_data()) : '',
    };
}

function _basicAuthHeader(user, password) {
    const encoded = GLib.base64_encode(user + ':' + password);
    return 'Basic ' + encoded;
}

// ---- Login Flow v2 ----

/**
 * Initiate Nextcloud Login Flow v2.
 * Returns { loginUrl, pollUrl, pollToken } or null on failure.
 */
export function loginFlowInit(serverUrl) {
    const session = _newSession();
    const url = serverUrl.replace(/\/+$/, '') + '/index.php/login/v2';
    const resp = _syncRequest(session, 'POST', url, {}, '');
    if (!resp || resp.status !== 200) return null;
    try {
        const data = JSON.parse(resp.body);
        return {
            loginUrl: data.login,
            pollUrl: data.poll.endpoint,
            pollToken: data.poll.token,
        };
    } catch (e) {
        console.error(`${UUID}: Login flow init parse error: ${e.message}`);
        return null;
    }
}

/**
 * Poll the login flow endpoint once.
 * Returns { server, loginName, appPassword } on success, null if pending, false on expired.
 */
export function loginFlowPoll(pollUrl, pollToken) {
    const session = _newSession();
    const body = 'token=' + encodeURIComponent(pollToken);
    const resp = _syncRequest(session, 'POST', pollUrl, {
        'Content-Type': 'application/x-www-form-urlencoded',
    }, body);
    if (!resp) return false;
    if (resp.status === 200) {
        try {
            const data = JSON.parse(resp.body);
            return {
                server: data.server,
                loginName: data.loginName,
                appPassword: data.appPassword,
            };
        } catch (_e) {
            return false;
        }
    }
    if (resp.status === 404) return null; // still waiting
    return false; // expired or error
}

// ---- Keyring ----

export function storeCredentials(serverUrl, loginName, appPassword) {
    const label = 'Nextcloud (' + loginName + '@' + serverUrl + ')';
    const value = JSON.stringify({loginName, appPassword});
    try {
        Secret.password_store_sync(
            SCHEMA,
            {server: serverUrl},
            Secret.COLLECTION_DEFAULT,
            label,
            value,
            null
        );
        return true;
    } catch (e) {
        console.error(`${UUID}: Failed to store credentials: ${e.message}`);
        return false;
    }
}

export function loadCredentials(serverUrl) {
    try {
        const value = Secret.password_lookup_sync(
            SCHEMA,
            {server: serverUrl},
            null
        );
        if (!value) return null;
        return JSON.parse(value);
    } catch (e) {
        console.error(`${UUID}: Failed to load credentials: ${e.message}`);
        return null;
    }
}

export function clearCredentials(serverUrl) {
    try {
        Secret.password_clear_sync(SCHEMA, {server: serverUrl}, null);
    } catch (e) {
        console.error(`${UUID}: Failed to clear credentials: ${e.message}`);
    }
}

/**
 * Revoke the app password on the Nextcloud server.
 * Best-effort - failures are logged but not fatal.
 */
export function revokeAppPassword(serverUrl, loginName, appPassword) {
    try {
        const session = _newSession();
        const base = serverUrl.replace(/\/+$/, '');
        const url = base + '/ocs/v2.php/core/apppassword';
        const resp = _syncRequest(session, 'DELETE', url, {
            'Authorization': _basicAuthHeader(loginName, appPassword),
            'OCS-APIREQUEST': 'true',
        }, null);
        if (resp && (resp.status === 200 || resp.status === 100)) return true;
        console.error(`${UUID}: Revoke app password returned status ${resp ? resp.status : 'null'}`);
    } catch (e) {
        console.error(`${UUID}: Failed to revoke app password: ${e.message}`);
    }
    return false;
}

// ---- CalDAV Discovery ----

/**
 * Discover calendars via PROPFIND.
 * Returns array of { displayName, href } or null on failure.
 */
export function discoverCalendars(serverUrl, loginName, appPassword) {
    const session = _newSession();
    const base = serverUrl.replace(/\/+$/, '');
    const url = base + '/remote.php/dav/calendars/' + encodeURIComponent(loginName) + '/';

    const body = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">',
        '  <d:prop>',
        '    <d:displayname/>',
        '    <d:resourcetype/>',
        '  </d:prop>',
        '</d:propfind>',
    ].join('\n');

    const resp = _syncRequest(session, 'PROPFIND', url, {
        'Content-Type': 'application/xml; charset=utf-8',
        'Depth': '1',
        'Authorization': _basicAuthHeader(loginName, appPassword),
    }, body);

    if (!resp || (resp.status !== 207 && resp.status !== 200)) {
        console.error(`${UUID}: PROPFIND failed, status=${resp ? resp.status : 'null'}`);
        return null;
    }

    const calendars = [];
    const responses = resp.body.split(/<d:response>/i);
    for (let i = 1; i < responses.length; i++) {
        const block = responses[i];
        if (!/<d:collection/i.test(block)) continue;
        const hrefMatch = block.match(/<d:href>([^<]+)<\/d:href>/i);
        const nameMatch = block.match(/<d:displayname>([^<]*)<\/d:displayname>/i);
        if (!hrefMatch) continue;
        const href = hrefMatch[1];
        if (href === '/remote.php/dav/calendars/' + encodeURIComponent(loginName) + '/') continue;
        // Skip Nextcloud internal collections
        if (/\/(inbox|trashbin|outbox)\/?$/i.test(href)) continue;
        const displayName = nameMatch ? nameMatch[1] : href.split('/').filter(s => s).pop();
        calendars.push({displayName, href});
    }
    return calendars;
}

// ---- CalDAV Event Fetching ----

/**
 * Fetch events from a calendar for a given date range.
 * Returns array of { uid, summary, description, dtstart, dtend, alarms } or null on failure.
 */
export function fetchEvents(serverUrl, loginName, appPassword, calendarHref, rangeStart, rangeEnd) {
    const session = _newSession();
    const origin = serverUrl.match(/^https?:\/\/[^/]+/)[0];
    const url = origin + calendarHref;

    function toIcalUtc(d) {
        return d.getUTCFullYear().toString() +
            ('0' + (d.getUTCMonth() + 1)).slice(-2) +
            ('0' + d.getUTCDate()).slice(-2) + 'T' +
            ('0' + d.getUTCHours()).slice(-2) +
            ('0' + d.getUTCMinutes()).slice(-2) +
            ('0' + d.getUTCSeconds()).slice(-2) + 'Z';
    }

    const rangeUtcStart = toIcalUtc(rangeStart);
    const rangeUtcEnd = toIcalUtc(rangeEnd);
    const authHeader = _basicAuthHeader(loginName, appPassword);

    // Query 1: Expanded - server resolves recurring events into individual occurrences
    const expandBody = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">',
        '  <d:prop>',
        '    <d:getetag/>',
        '    <c:calendar-data>',
        '      <c:expand start="' + rangeUtcStart + '" end="' + rangeUtcEnd + '"/>',
        '    </c:calendar-data>',
        '  </d:prop>',
        '  <c:filter>',
        '    <c:comp-filter name="VCALENDAR">',
        '      <c:comp-filter name="VEVENT">',
        '        <c:time-range start="' + rangeUtcStart + '" end="' + rangeUtcEnd + '"/>',
        '      </c:comp-filter>',
        '    </c:comp-filter>',
        '  </c:filter>',
        '</c:calendar-query>',
    ].join('\n');

    const resp = _syncRequest(session, 'REPORT', url, {
        'Content-Type': 'application/xml; charset=utf-8',
        'Depth': '1',
        'Authorization': authHeader,
    }, expandBody);

    if (!resp || (resp.status !== 207 && resp.status !== 200)) {
        if (resp && (resp.status === 401 || resp.status === 403)) {
            const err = new Error('Authentication failed (HTTP ' + resp.status + ')');
            err.authFailed = true;
            throw err;
        }
        console.error(`${UUID}: REPORT failed for ${calendarHref}, status=${resp ? resp.status : 'null'}`);
        return null;
    }

    // Parse expanded response - one VEVENT per occurrence with UTC dates
    const events = [];
    const dataBlocks = resp.body.split(/<c:calendar-data|<cal:calendar-data|<C:calendar-data/i);
    for (let i = 1; i < dataBlocks.length; i++) {
        const block = dataBlocks[i];
        const contentMatch = block.match(/>([\s\S]*?)<\//);
        if (!contentMatch) continue;
        const ical = contentMatch[1].replace(/&#13;/g, '');

        const veventMatches = ical.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g);
        if (!veventMatches) continue;

        for (const vevent of veventMatches) {
            const summary = _icalProp(vevent, 'SUMMARY');
            const description = _icalProp(vevent, 'DESCRIPTION') || '';
            const dtstart = _icalDate(vevent, 'DTSTART');
            const dtend = _icalDate(vevent, 'DTEND');
            const uid = _icalProp(vevent, 'UID');
            const allDay = _isAllDay(vevent, 'DTSTART');
            if (!summary || !dtstart) continue;

            events.push({
                uid: uid || (summary + dtstart.toISOString()),
                summary,
                description,
                dtstart: dtstart.toISOString(),
                dtend: dtend ? dtend.toISOString() : null,
                allDay,
                alarms: [],
            });
        }
    }

    // Query 2: Raw (non-expanded) - gets VALARMs from master VEVENTs
    const alarmsByUid = {};
    const rawBody = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">',
        '  <d:prop>',
        '    <c:calendar-data/>',
        '  </d:prop>',
        '  <c:filter>',
        '    <c:comp-filter name="VCALENDAR">',
        '      <c:comp-filter name="VEVENT">',
        '        <c:time-range start="' + rangeUtcStart + '" end="' + rangeUtcEnd + '"/>',
        '      </c:comp-filter>',
        '    </c:comp-filter>',
        '  </c:filter>',
        '</c:calendar-query>',
    ].join('\n');

    const rawResp = _syncRequest(session, 'REPORT', url, {
        'Content-Type': 'application/xml; charset=utf-8',
        'Depth': '1',
        'Authorization': authHeader,
    }, rawBody);

    if (rawResp && (rawResp.status === 207 || rawResp.status === 200)) {
        const rawBlocks = rawResp.body.split(/<c:calendar-data|<cal:calendar-data|<C:calendar-data/i);
        for (let i = 1; i < rawBlocks.length; i++) {
            const block = rawBlocks[i];
            const contentMatch = block.match(/>([\s\S]*?)<\//);
            if (!contentMatch) continue;
            const ical = contentMatch[1];

            const veventMatches = ical.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g);
            if (!veventMatches) continue;

            for (const vevent of veventMatches) {
                const uid = _icalProp(vevent, 'UID');
                if (!uid) continue;
                const alarms = _parseValarms(vevent);
                if (alarms.length > 0 && !alarmsByUid[uid])
                    alarmsByUid[uid] = alarms;
            }
        }
    }

    // Attach alarms to expanded events by UID
    for (const ev of events) {
        if (alarmsByUid[ev.uid])
            ev.alarms = alarmsByUid[ev.uid];
    }

    return events;
}

// ---- iCalendar parsing helpers ----

function _parseValarms(vevent) {
    const alarms = [];
    const valarmBlocks = vevent.match(/BEGIN:VALARM[\s\S]*?END:VALARM/g);
    if (!valarmBlocks) return alarms;
    for (const block of valarmBlocks) {
        const triggerMatch = block.match(/TRIGGER[^:]*:(-?)PT?(\d+[WDHMS0-9]*)/i);
        if (!triggerMatch) continue;
        const negative = triggerMatch[1] === '-';
        const duration = triggerMatch[2];
        const minutes = _parseDurationToMinutes(duration);
        if (minutes > 0 && negative)
            alarms.push(minutes);
    }
    return [...new Set(alarms)].sort((a, b) => a - b);
}

function _parseDurationToMinutes(dur) {
    let total = 0;
    const weeks = dur.match(/(\d+)W/i);
    const days = dur.match(/(\d+)D/i);
    const hours = dur.match(/(\d+)H/i);
    const mins = dur.match(/(\d+)M/i);
    if (weeks) total += parseInt(weeks[1]) * 7 * 24 * 60;
    if (days) total += parseInt(days[1]) * 24 * 60;
    if (hours) total += parseInt(hours[1]) * 60;
    if (mins) total += parseInt(mins[1]);
    if (total === 0 && /^\d+$/.test(dur)) total = parseInt(dur);
    return total;
}

function _icalProp(vevent, propName) {
    const re = new RegExp('^' + propName + '[;:]([^\\r\\n]*)', 'mi');
    const match = vevent.match(re);
    if (!match) return null;
    let val = match[1];
    if (match[0].indexOf(propName + ';') === 0) {
        const colonIdx = val.indexOf(':');
        if (colonIdx !== -1) val = val.substring(colonIdx + 1);
    }
    return val.trim();
}

/**
 * Check if a DTSTART is a DATE-only value (all-day event).
 */
function _isAllDay(vevent, propName) {
    const re = new RegExp('^' + propName + '([;:][^\\r\\n]*)', 'mi');
    const match = vevent.match(re);
    if (!match) return false;
    return /VALUE=DATE(?!-TIME)/i.test(match[1]);
}

/**
 * Parse an iCalendar date/datetime into a JS Date.
 * Handles VALUE=DATE, UTC (Z suffix), and TZID-qualified times.
 * For TZID times, converts to local using GLib timezone support.
 */
function _icalDate(vevent, propName) {
    const re = new RegExp('^' + propName + '([;:][^\\r\\n]*)', 'mi');
    const match = vevent.match(re);
    if (!match) return null;
    const line = match[1];

    const colonIdx = line.lastIndexOf(':');
    if (colonIdx === -1) return null;
    const val = line.substring(colonIdx + 1).trim();

    // Check for TZID parameter
    const tzMatch = line.match(/TZID=([^;:]+)/i);
    const tzid = tzMatch ? tzMatch[1] : null;

    // DATE only (all-day): 20260511
    if (val.length === 8) {
        const y = parseInt(val.substring(0, 4));
        const m = parseInt(val.substring(4, 6)) - 1;
        const d = parseInt(val.substring(6, 8));
        return new Date(y, m, d, 0, 0, 0);
    }

    const y = parseInt(val.substring(0, 4));
    const m = parseInt(val.substring(4, 6)) - 1;
    const d = parseInt(val.substring(6, 8));
    const h = parseInt(val.substring(9, 11));
    const min = parseInt(val.substring(11, 13));
    const s = parseInt(val.substring(13, 15)) || 0;

    // UTC
    if (val.endsWith('Z'))
        return new Date(Date.UTC(y, m, d, h, min, s));

    // TZID-qualified: convert via GLib
    if (tzid) {
        try {
            const tz = GLib.TimeZone.new_identifier(tzid);
            // Create a GDateTime in the event's timezone
            const gdt = GLib.DateTime.new(tz, y, m + 1, d, h, min, s);
            if (gdt) {
                // Convert to Unix timestamp (UTC epoch seconds)
                const unixTime = gdt.to_unix();
                return new Date(unixTime * 1000);
            }
        } catch (_e) {
            // Fall through to local time interpretation
        }
    }

    // No timezone info - treat as local
    return new Date(y, m, d, h, min, s);
}
