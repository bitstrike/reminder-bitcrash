import QtQuick 2.15
import QtQuick.Layouts 1.15
import QtQuick.Controls 2.15
import org.kde.plasma.plasmoid 2.0
import org.kde.plasma.core 2.0 as PlasmaCore
import org.kde.plasma.components 3.0 as PlasmaComponents
import org.kde.plasma.extras 2.0 as PlasmaExtras

import "../code/timer.js" as Timer
import "../code/nextcloud.js" as Nextcloud

Item {
    id: root

    property var tasks: []
    property var calendarEvents: []
    property string ncLoginName: ""
    property string ncAppPassword: ""
    property bool ncConnected: false
    property real startTime: Date.now()

    readonly property int maxTasks: 100

    Plasmoid.icon: "alarm-symbolic"
    Plasmoid.toolTipMainText: "Task Reminder"
    Plasmoid.toolTipSubText: ncConnected ? "Connected" : "No tasks pending"

    Plasmoid.compactRepresentation: Item {
        PlasmaCore.IconItem {
            id: panelIcon
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            width: parent.height
            height: parent.height
            source: "alarm-symbolic"
        }
        PlasmaComponents.Label {
            id: panelLabel
            anchors.left: panelIcon.right
            anchors.leftMargin: 4
            anchors.verticalCenter: parent.verticalCenter
            text: getPanelLabel()
            font.pointSize: PlasmaCore.Theme.smallestFont.pointSize
        }
        Layout.minimumWidth: panelIcon.width + panelLabel.implicitWidth + 8

        MouseArea {
            anchors.fill: parent
            onClicked: plasmoid.expanded = !plasmoid.expanded
        }

        Timer {
            interval: 1000
            running: true
            repeat: true
            onTriggered: {
                panelLabel.text = getPanelLabel();
                doTick();
            }
        }
    }

    Plasmoid.fullRepresentation: ColumnLayout {
        Layout.preferredWidth: 380
        Layout.preferredHeight: 400
        Layout.minimumWidth: 300
        Layout.minimumHeight: 200

        // Header
        RowLayout {
            Layout.fillWidth: true
            Layout.margins: 8

            PlasmaExtras.Heading {
                text: "Tasks"
                level: 4
                Layout.fillWidth: true
            }

            PlasmaComponents.Button {
                text: "Dismiss Old"
                icon.name: "edit-clear"
                visible: hasExpiredTasks()
                onClicked: dismissAllOld()
            }

            PlasmaComponents.Button {
                text: "+ New Task"
                icon.name: "list-add"
                onClicked: newTaskDialog.open()
            }
        }

        // Task list
        PlasmaComponents.ScrollView {
            Layout.fillWidth: true
            Layout.fillHeight: true

            ListView {
                id: taskList
                model: getVisibleItems()
                clip: true
                delegate: TaskRow {
                    width: taskList.width
                    taskData: modelData
                    onToggleComplete: root.toggleComplete(modelData)
                    onDismiss: root.dismissTask(modelData)
                    onEdit: newTaskDialog.openWith(modelData)
                }

                PlasmaExtras.PlaceholderMessage {
                    anchors.centerIn: parent
                    visible: taskList.count === 0
                    text: "No tasks. Click '+ New Task' to add one."
                    iconName: "alarm-symbolic"
                }
            }
        }

        // Footer
        RowLayout {
            Layout.fillWidth: true
            Layout.margins: 4

            PlasmaComponents.Label {
                text: ncConnected ? "Connected" : "Not connected"
                font.pointSize: PlasmaCore.Theme.smallestFont.pointSize
                opacity: 0.7
                Layout.fillWidth: true
            }

            PlasmaComponents.ToolButton {
                icon.name: ncConnected ? "network-disconnect" : "network-connect"
                onClicked: ncConnected ? ncDisconnect() : ncConnect()
            }

            PlasmaComponents.ToolButton {
                icon.name: "view-refresh"
                visible: ncConnected
                onClicked: doCalendarSync()
            }
        }
    }

    // New/Edit Task Dialog
    NewTaskDialog {
        id: newTaskDialog
        onTaskSaved: function(task, isNew) {
            if (isNew) {
                if (tasks.filter(function(t){return !t.dismissed;}).length >= maxTasks) {
                    sendNotification("Maximum of " + maxTasks + " tasks reached.");
                    return;
                }
                tasks.push(task);
            }
            saveTasks();
            taskList.model = getVisibleItems();
        }
    }

    // Sync timer (10 minutes)
    Timer {
        id: syncTimer
        interval: 600000
        running: ncConnected
        repeat: true
        onTriggered: doCalendarSync()
    }

    // Notification via executable (knotify/notify-send)
    PlasmaCore.DataSource {
        id: executable
        engine: "executable"
        onNewData: disconnectSource(sourceName)
    }

    Component.onCompleted: {
        loadTasks();
        tryLoadCredentials();
    }

    // ---- Task operations ----

    function loadTasks() {
        var dir = StandardPaths.writableLocation(StandardPaths.ConfigLocation) + "/reminder@bitcrash";
        var path = dir + "/tasks.json";
        var xhr = new XMLHttpRequest();
        try {
            xhr.open("GET", "file://" + path, false);
            xhr.send();
            if (xhr.status === 200 && xhr.responseText)
                tasks = JSON.parse(xhr.responseText);
            else
                tasks = [];
        } catch (e) {
            tasks = [];
        }
    }

    function saveTasks() {
        var dir = StandardPaths.writableLocation(StandardPaths.ConfigLocation) + "/reminder@bitcrash";
        var path = dir + "/tasks.json";
        var json = JSON.stringify(tasks, null, 2);
        executable.connectSource("mkdir -p '" + dir + "' && printf '%s' '" + json.replace(/'/g, "'\\''") + "' > '" + path + "'");
    }

    function toggleComplete(task) {
        task.completed = !task.completed;
        saveTasks();
        taskList.model = getVisibleItems();
    }

    function dismissTask(task) {
        task.dismissed = true;
        saveTasks();
        taskList.model = getVisibleItems();
    }

    function dismissAllOld() {
        var now = Date.now();
        for (var i = 0; i < tasks.length; i++) {
            var t = tasks[i];
            if (t.completed && !t.dismissed) t.dismissed = true;
            if (!t.completed && !t.dismissed && t.targetTime && new Date(t.targetTime).getTime() <= now)
                t.dismissed = true;
        }
        for (var j = 0; j < calendarEvents.length; j++) {
            var e = calendarEvents[j];
            if (e.completed && !e.dismissed) e.dismissed = true;
            if (!e.dismissed && e.targetTime && new Date(e.targetTime).getTime() <= now)
                e.dismissed = true;
        }
        saveTasks();
        taskList.model = getVisibleItems();
    }

    // ---- Tick loop ----

    function doTick() {
        var now = Date.now();
        var fired = false;
        var notifyPastDue = plasmoid.configuration.notifyPastDue;
        var enableCountdown = plasmoid.configuration.enableCountdownReminders;

        for (var i = 0; i < tasks.length; i++) {
            var task = tasks[i];
            if (task.completed || task.dismissed) continue;
            if (!task.targetTime) continue;
            var target = new Date(task.targetTime).getTime();

            if (target <= now) {
                task._notified15 = true;
                task._notified5 = true;
                if (!task._notified) {
                    task._notified = true;
                    if (notifyPastDue || target >= startTime) {
                        fired = true;
                        fireNotification(task);
                    }
                }
            } else if (enableCountdown) {
                var pending = [];
                if (task._remind15 !== false && !task._notified15) {
                    var t15 = target - 15 * 60 * 1000;
                    if (t15 <= now) {
                        var r15 = Math.max(0, Math.floor((target - now) / 60000));
                        pending.push({ triggerTime: t15, msg: task.description + " in " + r15 + " min",
                            mark: function() { task._notified15 = true; } });
                    }
                }
                if (task._remind5 !== false && !task._notified5) {
                    var t5 = target - 5 * 60 * 1000;
                    if (t5 <= now) {
                        var r5 = Math.max(0, Math.floor((target - now) / 60000));
                        pending.push({ triggerTime: t5, msg: task.description + " in " + r5 + " min",
                            mark: function() { task._notified5 = true; } });
                    }
                }
                if (pending.length > 0) {
                    pending.sort(function(a, b) { return b.triggerTime - a.triggerTime; });
                    for (var pi = 0; pi < pending.length; pi++) pending[pi].mark();
                    if (notifyPastDue || pending[0].triggerTime >= startTime) {
                        fired = true;
                        sendNotification(pending[0].msg);
                    }
                }
            }
        }

        // Calendar events
        for (var ci = 0; ci < calendarEvents.length; ci++) {
            var event = calendarEvents[ci];
            if (event.completed || event.dismissed || event.allDay) continue;
            if (!event.targetTime) continue;
            var eTarget = new Date(event.targetTime).getTime();

            if (eTarget <= now) {
                event._notified15 = true;
                event._notified5 = true;
                if (event.alarms) {
                    if (!event._valarmNotified) event._valarmNotified = {};
                    for (var ai = 0; ai < event.alarms.length; ai++)
                        event._valarmNotified[event.alarms[ai]] = true;
                }
                if (!event._notified) {
                    event._notified = true;
                    if (notifyPastDue || eTarget >= startTime) {
                        fired = true;
                        fireNotification(event);
                    }
                }
            } else if (enableCountdown) {
                var ePending = [];
                if (event._remind15 !== false && !event._notified15) {
                    var et15 = eTarget - 15 * 60 * 1000;
                    if (et15 <= now) {
                        var er15 = Math.max(0, Math.floor((eTarget - now) / 60000));
                        ePending.push({ triggerTime: et15, msg: event.description + " in " + er15 + " min",
                            mark: function() { event._notified15 = true; } });
                    }
                }
                if (event._remind5 !== false && !event._notified5) {
                    var et5 = eTarget - 5 * 60 * 1000;
                    if (et5 <= now) {
                        var er5 = Math.max(0, Math.floor((eTarget - now) / 60000));
                        ePending.push({ triggerTime: et5, msg: event.description + " in " + er5 + " min",
                            mark: function() { event._notified5 = true; } });
                    }
                }
                if (ePending.length > 0) {
                    ePending.sort(function(a, b) { return b.triggerTime - a.triggerTime; });
                    for (var epi = 0; epi < ePending.length; epi++) ePending[epi].mark();
                    if (notifyPastDue || ePending[0].triggerTime >= startTime) {
                        fired = true;
                        sendNotification(ePending[0].msg);
                    }
                }
            }
        }

        if (fired) saveTasks();
    }

    function fireNotification(task) {
        var msg = task.description;
        if (task.timerMode === "absolute")
            msg += " - " + Timer.formatTimeAmPm(new Date(task.targetTime));
        else
            msg += " - countdown finished";
        sendNotification(msg);
    }

    function sendNotification(msg) {
        executable.connectSource("notify-send 'Task Reminder' '" + msg.replace(/'/g, "'\\''") + "' -i alarm-symbolic");
        maybePlaySound();
    }

    function maybePlaySound() {
        if (!plasmoid.configuration.enableSound) return;
        var soundFile = plasmoid.configuration.soundFile;
        if (!soundFile) return;
        executable.connectSource("paplay '" + soundFile + "' 2>/dev/null || aplay '" + soundFile + "' 2>/dev/null");
    }

    // ---- Panel label ----

    function getPanelLabel() {
        var next = getNextActiveTask();
        if (!next) return "No tasks";
        var now = Date.now();
        var target = new Date(next.targetTime).getTime();
        var remaining = Math.max(0, Math.floor((target - now) / 1000));
        var desc = next.description;
        if (desc.length > 15) desc = desc.substring(0, 14) + "\u2026";
        if (remaining <= 0) return desc + " - expired";
        return desc + " - " + Timer.formatCountdown(remaining);
    }

    function getNextActiveTask() {
        var now = Date.now();
        var best = null;
        var bestTime = Infinity;
        var all = tasks.concat(calendarEvents);
        for (var i = 0; i < all.length; i++) {
            var t = all[i];
            if (t.completed || t.dismissed) continue;
            if (!t.targetTime) continue;
            var tt = new Date(t.targetTime).getTime();
            if (tt - now > -3600000 && tt < bestTime) {
                bestTime = tt;
                best = t;
            }
        }
        return best;
    }

    function getVisibleItems() {
        var visible = tasks.filter(function(t) { return !t.dismissed; });
        var visCal = calendarEvents.filter(function(e) { return !e.dismissed; });
        var all = visible.concat(visCal);
        all.sort(function(a, b) {
            var ta = a.targetTime ? new Date(a.targetTime).getTime() : Infinity;
            var tb = b.targetTime ? new Date(b.targetTime).getTime() : Infinity;
            return ta - tb;
        });
        return all;
    }

    function hasExpiredTasks() {
        var now = Date.now();
        for (var i = 0; i < tasks.length; i++) {
            var t = tasks[i];
            if (!t.completed && !t.dismissed && t.targetTime && new Date(t.targetTime).getTime() <= now)
                return true;
        }
        return false;
    }

    // ---- Nextcloud ----

    function tryLoadCredentials() {
        var url = plasmoid.configuration.caldavUrl;
        if (!url) return;
        // For now credentials must be re-entered each session
        // TODO: kwallet integration
    }

    function ncConnect() {
        var url = plasmoid.configuration.caldavUrl;
        if (!url) {
            sendNotification("Set Nextcloud URL in settings first.");
            return;
        }
        var flowData = Nextcloud.loginFlowInit(url);
        if (!flowData) {
            sendNotification("Failed to contact server.");
            return;
        }
        Qt.openUrlExternally(flowData.loginUrl);
        sendNotification("Approve access in your browser...");
        pollTimer.flowData = flowData;
        pollTimer.attempts = 0;
        pollTimer.start();
    }

    function ncDisconnect() {
        ncConnected = false;
        ncLoginName = "";
        ncAppPassword = "";
        calendarEvents = [];
        taskList.model = getVisibleItems();
        sendNotification("Disconnected from Nextcloud.");
    }

    Timer {
        id: pollTimer
        property var flowData: null
        property int attempts: 0
        interval: 2000
        repeat: true
        onTriggered: {
            attempts++;
            if (attempts > 150) { stop(); sendNotification("Login timed out."); return; }
            var result = Nextcloud.loginFlowPoll(flowData.pollUrl, flowData.pollToken);
            if (result === null) return;
            if (result === false) { stop(); sendNotification("Login expired."); return; }
            stop();
            ncLoginName = result.loginName;
            ncAppPassword = result.appPassword;
            ncConnected = true;
            sendNotification("Connected as " + result.loginName);
            doCalendarSync();
        }
    }

    function doCalendarSync() {
        if (!ncConnected) return;
        var url = plasmoid.configuration.caldavUrl;
        if (!url) return;

        var calsJson = plasmoid.configuration.caldavCalendars;
        var enabledCals = [];
        try {
            var stored = JSON.parse(calsJson);
            if (Array.isArray(stored))
                enabledCals = stored.filter(function(c) { return c.enabled; });
        } catch (e) { return; }

        if (enabledCals.length === 0) return;

        var now = new Date();
        var rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        var rangeEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);

        var newEvents = [];
        for (var i = 0; i < enabledCals.length; i++) {
            var cal = enabledCals[i];
            try {
                var events = Nextcloud.fetchEvents(url, ncLoginName, ncAppPassword, cal.href, rangeStart, rangeEnd);
                if (!events) continue;

                if (cal.filter && cal.filter.trim()) {
                    var keywords = cal.filter.split(",").map(function(k){return k.trim().toLowerCase();}).filter(function(k){return k;});
                    if (keywords.length > 0) {
                        events = events.filter(function(ev) {
                            var text = ((ev.summary || "") + " " + (ev.description || "")).toLowerCase();
                            return keywords.some(function(kw) { return text.indexOf(kw) !== -1; });
                        });
                    }
                }

                for (var j = 0; j < events.length; j++) {
                    var ev = events[j];
                    var targetTime = ev.dtstart;
                    var endTime = ev.dtend;
                    if (ev.allDay) {
                        var today = new Date();
                        var h = plasmoid.configuration.allDayReminderHour;
                        var m = plasmoid.configuration.allDayReminderMinute;
                        var reminderDate = new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m, 0);
                        targetTime = reminderDate.toISOString();
                        endTime = null;
                    }
                    newEvents.push({
                        id: "cal-" + ev.uid,
                        source: "calendar",
                        description: ev.summary,
                        targetTime: targetTime,
                        endTime: endTime,
                        allDay: ev.allDay || false,
                        calendarName: cal.displayName,
                        alarms: ev.alarms || [],
                        completed: false,
                        dismissed: false,
                        _notified: false,
                        _valarmNotified: {},
                        _valarmEnabled: {}
                    });
                }
            } catch (e) {
                if (e.authFailed) {
                    ncConnected = false;
                    sendNotification("Session expired. Reconnect.");
                    return;
                }
            }
        }

        // Preserve state from existing events
        var existingById = {};
        for (var ei = 0; ei < calendarEvents.length; ei++)
            existingById[calendarEvents[ei].id] = calendarEvents[ei];

        for (var ni = 0; ni < newEvents.length; ni++) {
            var existing = existingById[newEvents[ni].id];
            if (existing) {
                newEvents[ni].completed = existing.completed;
                newEvents[ni].dismissed = existing.dismissed;
                newEvents[ni]._notified = existing._notified;
                newEvents[ni]._notified15 = existing._notified15;
                newEvents[ni]._notified5 = existing._notified5;
                newEvents[ni]._remind15 = existing._remind15;
                newEvents[ni]._remind5 = existing._remind5;
                newEvents[ni]._valarmNotified = existing._valarmNotified || {};
                newEvents[ni]._valarmEnabled = existing._valarmEnabled || {};
            }
        }

        calendarEvents = newEvents;
        taskList.model = getVisibleItems();
    }
}
