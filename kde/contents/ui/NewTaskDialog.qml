import QtQuick 2.15
import QtQuick.Layouts 1.15
import QtQuick.Controls 2.15
import org.kde.plasma.components 3.0 as PlasmaComponents

Dialog {
    id: dialog

    property bool editing: false
    property var editTask: null

    signal accepted(var task)

    title: editing ? "Edit Task" : "New Task"
    modal: true
    standardButtons: Dialog.Ok | Dialog.Cancel
    width: 360

    property string currentMode: "countdown"

    onOpened: {
        if (editing && editTask) {
            descField.text = editTask.description;
            currentMode = editTask.timerMode || "countdown";
            if (currentMode === "countdown" && editTask.countdownSeconds) {
                var cs = editTask.countdownSeconds;
                hoursField.value = Math.floor(cs / 3600);
                minutesField.value = Math.floor((cs % 3600) / 60);
                secondsField.value = cs % 60;
            } else if (currentMode === "absolute" && editTask.targetTime) {
                var d = new Date(editTask.targetTime);
                var h = d.getHours();
                ampmToggle.checked = h >= 12;
                h = h % 12;
                if (h === 0) h = 12;
                absHourField.value = h;
                absMinField.value = d.getMinutes();
            }
        } else {
            descField.text = "";
            currentMode = "countdown";
            hoursField.value = 0;
            minutesField.value = 0;
            secondsField.value = 0;
            absHourField.value = 12;
            absMinField.value = 0;
            ampmToggle.checked = true;
        }
        descField.forceActiveFocus();
    }

    function openWith(task) {
        editTask = task;
        editing = true;
        open();
    }

    onAccepted: {
        var desc = descField.text.trim();
        if (!desc) return;

        var task = editing ? editTask : {
            id: "t" + Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            description: "",
            timerMode: "countdown",
            targetTime: null,
            countdownSeconds: null,
            created: new Date().toISOString(),
            completed: false,
            dismissed: false
        };

        task.description = desc;
        task.timerMode = currentMode;
        task._notified = false;

        if (currentMode === "countdown") {
            var totalSec = hoursField.value * 3600 + minutesField.value * 60 + secondsField.value;
            if (totalSec <= 0) return;
            task.countdownSeconds = totalSec;
            task.targetTime = new Date(Date.now() + totalSec * 1000).toISOString();
        } else {
            var ah = absHourField.value;
            var am = absMinField.value;
            if (!ampmToggle.checked) { // AM
                if (ah === 12) ah = 0;
            } else { // PM
                if (ah !== 12) ah += 12;
            }
            var target = new Date();
            target.setHours(ah, am, 0, 0);
            task.targetTime = target.toISOString();
            task.countdownSeconds = null;
        }

        dialog.accepted(task);
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 12

        // Description
        PlasmaComponents.Label { text: "Description" }
        PlasmaComponents.TextField {
            id: descField
            Layout.fillWidth: true
            placeholderText: "e.g. Lunch break"
        }

        // Mode toggle
        PlasmaComponents.Label { text: "Timer Mode" }
        RowLayout {
            PlasmaComponents.Button {
                text: "Countdown"
                highlighted: currentMode === "countdown"
                onClicked: currentMode = "countdown"
            }
            PlasmaComponents.Button {
                text: "Set Time"
                highlighted: currentMode === "absolute"
                onClicked: currentMode = "absolute"
            }
        }

        // Countdown inputs
        ColumnLayout {
            visible: currentMode === "countdown"
            PlasmaComponents.Label { text: "Duration (H:M:S)" }
            RowLayout {
                SpinBox { id: hoursField; from: 0; to: 23; value: 0 }
                PlasmaComponents.Label { text: ":" }
                SpinBox { id: minutesField; from: 0; to: 59; value: 0 }
                PlasmaComponents.Label { text: ":" }
                SpinBox { id: secondsField; from: 0; to: 59; value: 0 }
            }
        }

        // Absolute time inputs
        ColumnLayout {
            visible: currentMode === "absolute"
            PlasmaComponents.Label { text: "Remind At" }
            RowLayout {
                SpinBox { id: absHourField; from: 1; to: 12; value: 12 }
                PlasmaComponents.Label { text: ":" }
                SpinBox { id: absMinField; from: 0; to: 59; value: 0 }
                PlasmaComponents.Switch {
                    id: ampmToggle
                    text: checked ? "PM" : "AM"
                    checked: true
                }
            }
        }
    }
}
