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

    readonly property bool isCalendar: taskData && taskData.source === "calendar"
    readonly property bool isExpired: taskData && !taskData.completed && !taskData.dismissed &&
        taskData.targetTime && new Date(taskData.targetTime).getTime() <= Date.now()

    spacing: 2

    // Separator
    Rectangle {
        Layout.fillWidth: true
        height: 1
        color: PlasmaCore.Theme.textColor
        opacity: 0.1
    }

    // Line 1: checkbox + description + buttons
    RowLayout {
        Layout.fillWidth: true
        Layout.leftMargin: 8
        Layout.rightMargin: 8
        Layout.topMargin: 4
        spacing: 6

        PlasmaComponents.CheckBox {
            checked: taskData ? (taskData.completed || false) : false
            onToggled: taskRow.toggleComplete()
        }

        PlasmaComponents.Label {
            text: taskData ? (taskData.description || "") : ""
            Layout.fillWidth: true
            elide: Text.ElideRight
            opacity: taskData && taskData.completed ? 0.5 : 1.0
            font.strikeout: taskData && taskData.completed
        }

        PlasmaComponents.ToolButton {
            icon.name: "document-edit"
            visible: !isCalendar && taskData && !taskData.completed
            onClicked: taskRow.edit()
        }

        PlasmaComponents.ToolButton {
            icon.name: "edit-delete"
            onClicked: taskRow.dismiss()
        }
    }

    // Line 2: status info
    RowLayout {
        Layout.fillWidth: true
        Layout.leftMargin: 40
        Layout.bottomMargin: 4
        spacing: 8

        PlasmaComponents.Label {
            visible: isCalendar
            text: "CAL"
            font.pointSize: PlasmaCore.Theme.smallestFont.pointSize
            color: "#5b9bd5"
        }

        PlasmaComponents.Label {
            visible: taskData && taskData.allDay
            text: "ALL DAY"
            font.pointSize: PlasmaCore.Theme.smallestFont.pointSize
            opacity: 0.6
        }

        PlasmaComponents.Label {
            visible: taskData && !taskData.allDay && taskData.targetTime
            text: getStatusText()
            font.pointSize: PlasmaCore.Theme.smallestFont.pointSize
            color: isExpired ? "#f67b7b" : PlasmaCore.Theme.textColor
            opacity: 0.7
        }
    }

    function getStatusText() {
        if (!taskData || !taskData.targetTime) return "";
        var now = Date.now();
        var target = new Date(taskData.targetTime).getTime();
        if (taskData.completed) return "Done";
        if (target <= now) return "EXPIRED - was " + Timer.formatTimeAmPm(new Date(taskData.targetTime));
        var remaining = Math.max(0, Math.floor((target - now) / 1000));
        return Timer.formatTimeAmPm(new Date(taskData.targetTime)) + " - " + Timer.formatCountdown(remaining) + " left";
    }
}
