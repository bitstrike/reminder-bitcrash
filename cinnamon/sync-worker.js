#!/usr/bin/cjs
// Subprocess worker for calendar sync - runs blocking HTTP off the main Cinnamon loop.
// Reads config from stdin (JSON), writes results to stdout (JSON).

const Soup = imports.gi.Soup;
const GLib = imports.gi.GLib;

function _newSession() {
    let session = new Soup.Session();
    session.timeout = 15;
    return session;
}

function _basicAuthHeader(user, password) {
    let encoded = GLib.base64_encode(user + ":" + password);
    return "Basic " + encoded;
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

function toIcalUtc(d) {
    return d.getUTCFullYear().toString() +
        ("0" + (d.getUTCMonth() + 1)).slice(-2) +
        ("0" + d.getUTCDate()).slice(-2) + "T" +
        ("0" + d.getUTCHours()).slice(-2) +
        ("0" + d.getUTCMinutes()).slice(-2) +
        ("0" + d.getUTCSeconds()).slice(-2) + "Z";
}

function _icalProp(vevent, propName) {
    let re = new RegExp("^" + propName + "[;:]([^\\r\\n]*)", "mi");
    let match = vevent.match(re);
    if (!match) return null;
    let val = match[1];
    if (match[0].indexOf(propName + ";") === 0) {
        let colonIdx = val.indexOf(":");
        if (colonIdx !== -1) val = val.substring(colonIdx + 1);
    }
    return val.trim();
}

function _icalDate(vevent, propName) {
    let re = new RegExp("^" + propName + "([;:][^\\r\\n]*)", "mi");
    let match = vevent.match(re);
    if (!match) return null;
    let line = match[1];
    let colonIdx = line.lastIndexOf(":");
    if (colonIdx === -1) return null;
    let val = line.substring(colonIdx + 1).trim();

    if (val.length === 8) {
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
    return new Date(y, m, d, h, min, s);
}

function _isAllDay(vevent, propName) {
    let re = new RegExp("^" + propName + "([;:][^\\r\\n]*)", "mi");
    let match = vevent.match(re);
    if (!match) return false;
    let line = match[1];
    if (/VALUE=DATE(?!-TIME)/i.test(line)) return true;
    let colonIdx = line.lastIndexOf(":");
    if (colonIdx === -1) return false;
    let val = line.substring(colonIdx + 1).trim();
    return val.length === 8 && /^\d{8}$/.test(val);
}

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
    alarms = [...new Set(alarms)].sort((a, b) => a - b);
    return alarms;
}

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
    if (total === 0 && /^\d+$/.test(dur)) total = parseInt(dur);
    return total;
}

function fetchEvents(serverUrl, loginName, appPassword, calendarHref, rangeStart, rangeEnd) {
    let session = _newSession();
    let origin = serverUrl.match(/^https?:\/\/[^/]+/)[0];
    let url = origin + calendarHref;

    let rangeUtcStart = toIcalUtc(rangeStart);
    let rangeUtcEnd = toIcalUtc(rangeEnd);
    let authHeader = _basicAuthHeader(loginName, appPassword);

    // Query 1: Expanded
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
            return { error: "authFailed" };
        }
        return { error: "REPORT failed, status=" + (resp ? resp.status : "null") };
    }

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

    // Query 2: Raw for VALARMs
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

    for (let ev of events) {
        if (alarmsByUid[ev.uid]) {
            ev.alarms = alarmsByUid[ev.uid];
        }
    }

    return { events: events };
}

// ---- Main ----
// Read config from stdin
let [ok, stdinBytes] = GLib.file_get_contents("/dev/stdin");
if (!ok) {
    print(JSON.stringify({ error: "Failed to read stdin" }));
    imports.system.exit(1);
}

let config;
try {
    config = JSON.parse(new TextDecoder().decode(stdinBytes));
} catch (e) {
    print(JSON.stringify({ error: "Invalid JSON input: " + e.message }));
    imports.system.exit(1);
}

let results = { events: [], authFailed: false, errors: [] };

for (let cal of config.calendars) {
    let result = fetchEvents(
        config.serverUrl, config.loginName, config.appPassword,
        cal.href, new Date(config.rangeStart), new Date(config.rangeEnd)
    );
    if (result.error) {
        if (result.error === "authFailed") {
            results.authFailed = true;
            break;
        }
        results.errors.push(cal.displayName + ": " + result.error);
        continue;
    }
    if (result.events) {
        // Apply keyword filter
        if (cal.filter && cal.filter.trim()) {
            let keywords = cal.filter.split(",").map(k => k.trim().toLowerCase()).filter(k => k);
            if (keywords.length > 0) {
                result.events = result.events.filter(ev => {
                    let text = ((ev.summary || "") + " " + (ev.description || "")).toLowerCase();
                    return keywords.some(kw => text.includes(kw));
                });
            }
        }
        for (let ev of result.events) {
            ev.calendarName = cal.displayName;
            results.events.push(ev);
        }
    }
}

print(JSON.stringify(results));
