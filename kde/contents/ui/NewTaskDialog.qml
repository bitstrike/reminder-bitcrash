import QtQuick 2.15
import QtQuick.Layouts 1.15
import QtQuick.Controls 2.15
import org.kde.plasma.core 2.0 as PlasmaCore
import org.kde.plasma.components 3.0 as PlasmaComponents

Dialog {
    id: dialog

    property var editTask: null
    property bool isEditing: false

    signal taskSaved(var task, bool isNew)

    title: isEditing ? "Edit Task" : "New Task"
    modal: true
    width: 340
    height: 280
    x: (parent.width - width) / 2
    y: (parent.height - height) / 2

    property string currentMode: "countdown"

    function openWith(task) {
        editTask = task;
        isEditing = true;
        descField.text = task.description;
        currentMode = task.timerMode || "countdown";
        if (currentMode === "countdown" && task.countdownSeconds) {
            var cs = task.countdownSeconds;
            hoursField.value = Math.floor(cs / 3600);
            minutesField.value = Math.floor((cs % 3600) / 60);
            secondsField.value = cs % 60;
        }
        open();
    }

    onOpened: {
        if (!isEditing) {
            descField.text = "";
            currentMode = "countdown";
            hoursField.value = 0;
            minutesField.value = 0;
            secondsField.value = 0;
            absHourField.value = 12;
            absMinField.value = 0;
            ampmSwitch.checked = true;
        }
        descField.forceActiveFocus();
    }

    onClosed: {
        isEditing = false;
        editTask = null;
    }

    footer: DialogButtonBox {
        PlasmaComponents.Button {
            text: "Cancel"
            DialogButtonBox.buttonRole: DialogButtonBox.RejectRole
        }
        PlasmaComponents.Button {
            text: isEditing ? "Save" : "Start Task"
            DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole
        }
    }

    onAccepted: {
        var desc = descField.text.trim();
        if (!desc) return;

        var task = isEditing ? editTask : {
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
            if (!ampmSwitch.checked) { if (ah === 12) ah = 0; }
            else { if (ah !== 12) ah += 12; }
            var target = new Date();
            target.setHours(ah, am, 0, 0);
            task.targetTime = target.toISOString();
            task.countdownSeconds = null;
        }

        dialog.taskSaved(task, !isEditing);
        close();
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 12
        spacing: 10

        PlasmaComponents.Label { text: "Description" }
        PlasmaComponents.TextField {
            id: descField
            Layout.fillWidth: true
            placeholderText: "e.g. Lunch break"
        }

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

        // Countdown
        RowLayout {
            visible: currentMode === "countdown"
            PlasmaComponents.Label { text: "H:" }
            SpinBox { id: hoursField; from: 0; to: 23; value: 0; implicitWidth: 70 }
            PlasmaComponents.Label { text: "M:" }
            SpinBox { id: minutesField; from: 0; to: 59; value: 0; implicitWidth: 70 }
            PlasmaComponents.Label { text: "S:" }
            SpinBox { id: secondsField; from: 0; to: 59; value: 0; implicitWidth: 70 }
        }

        // Absolute
        RowLayout {
            visible: currentMode === "absolute"
            SpinBox { id: absHourField; from: 1; to: 12; value: 12; implicitWidth: 70 }
            PlasmaComponents.Label { text: ":" }
            SpinBox { id: absMinField; from: 0; to: 59; value: 0; implicitWidth: 70 }
            PlasmaComponents.Switch {
                id: ampmSwitch
                text: checked ? "PM" : "AM"
                checked: true
            }
        }
    }
}
