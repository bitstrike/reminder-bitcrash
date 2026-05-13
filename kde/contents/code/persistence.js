// Task persistence - read/write ~/.config/reminder@bitcrash/tasks.json
.pragma library

function getDataDir() {
    var home = Qt.resolvedUrl("file://" + StandardPaths.writableLocation(StandardPaths.ConfigLocation));
    return StandardPaths.writableLocation(StandardPaths.ConfigLocation) + "/reminder@bitcrash";
}

function getDataPath() {
    return getDataDir() + "/tasks.json";
}

function loadTasks() {
    var xhr = new XMLHttpRequest();
    var path = getDataPath();
    try {
        xhr.open("GET", "file://" + path, false);
        xhr.send();
        if (xhr.status === 200 && xhr.responseText) {
            return JSON.parse(xhr.responseText);
        }
    } catch (e) {
        console.error("reminder@bitcrash: Failed to load tasks: " + e.message);
    }
    return [];
}

function saveTasks(tasks) {
    var path = getDataPath();
    var dir = getDataDir();
    // Ensure directory exists via a process call
    var json = JSON.stringify(tasks, null, 2);
    try {
        var xhr = new XMLHttpRequest();
        xhr.open("PUT", "file://" + path, false);
        xhr.send(json);
    } catch (e) {
        // Fallback: use Qt.labs.platform or process
        console.error("reminder@bitcrash: Failed to save tasks: " + e.message);
    }
}

function generateId() {
    return "t" + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}
