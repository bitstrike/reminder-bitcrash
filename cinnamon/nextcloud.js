// Nextcloud Login Flow v2 + CalDAV calendar discovery
// Used by reminder@bitcrash applet

const Soup = imports.gi.Soup;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Secret = imports.gi.Secret;

const UUID = "reminder@bitcrash";

// Keyring schema for storing the app password
const SCHEMA = new Secret.Schema(
    "org.cinnamon.applet.reminder.nextcloud",
    Secret.SchemaFlags.NONE,
    { "server": Secret.SchemaAttributeType.STRING }
);

// ---- HTTP helpers ----

function _newSession() {
    let session = new Soup.Session();
    session.timeout = 30;
    return session;
}

function _syncRequest(session, method, url, headers, body) {
    let msg = Soup.Message.new(method, url);
    if (!msg) return null;
    if (headers) {
        for (let key in headers) {
            msg.request_headers.append(key, headers[key]);
        }
    }
    if (body) {
        msg.set_request_body_from_bytes(
            headers["Content-Type"] || "application/xml",
            new GLib.Bytes(body)
        );
    }
    let bytes = session.send_and_read(msg, null);
    return {
        status: msg.get_status(),
        body: bytes ? new TextDecoder().decode(bytes.get_data()) : ""
    };
}

// ---- Login Flow v2 ----

/**
 * Initiate Nextcloud Login Flow v2.
 * Returns { loginUrl, pollUrl, pollToken } or null on failure.
 */
function loginFlowInit(serverUrl) {
    let session = _newSession();
    let url = serverUrl.replace(/\/+$/, "") + "/index.php/login/v2";
    let resp = _syncRequest(session, "POST", url, {}, "");
    if (!resp || resp.status !== 200) return null;
    try {
        let data = JSON.parse(resp.body);
        return {
            loginUrl: data.login,
            pollUrl: data.poll.endpoint,
            pollToken: data.poll.token
        };
    } catch (e) {
        global.logError(UUID + ": Login flow init parse error: " + e.message);
        return null;
    }
}

/**
 * Poll the login flow endpoint once.
 * Returns { server, loginName, appPassword } on success, null if pending, false on expired.
 */
function loginFlowPoll(pollUrl, pollToken) {
    let session = _newSession();
    let body = "token=" + encodeURIComponent(pollToken);
    let resp = _syncRequest(session, "POST", pollUrl, {
        "Content-Type": "application/x-www-form-urlencoded"
    }, body);
    if (!resp) return false;
    if (resp.status === 200) {
        try {
            let data = JSON.parse(resp.body);
            return {
                server: data.server,
                loginName: data.loginName,
                appPassword: data.appPassword
            };
        } catch (e) {
            return false;
        }
    }
    if (resp.status === 404) return null; // still waiting
    return false; // expired or error
}

// ---- Keyring ----

function storeCredentials(serverUrl, loginName, appPassword) {
    let label = "Nextcloud (" + loginName + "@" + serverUrl + ")";
    let value = JSON.stringify({ loginName: loginName, appPassword: appPassword });
    try {
        Secret.password_store_sync(
            SCHEMA,
            { "server": serverUrl },
            Secret.COLLECTION_DEFAULT,
            label,
            value,
            null
        );
        return true;
    } catch (e) {
        global.logError(UUID + ": Failed to store credentials: " + e.message);
        return false;
    }
}

function loadCredentials(serverUrl) {
    try {
        let value = Secret.password_lookup_sync(
            SCHEMA,
            { "server": serverUrl },
            null
        );
        if (!value) return null;
        return JSON.parse(value);
    } catch (e) {
        global.logError(UUID + ": Failed to load credentials: " + e.message);
        return null;
    }
}

function clearCredentials(serverUrl) {
    try {
        Secret.password_clear_sync(SCHEMA, { "server": serverUrl }, null);
    } catch (e) {
        global.logError(UUID + ": Failed to clear credentials: " + e.message);
    }
}

/**
 * Revoke the app password on the Nextcloud server.
 * Best-effort - failures are logged but not fatal.
 */
