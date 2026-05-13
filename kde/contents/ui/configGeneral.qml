import QtQuick 2.15
import QtQuick.Layouts 1.15
import QtQuick.Controls 2.15
import org.kde.kirigami 2.20 as Kirigami

Kirigami.FormLayout {
    id: configPage

    property alias cfg_notifyPastDue: notifyPastDueCheck.checked
    property alias cfg_enableCountdownReminders: countdownCheck.checked
    property alias cfg_respectValarm: valarmCheck.checked
    property alias cfg_enableSound: soundCheck.checked
    property alias cfg_soundFile: soundFileField.text
    property alias cfg_allDayReminderHour: allDayHourSpin.value
    property alias cfg_allDayReminderMinute: allDayMinSpin.value
    property alias cfg_caldavUrl: caldavUrlField.text
    property alias cfg_browserCommand: browserCmdField.text

    // Notifications section
    Kirigami.Separator {
        Kirigami.FormData.isSection: true
        Kirigami.FormData.label: "Notifications"
    }

    CheckBox {
        id: notifyPastDueCheck
        Kirigami.FormData.label: "Notify past due at startup:"
        text: "Show notifications for tasks that expired while not running"
    }

    CheckBox {
        id: countdownCheck
        Kirigami.FormData.label: "T-15 / T-5 reminders:"
        text: "Enable pre-event countdown reminders"
    }

    CheckBox {
        id: valarmCheck
        Kirigami.FormData.label: "Respect VALARM:"
        text: "Fire notifications at calendar-defined alarm times"
    }

    // All-day reminder time
    Kirigami.Separator {
        Kirigami.FormData.isSection: true
        Kirigami.FormData.label: "All-Day Events"
    }

    SpinBox {
        id: allDayHourSpin
        Kirigami.FormData.label: "Reminder hour (0-23):"
        from: 0
        to: 23
    }

    SpinBox {
        id: allDayMinSpin
        Kirigami.FormData.label: "Reminder minute (0-59):"
        from: 0
        to: 59
        stepSize: 5
    }

    // Sound section
    Kirigami.Separator {
        Kirigami.FormData.isSection: true
        Kirigami.FormData.label: "Sound"
    }

    CheckBox {
        id: soundCheck
        Kirigami.FormData.label: "Play sound:"
        text: "Play audio when a reminder fires"
    }

    TextField {
        id: soundFileField
        Kirigami.FormData.label: "Sound file path:"
        placeholderText: "/path/to/sound.wav"
        Layout.fillWidth: true
    }

    // Nextcloud section
    Kirigami.Separator {
        Kirigami.FormData.isSection: true
        Kirigami.FormData.label: "Nextcloud"
    }

    TextField {
        id: caldavUrlField
        Kirigami.FormData.label: "Server URL:"
        placeholderText: "https://cloud.example.com"
        Layout.fillWidth: true
    }

    TextField {
        id: browserCmdField
        Kirigami.FormData.label: "Browser command:"
        placeholderText: "firefox %u (blank for default)"
        Layout.fillWidth: true
    }
}
