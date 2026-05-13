// Timer/reminder logic - pure functions, no UI dependencies
.pragma library

function formatCountdown(totalSeconds) {
    if (totalSeconds <= 0) return "0:00";
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = totalSeconds % 60;
    function pad(n) { return n < 10 ? "0" + n : "" + n; }
    if (h > 0) return h + ":" + pad(m) + ":" + pad(s);
    return m + ":" + pad(s);
}

function formatTimeAmPm(date) {
    var h = date.getHours();
    var m = date.getMinutes();
    var ampm = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    return h + ":" + (m < 10 ? "0" + m : m) + " " + ampm;
}

function isToday(dateStr) {
    var d = new Date(dateStr);
    var now = new Date();
    return d.getFullYear() === now.getFullYear() &&
           d.getMonth() === now.getMonth() &&
           d.getDate() === now.getDate();
}

function isYesterday(dateStr) {
    var d = new Date(dateStr);
    var yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return d.getFullYear() === yesterday.getFullYear() &&
           d.getMonth() === yesterday.getMonth() &&
           d.getDate() === yesterday.getDate();
}

// Determine the most relevant pending reminder and fire only that one.
// Returns { shouldFire: bool, notification: string } or null
function processPendingReminders(pending, notifyPastDue, startTime) {
    if (pending.length === 0) return null;
    pending.sort(function(a, b) { return b.triggerTime - a.triggerTime; });
    for (var i = 0; i < pending.length; i++) {
        pending[i].mark();
    }
    var best = pending[0];
    if (notifyPastDue || best.triggerTime >= startTime) {
        return { shouldFire: true, message: best.message };
    }
    return null;
}