function revokeAppPassword(serverUrl, loginName, appPassword) {
    try {
        let session = _newSession();
        let base = serverUrl.replace(/\/+$/, "");
        let url = base + "/ocs/v2.php/core/apppassword";
        let resp = _syncRequest(session, "DELETE", url, {
            "Authorization": _basicAuthHeader(loginName, appPassword),
            "OCS-APIREQUEST": "true"
        }, null);
        if (resp && (resp.status === 200 || resp.status === 100)) return true;
        global.logError(UUID + ": Revoke app password returned status " + (resp ? resp.status : "null"));
    } catch (e) {
        global.logError(UUID + ": Failed to revoke app password: " + e.message);
    }
    return false;
}

// ---- CalDAV Discovery ----

function _basicAuthHeader(user, password) {
    let encoded = GLib.base64_encode(user + ":" + password);
    return "Basic " + encoded;
}

/**
 * Discover calendars via PROPFIND.
 * Returns array of { displayName, href } or null on failure.
 */
function discoverCalendars(serverUrl, loginName, appPassword) {
    let session = _newSession();
    let base = serverUrl.replace(/\/+$/, "");
    let url = base + "/remote.php/dav/calendars/" + encodeURIComponent(loginName) + "/";

    let body = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">',
        '  <d:prop>',
        '    <d:displayname/>',
        '    <d:resourcetype/>',
        '  </d:prop>',
        '</d:propfind>'
    ].join("\n");

    let resp = _syncRequest(session, "PROPFIND", url, {
        "Content-Type": "application/xml; charset=utf-8",
        "Depth": "1",
        "Authorization": _basicAuthHeader(loginName, appPassword)
    }, body);

    if (!resp || (resp.status !== 207 && resp.status !== 200)) {
        global.logError(UUID + ": PROPFIND failed, status=" + (resp ? resp.status : "null"));
        return null;
    }

    // Parse the multistatus XML response for calendar collections
    let calendars = [];
    let responses = resp.body.split(/<d:response>/i);
    for (let i = 1; i < responses.length; i++) {
        let block = responses[i];
        // Only include calendar collections (have <cal:calendar/> or <d:collection/>)
        if (!/<d:collection/i.test(block)) continue;
        // Skip the principal URL itself (no displayname or same as base)
        let hrefMatch = block.match(/<d:href>([^<]+)<\/d:href>/i);
        let nameMatch = block.match(/<d:displayname>([^<]*)<\/d:displayname>/i);
        if (!hrefMatch) continue;
        let href = hrefMatch[1];
        // Skip if it's the parent collection (ends with just the username/)
        if (href === "/remote.php/dav/calendars/" + encodeURIComponent(loginName) + "/") continue;
        let displayName = nameMatch ? nameMatch[1] : href.split("/").filter(s => s).pop();
        calendars.push({ displayName: displayName, href: href });
    }
    return calendars;
}

// ---- CalDAV Event Fetching ----

/**
 * Fetch events from a calendar for a given date range.
 * calendarHref: path like /remote.php/dav/calendars/user/personal/
 * rangeStart/rangeEnd: Date objects
 * Returns array of { uid, summary, dtstart, dtend } or null on failure.
 */
