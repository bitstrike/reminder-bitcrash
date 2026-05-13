// Nextcloud CalDAV client for KDE Plasma widget
// Uses XMLHttpRequest for HTTP (available in QML JS)
.pragma library

var UUID = "reminder@bitcrash";

function _syncRequest(method, url, headers, body) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, false);
    if (headers) {
        for (var key in headers) {
            xhr.setRequestHeader(key, headers[key]);
        }
    }
    xhr.send(body || null);
    return { status: xhr.status, body: xhr.responseText };
}

function _basicAuthHeader(user, password) {
    return "Basic " + Qt.btoa(user + ":" + password);
}

// ---- Login Flow v2 ----

function loginFlowInit(serverUrl) {
    var url = serverUrl.replace(/\/+$/, "") + "/index.php/login/v2";
    var resp = _syncRequest("POST", url, {}, "");
    if (!resp || resp.status !== 200) return null;
    try {
        var data = JSON.parse(resp.body);
        return { loginUrl: data.login, pollUrl: data.poll.endpoint, pollToken: data.poll.token };
    } catch (e) {
        return null;
    }
}

function loginFlowPoll(pollUrl, pollToken) {
    var body = "token=" + encodeURIComponent(pollToken);
    var resp = _syncRequest("POST", pollUrl, {
        "Content-Type": "application/x-www-form-urlencoded"
    }, body);
    if (!resp) return false;
    if (resp.status === 200) {
        try {
            var data = JSON.parse(resp.body);
            return { server: data.server, loginName: data.loginName, appPassword: data.appPassword };
        } catch (e) { return false; }
    }
    if (resp.status === 404) return null;
    return false;
}

// ---- CalDAV Discovery ----

function discoverCalendars(serverUrl, loginName, appPassword) {
    var base = serverUrl.replace(/\/+$/, "");
    var url = base + "/remote.php/dav/calendars/" + encodeURIComponent(loginName) + "/";
    var body = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">',
        '  <d:prop><d:displayname/><d:resourcetype/></d:prop>',
        '</d:propfind>'
    ].join("\n");

    var resp = _syncRequest("PROPFIND", url, {
        "Content-Type": "application/xml; charset=utf-8",
        "Depth": "1",
        "Authorization": _basicAuthHeader(loginName, appPassword)
    }, body);

    if (!resp || (resp.status !== 207 && resp.status !== 200)) return null;

    var calendars = [];
    var responses = resp.body.split(/<d:response>/i);
    for (var i = 1; i < responses.length; i++) {
        var block = responses[i];
        if (!/<d:collection/i.test(block)) continue;
        var hrefMatch = block.match(/<d:href>([^<]+)<\/d:href>/i);
        var nameMatch = block.match(/<d:displayname>([^<]*)<\/d:displayname>/i);
        if (!hrefMatch) continue;
        var href = hrefMatch[1];
        if (href === "/remote.php/dav/calendars/" + encodeURIComponent(loginName) + "/") continue;
        if (/\/(inbox|trashbin|outbox)\/?$/i.test(href)) continue;
        var displayName = nameMatch ? nameMatch[1] : href.split("/").filter(function(s){return s;}).pop();
        calendars.push({ displayName: displayName, href: href });
    }
    return calendars;
}

// ---- CalDAV Event Fetching (with expand) ----

function toIcalUtc(d) {
    return d.getUTCFullYear().toString() +
        ("0" + (d.getUTCMonth() + 1)).slice(-2) +
        ("0" + d.getUTCDate()).slice(-2) + "T" +
        ("0" + d.getUTCHours()).slice(-2) +
        ("0" + d.getUTCMinutes()).slice(-2) +
        ("0" + d.getUTCSeconds()).slice(-2) + "Z";
}

