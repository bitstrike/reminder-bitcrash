import QtQuick 2.15
import QtQuick.Layouts 1.15
import org.kde.plasma.components 3.0 as PlasmaComponents
import org.kde.plasma.core 2.0 as PlasmaCore

import "../code/timer.js" as Timer

ColumnLayout {
    id: taskRow

    property var taskData
    signal toggleComplete()
    signal dismiss()
    signal edit()

    readonly property bool isCalendar: taskData.source === "calendar"
    readonly property bool isExpired: !taskData.completed && !taskData.dismissed &&
        taskData.targetTime && new Date(taskData.targetTime).getTime() <= Date.now()
    readonly property bool isStale: isExpired && !Timer.isToday(taskData.targetTime)

    spacing: 2
    Layout.fillWidth: true

    Rectangle {
        Layout.fillWidth: true
        height: 1
        color: PlasmaCore.Theme.separatorColor
        opacity: 0.3
    }

    // Line 1: checkbox + description + buttons
    RowLayout {
        Layout.fillWidth: true
        Layout.margins: 4
        spacing: 6

        // Checkbox
        PlasmaComponents.CheckBox {
            checked: taskData.completed || false
            onToggled: taskRow.toggleComplete()
        }

        // Description
        PlasmaComponents.Label {
            text: taskData.description || ""
            Layout.fillWidth: true
            elide: Text.ElideRight
            opacity: taskData.completed ? 0.5 : (isStale ? 0.6 : 1.0)
            font.strikeout: taskData.completed || isStale
        }

        // Action buttons
        PlasmaComponents.ToolButton {
            icon.name: "document-edit"
            visible: !isCalendar && !taskData.completed
            onClicked: taskRow.edit()
            PlasmaComponents.ToolTip { text: "Edit" }
        }

        PlasmaComponents.ToolButton {
            icon.name: "edit-delete"
            onClicked: taskRow.dismiss()
            PlasmaComponents.ToolTip { text: isExpired || taskData.completed ? "Dismiss" : "Cancel" }
        }
    }

    // Line 2: badges + time info
    RowLayout {
        Layout.fillWidth: true
        Layout.leftMargin: 36
        spacing: 6

        // CAL badge
        PlasmaComponents.Label {
            visible: isCalendar
            text: "CAL"
            font.pointSize: PlasmaCore.Theme.smallestFont.pointSize
            color: "#5b9bd5"
        }

        // ALL DAY badge
        PlasmaComponents.Label {
            visible: taskData.allDay || false
            text: "ALL DAY"
            font.pointSize: PlasmaCore.Theme.smallestFont.pointSize
            opacity: 0.7
        }

        // Status badge
        PlasmaComponents.Label {
            visible: !taskData.allDay && (isStale || isExpired || taskData.completed || hasTarget())
            text: getBadgeText()
            font.pointSize: PlasmaCore.Theme.smallestFont.pointSize
            color: getBadgeColor()
        }

        // Time info
        PlasmaComponents.Label {
            visible: !taskData.allDay && hasTarget()
            text: getTimeText()
            font.pointSize: PlasmaCore.Theme.smallestFont.pointSize
            opacity: 0.7
        }
    }

    function hasTarget() {
        return taskData.targetTime !== undefined && taskData.targetTime !== null;
    }

    function getBadgeText() {
        if (isStale) return Timer.isYesterday(taskData.targetTime) ? "YESTERDAY" : "OLD";
        if (isExpired) return "EXPIRED";
        if (taskData.completed) return "Done";
        if (taskData.timerMode === "countdown") return "COUNTDOWN";
        if (taskData.targetTime) return Timer.formatTimeAmPm(new Date(taskData.targetTime));
        return "";
    }

    function getBadgeColor() {
        if (isStale || isExpired) return "#f67b7b";
        if (taskData.completed) return "#6b6";
        if (taskData.timerMode === "countdown") return "#7bc8f6";
        return "#f6c87b";
    }

    function getTimeText() {
        if (isStale || isExpired)
            return "was " + Timer.formatTimeAmPm(new Date(taskData.targetTime));
        if (taskData.completed) return "";
        var now = Date.now();
        var target = new Date(taskData.targetTime).getTime();
        var remaining = Math.max(0, Math.floor((target - now) / 1000));
        if (remaining <= 0) return "";
        return Timer.formatCountdown(remaining) + " left";
    }
}