function fetchEvents(serverUrl, loginName, appPassword, calendarHref, rangeStart, rangeEnd) {
    let session = _newSession();
    // calendarHref is an absolute path from server root - combine with origin only
    let origin = serverUrl.match(/^https?:\/\/[^/]+/)[0];
    let url = origin + calendarHref;

    // Format dates as iCalendar UTC timestamps (YYYYMMDDTHHMMSSZ)
    function toIcalUtc(d) {
        return d.getUTCFullYear().toString() +
            ("0" + (d.getUTCMonth() + 1)).slice(-2) +
            ("0" + d.getUTCDate()).slice(-2) + "T" +
            ("0" + d.getUTCHours()).slice(-2) +
            ("0" + d.getUTCMinutes()).slice(-2) +
            ("0" + d.getUTCSeconds()).slice(-2) + "Z";
    }

    let rangeUtcStart = toIcalUtc(rangeStart);
    let rangeUtcEnd = toIcalUtc(rangeEnd);
    let authHeader = _basicAuthHeader(loginName, appPassword);

    // Query 1: Expanded - gets correct occurrence dates
    let expandBody = [
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
        '</c:calendar-query>'
    ].join("\n");

    let resp = _syncRequest(session, "REPORT", url, {
        "Content-Type": "application/xml; charset=utf-8",
        "Depth": "1",
        "Authorization": authHeader
    }, expandBody);

    if (!resp || (resp.status !== 207 && resp.status !== 200)) {
        if (resp && (resp.status === 401 || resp.status === 403)) {
            let err = new Error("Authentication failed (HTTP " + resp.status + ")");
            err.authFailed = true;
            throw err;
        }
        global.logError(UUID + ": REPORT failed for " + calendarHref + ", status=" + (resp ? resp.status : "null"));
        return null;
    }

    // Parse expanded response - one VEVENT per occurrence with UTC dates
    let events = [];
    let dataBlocks = resp.body.split(/<c:calendar-data|<cal:calendar-data|<C:calendar-data/i);
    for (let i = 1; i < dataBlocks.length; i++) {
        let block = dataBlocks[i];
        let contentMatch = block.match(/>([\s\S]*?)<\//);
        if (!contentMatch) continue;
        let ical = contentMatch[1].replace(/&#13;/g, "");

        let veventMatch = ical.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g);
        if (!veventMatch) continue;

        for (let vevent of veventMatch) {
            let summary = _icalProp(vevent, "SUMMARY");
            let description = _icalProp(vevent, "DESCRIPTION") || "";
            let dtstart = _icalDate(vevent, "DTSTART");
            let dtend = _icalDate(vevent, "DTEND");
            let uid = _icalProp(vevent, "UID");
            let allDay = _isAllDay(vevent, "DTSTART");
            if (!summary || !dtstart) continue;

            events.push({
                uid: uid || (summary + dtstart.toISOString()),
                summary: summary,
                description: description,
                dtstart: dtstart.toISOString(),
                dtend: dtend ? dtend.toISOString() : null,
                alarms: [],
                allDay: allDay
            });
        }
    }

    // Query 2: Raw (non-expanded) - gets VALARMs from master VEVENTs
    // Build a UID-to-alarms map
    let alarmsByUid = {};
    let rawBody = [
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
        '</c:calendar-query>'
    ].join("\n");

    let rawResp = _syncRequest(session, "REPORT", url, {
        "Content-Type": "application/xml; charset=utf-8",
        "Depth": "1",
        "Authorization": authHeader
    }, rawBody);

    if (rawResp && (rawResp.status === 207 || rawResp.status === 200)) {
        let rawBlocks = rawResp.body.split(/<c:calendar-data|<cal:calendar-data|<C:calendar-data/i);
        for (let i = 1; i < rawBlocks.length; i++) {
            let block = rawBlocks[i];
            let contentMatch = block.match(/>([\s\S]*?)<\//);
            if (!contentMatch) continue;
            let ical = contentMatch[1];

            let veventMatch = ical.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g);
            if (!veventMatch) continue;

            for (let vevent of veventMatch) {
                let uid = _icalProp(vevent, "UID");
                if (!uid) continue;
                let alarms = _parseValarms(vevent);
                if (alarms.length > 0 && !alarmsByUid[uid]) {
                    alarmsByUid[uid] = alarms;
                }
            }
        }
    }

    // Attach alarms to expanded events by UID
    for (let ev of events) {
        if (alarmsByUid[ev.uid]) {
            ev.alarms = alarmsByUid[ev.uid];
        }
    }

    return events;
}

// Detect if a DTSTART is an all-day (VALUE=DATE) property
function _isAllDay(vevent, propName) {
    let re = new RegExp("^" + propName + "([;:][^\\r\\n]*)", "mi");
    let match = vevent.match(re);
    if (!match) return false;
    let line = match[1];
    // VALUE=DATE indicates all-day (no time component)
    if (/VALUE=DATE(?!-TIME)/i.test(line)) return true;
    // Also detect by value length: 8 chars = date only
    let colonIdx = line.lastIndexOf(":");
    if (colonIdx === -1) return false;
    let val = line.substring(colonIdx + 1).trim();
    return val.length === 8 && /^\d{8}$/.test(val);
}

// Parse VALARM blocks from a VEVENT, return array of minutes-before-start (positive integers)
function _parseValarms(vevent) {
    let alarms = [];
    let valarmBlocks = vevent.match(/BEGIN:VALARM[\s\S]*?END:VALARM/g);
    if (!valarmBlocks) return alarms;
    for (let block of valarmBlocks) {
        let triggerMatch = block.match(/TRIGGER[^:]*:(-?)PT?(\d+[WDHMS0-9]*)/i);
        if (!triggerMatch) continue;
        let negative = triggerMatch[1] === "-";
        let duration = triggerMatch[2];
        let minutes = _parseDurationToMinutes(duration);
        if (minutes > 0 && negative) {
            alarms.push(minutes);
        }
    }
    // Deduplicate and sort
    alarms = [...new Set(alarms)].sort((a, b) => a - b);
    return alarms;
}

// Parse an ISO 8601 duration component (e.g., "15M", "1H30M", "1H") to minutes
function _parseDurationToMinutes(dur) {
    let total = 0;
    let weeks = dur.match(/(\d+)W/i);
    let days = dur.match(/(\d+)D/i);
    let hours = dur.match(/(\d+)H/i);
    let mins = dur.match(/(\d+)M/i);
    if (weeks) total += parseInt(weeks[1]) * 7 * 24 * 60;
    if (days) total += parseInt(days[1]) * 24 * 60;
    if (hours) total += parseInt(hours[1]) * 60;
    if (mins) total += parseInt(mins[1]);
    // If nothing matched but it's just a number, treat as minutes
    if (total === 0 && /^\d+$/.test(dur)) total = parseInt(dur);
    return total;
}

// Parse a simple iCalendar property value
function _icalProp(vevent, propName) {
    // Handles both "PROP:value" and "PROP;params:value"
    let re = new RegExp("^" + propName + "[;:]([^\\r\\n]*)", "mi");
    let match = vevent.match(re);
    if (!match) return null;
    let val = match[1];
    // If it has parameters (;PARAM=X:value), extract after the last colon
    if (match[0].indexOf(propName + ";") === 0) {
        let colonIdx = val.indexOf(":");
        if (colonIdx !== -1) val = val.substring(colonIdx + 1);
    }
    return val.trim();
}

// Parse an iCalendar date/datetime value into a JS Date
function _icalDate(vevent, propName) {
    // Match the full line including any parameters
    let re = new RegExp("^" + propName + "([;:][^\\r\\n]*)", "mi");
    let match = vevent.match(re);
    if (!match) return null;
    let line = match[1];

    // Extract the value (after the last colon)
    let colonIdx = line.lastIndexOf(":");
    if (colonIdx === -1) return null;
    let val = line.substring(colonIdx + 1).trim();

    // Check for TZID parameter
    let tzid = null;
    let tzMatch = line.match(/TZID=([^;:]+)/i);
    if (tzMatch) tzid = tzMatch[1];

    // Parse formats: 20250509T100000Z (UTC), 20250509T100000 (local/tzid), 20250509 (date only)
    if (val.length === 8) {
        // Date only
        let y = parseInt(val.substring(0, 4));
        let m = parseInt(val.substring(4, 6)) - 1;
        let d = parseInt(val.substring(6, 8));
        return new Date(y, m, d, 0, 0, 0);
    }

    let y = parseInt(val.substring(0, 4));
    let m = parseInt(val.substring(4, 6)) - 1;
    let d = parseInt(val.substring(6, 8));
    let h = parseInt(val.substring(9, 11));
    let min = parseInt(val.substring(11, 13));
    let s = parseInt(val.substring(13, 15)) || 0;

    if (val.endsWith("Z")) {
        return new Date(Date.UTC(y, m, d, h, min, s));
    }
    // Local time (with or without TZID - treat as local for simplicity)
    return new Date(y, m, d, h, min, s);
}