function fetchEvents(serverUrl, loginName, appPassword, calendarHref, rangeStart, rangeEnd) {
    var origin = serverUrl.match(/^https?:\/\/[^/]+/)[0];
    var url = origin + calendarHref;
    var rangeUtcStart = toIcalUtc(rangeStart);
    var rangeUtcEnd = toIcalUtc(rangeEnd);
    var authHeader = _basicAuthHeader(loginName, appPassword);

    // Query 1: Expanded - server resolves recurring events
    var expandBody = [
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

    var resp = _syncRequest("REPORT", url, {
        "Content-Type": "application/xml; charset=utf-8",
        "Depth": "1",
        "Authorization": authHeader
    }, expandBody);

    if (!resp || (resp.status !== 207 && resp.status !== 200)) {
        if (resp && (resp.status === 401 || resp.status === 403)) {
            var err = new Error("Authentication failed (HTTP " + resp.status + ")");
            err.authFailed = true;
            throw err;
        }
        return null;
    }

    // Parse expanded response
    var events = [];
    var dataBlocks = resp.body.split(/<c:calendar-data|<cal:calendar-data|<C:calendar-data/i);
    for (var i = 1; i < dataBlocks.length; i++) {
        var block = dataBlocks[i];
        var contentMatch = block.match(/>([\s\S]*?)<\//);
        if (!contentMatch) continue;
        var ical = contentMatch[1].replace(/&#13;/g, "");

        var veventMatch = ical.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g);
        if (!veventMatch) continue;

        for (var j = 0; j < veventMatch.length; j++) {
            var vevent = veventMatch[j];
            var summary = _icalProp(vevent, "SUMMARY");
            var description = _icalProp(vevent, "DESCRIPTION") || "";
            var dtstart = _icalDate(vevent, "DTSTART");
            var dtend = _icalDate(vevent, "DTEND");
            var uid = _icalProp(vevent, "UID");
            var allDay = _isAllDay(vevent, "DTSTART");
            if (!summary || !dtstart) continue;

            events.push({
                uid: uid || (summary + dtstart.toISOString()),
                summary: summary,
                description: description,
                dtstart: dtstart.toISOString(),
                dtend: dtend ? dtend.toISOString() : null,
                allDay: allDay,
                alarms: []
            });
        }
    }

    // Query 2: Raw - gets VALARMs
    var alarmsByUid = {};
    var rawBody = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">',
        '  <d:prop><c:calendar-data/></d:prop>',
        '  <c:filter>',
        '    <c:comp-filter name="VCALENDAR">',
        '      <c:comp-filter name="VEVENT">',
        '        <c:time-range start="' + rangeUtcStart + '" end="' + rangeUtcEnd + '"/>',
        '      </c:comp-filter>',
        '    </c:comp-filter>',
        '  </c:filter>',
        '</c:calendar-query>'
    ].join("\n");

    var rawResp = _syncRequest("REPORT", url, {
        "Content-Type": "application/xml; charset=utf-8",
        "Depth": "1",
        "Authorization": authHeader
    }, rawBody);

    if (rawResp && (rawResp.status === 207 || rawResp.status === 200)) {
        var rawBlocks = rawResp.body.split(/<c:calendar-data|<cal:calendar-data|<C:calendar-data/i);
        for (var ri = 1; ri < rawBlocks.length; ri++) {
            var rblock = rawBlocks[ri];
            var rcm = rblock.match(/>([\s\S]*?)<\//);
            if (!rcm) continue;
            var rIcal = rcm[1];
            var rVevents = rIcal.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g);
            if (!rVevents) continue;
            for (var rj = 0; rj < rVevents.length; rj++) {
                var rv = rVevents[rj];
                var ruid = _icalProp(rv, "UID");
                if (!ruid) continue;
                var alarms = _parseValarms(rv);
                if (alarms.length > 0 && !alarmsByUid[ruid])
                    alarmsByUid[ruid] = alarms;
            }
        }
    }

    // Attach alarms
    for (var ei = 0; ei < events.length; ei++) {
        if (alarmsByUid[events[ei].uid])
            events[ei].alarms = alarmsByUid[events[ei].uid];
    }

    return events;
}

// ---- iCal parsing helpers ----

function _icalProp(vevent, propName) {
    var re = new RegExp("^" + propName + "[;:]([^\\r\\n]*)", "mi");
    var match = vevent.match(re);
    if (!match) return null;
    var val = match[1];
    if (match[0].indexOf(propName + ";") === 0) {
        var colonIdx = val.indexOf(":");
        if (colonIdx !== -1) val = val.substring(colonIdx + 1);
    }
    return val.trim();
}

function _isAllDay(vevent, propName) {
    var re = new RegExp("^" + propName + "([;:][^\\r\\n]*)", "mi");
    var match = vevent.match(re);
    if (!match) return false;
    if (/VALUE=DATE(?!-TIME)/i.test(match[1])) return true;
    var colonIdx = match[1].lastIndexOf(":");
    if (colonIdx === -1) return false;
    var val = match[1].substring(colonIdx + 1).trim();
    return val.length === 8 && /^\d{8}$/.test(val);
}

function _icalDate(vevent, propName) {
    var re = new RegExp("^" + propName + "([;:][^\\r\\n]*)", "mi");
    var match = vevent.match(re);
    if (!match) return null;
    var line = match[1];
    var colonIdx = line.lastIndexOf(":");
    if (colonIdx === -1) return null;
    var val = line.substring(colonIdx + 1).trim();

    if (val.length === 8) {
        var y = parseInt(val.substring(0, 4));
        var m = parseInt(val.substring(4, 6)) - 1;
        var d = parseInt(val.substring(6, 8));
        return new Date(y, m, d, 0, 0, 0);
    }

    var y2 = parseInt(val.substring(0, 4));
    var m2 = parseInt(val.substring(4, 6)) - 1;
    var d2 = parseInt(val.substring(6, 8));
    var h = parseInt(val.substring(9, 11));
    var min = parseInt(val.substring(11, 13));
    var s = parseInt(val.substring(13, 15)) || 0;

    if (val.endsWith("Z"))
        return new Date(Date.UTC(y2, m2, d2, h, min, s));

    return new Date(y2, m2, d2, h, min, s);
}

function _parseValarms(vevent) {
    var alarms = [];
    var blocks = vevent.match(/BEGIN:VALARM[\s\S]*?END:VALARM/g);
    if (!blocks) return alarms;
    for (var i = 0; i < blocks.length; i++) {
        var triggerMatch = blocks[i].match(/TRIGGER[^:]*:(-?)PT?(\d+[WDHMS0-9]*)/i);
        if (!triggerMatch) continue;
        var negative = triggerMatch[1] === "-";
        var minutes = _parseDurationToMinutes(triggerMatch[2]);
        if (minutes > 0 && negative) alarms.push(minutes);
    }
    // Deduplicate and sort
    var seen = {};
    var result = [];
    for (var j = 0; j < alarms.length; j++) {
        if (!seen[alarms[j]]) { seen[alarms[j]] = true; result.push(alarms[j]); }
    }
    return result.sort(function(a, b) { return a - b; });
}

function _parseDurationToMinutes(dur) {
    var total = 0;
    var weeks = dur.match(/(\d+)W/i);
    var days = dur.match(/(\d+)D/i);
    var hours = dur.match(/(\d+)H/i);
    var mins = dur.match(/(\d+)M/i);
    if (weeks) total += parseInt(weeks[1]) * 7 * 24 * 60;
    if (days) total += parseInt(days[1]) * 24 * 60;
    if (hours) total += parseInt(hours[1]) * 60;
    if (mins) total += parseInt(mins[1]);
    if (total === 0 && /^\d+$/.test(dur)) total = parseInt(dur);
    return total;
}
