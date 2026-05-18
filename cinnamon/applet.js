const Applet = imports.ui.applet;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Mainloop = imports.mainloop;

const UUID = "reminder@bitcrash";
const MAX_TASKS = 100;

// Import local Nextcloud module
const AppletDir = imports.ui.appletManager.appletMeta[UUID].path;
imports.searchPath.unshift(AppletDir);
const Nextcloud = imports.nextcloud;

// ---- Utility functions ----
function _generateId() {
    return "t" + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function _padTwo(n) {
    return n < 10 ? "0" + n : "" + n;
}

function _formatCountdown(totalSeconds) {
    if (totalSeconds <= 0) return "0:00";
    let h = Math.floor(totalSeconds / 3600);
    let m = Math.floor((totalSeconds % 3600) / 60);
    let s = totalSeconds % 60;
    if (h > 0) return h + ":" + _padTwo(m) + ":" + _padTwo(s);
    return m + ":" + _padTwo(s);
}

function _formatTimeAmPm(date) {
    let h = date.getHours();
    let m = date.getMinutes();
    let ampm = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    return h + ":" + _padTwo(m) + " " + ampm;
}

function _isToday(dateStr) {
    let d = new Date(dateStr);
    let now = new Date();
    return d.getFullYear() === now.getFullYear() &&
           d.getMonth() === now.getMonth() &&
           d.getDate() === now.getDate();
}

function _isYesterday(dateStr) {
    let d = new Date(dateStr);
    let yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return d.getFullYear() === yesterday.getFullYear() &&
           d.getMonth() === yesterday.getMonth() &&
           d.getDate() === yesterday.getDate();
}

// ---- Data persistence ----
function _getDataDir() {
    let dir = GLib.build_filenamev([GLib.get_user_config_dir(), UUID]);
    GLib.mkdir_with_parents(dir, 0o755);
    return dir;
}

function _getDataPath() {
    return GLib.build_filenamev([_getDataDir(), "tasks.json"]);
}

function _loadTasks() {
    let path = _getDataPath();
    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return [];
    try {
        let [ok, contents] = GLib.file_get_contents(path);
        if (ok) return JSON.parse(contents.toString());
    } catch (e) {
        global.logError(UUID + ": Failed to load tasks: " + e.message);
    }
    return [];
}

function _saveTasks(tasks) {
    try {
        let path = _getDataPath();
        let json = JSON.stringify(tasks, null, 2);
        GLib.file_set_contents(path, json);
    } catch (e) {
        global.logError(UUID + ": Failed to save tasks: " + e.message);
    }
}

// ---- Applet ----
class ReminderApplet extends Applet.TextIconApplet {
    constructor(orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.set_applet_icon_symbolic_name("alarm-symbolic");

        // Settings
        this.settings = new Settings.AppletSettings(this, UUID, instanceId);
        this.settings.bind("notifyPastDue", "notifyPastDue");
        this.settings.bind("respectValarm", "respectValarm");
        this.settings.bind("enableCountdownReminders", "enableCountdownReminders");
        this.settings.bind("allDayReminderHour", "allDayReminderHour");
        this.settings.bind("allDayReminderMinute", "allDayReminderMinute");
        this.settings.bind("enableSound", "enableSound");
        this.settings.bind("soundFile", "soundFile");
        this.settings.bind("caldavUrl", "caldavUrl");
        this.settings.bind("caldavCalendars", "caldavCalendars");
        this.settings.bind("browserCommand", "browserCommand");

        // Nextcloud state (credentials in memory only)
        this._ncConnected = false;
        this._ncLoginName = null;
        this._ncAppPassword = null;
        this._ncPollId = null;
        this._syncId = null;
        this._syncInProgress = false;
        this._manualSyncRequested = false;
        this._authFailed = false;
        this._lastSyncTime = null;
        this._syncFailCount = 0;

        // Task data
        this.tasks = _loadTasks();
        this.calendarEvents = []; // populated by sync, not persisted
        this._recalcCountdownTargets();

        // Load Nextcloud credentials (must be after calendarEvents init)
        this._tryLoadNcCredentials();

        // Auto-dismiss expired items at startup if user opted out of past-due notifications
        if (!this.notifyPastDue) {
            let now = Date.now();
            for (let task of this.tasks) {
                if (task.completed || task.dismissed) continue;
                if (task.targetTime && new Date(task.targetTime).getTime() <= now) {
                    task.dismissed = true;
                }
            }
            for (let event of this.calendarEvents) {
                if (event.completed || event.dismissed) continue;
                if (event.day === "tomorrow") continue;
                if (event.targetTime && new Date(event.targetTime).getTime() <= now) {
                    event.dismissed = true;
                }
            }
            _saveTasks(this.tasks);
        }

        this._updateTooltip();

        // Menu
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        // Throb state
        this._throbId = null;
        this._throbOn = false;
        this._throbIndex = 0;

        // Tick timer - updates countdowns every second
        this._tickId = null;
        this._startTime = Date.now();
        this._startTick();
        this._updatePanelLabel();
    }

    // On startup, for countdown tasks that were running, recalculate their
    // absolute target from the saved targetTime so they resume correctly.
    _recalcCountdownTargets() {
        // Nothing special needed - countdown tasks store targetTime as
        // the absolute epoch when they fire. On reload we just compare
        // against Date.now().
    }

    // ---- Tick loop ----
    _startTick() {
        if (this._tickId) return;
        this._tickId = Mainloop.timeout_add_seconds(1, Lang.bind(this, this._onTick));
    }

    _stopTick() {
        if (this._tickId) {
            Mainloop.source_remove(this._tickId);
            this._tickId = null;
        }
    }

    _onTick() {
        let now = Date.now();
        let fired = false;
        for (let task of this.tasks) {
            if (task.completed || task.dismissed) continue;
            if (!task.targetTime) continue;
            let target = new Date(task.targetTime).getTime();

            // If event already started, skip pre-event reminders (mark silently)
            // and let _fireNotification be the sole notification
            if (target <= now) {
                task._notified15 = true;
                task._notified5 = true;
            } else {
                // Collect all reminders that would fire this tick
                let pending = [];

                if (this.enableCountdownReminders && task._remind15 && !task._notified15) {
                    let t15 = target - 15 * 60 * 1000;
                    if (t15 <= now) {
                        pending.push({
                            triggerTime: t15,
                            mark: function() { task._notified15 = true; },
                            notify: function() {
                                let remaining = Math.max(0, Math.floor((target - now) / 60000));
                                Main.notify("Task Reminder", task.description + " in " + remaining + " min");
                            }
                        });
                    }
                }
                if (this.enableCountdownReminders && task._remind5 && !task._notified5) {
                    let t5 = target - 5 * 60 * 1000;
                    if (t5 <= now) {
                        pending.push({
                            triggerTime: t5,
                            mark: function() { task._notified5 = true; },
                            notify: function() {
                                let remaining = Math.max(0, Math.floor((target - now) / 60000));
                                Main.notify("Task Reminder", task.description + " in " + remaining + " min");
                            }
                        });
                    }
                }

                // Fire only the most relevant (latest trigger time) reminder
                if (pending.length > 0) {
                    pending.sort(function(a, b) { return b.triggerTime - a.triggerTime; });
                    for (let i = 0; i < pending.length; i++) {
                        pending[i].mark();
                        if (i === 0) {
                            if (this.notifyPastDue || pending[i].triggerTime >= this._startTime) {
                                fired = true;
                                pending[i].notify();
                                if (this.enableSound && this.soundFile) this._playSound();
                            }
                        }
                    }
                }
            }

            // Start time notification
            if (target <= now && !task._notified) {
                task._notified = true;
                if (!this.notifyPastDue && target < this._startTime) continue;
                fired = true;
                this._fireNotification(task);
            }
        }
        for (let event of this.calendarEvents) {
            if (event.completed || event.dismissed) continue;
            if (event.day === "tomorrow") continue;
            if (!event.targetTime) continue;
            let target = new Date(event.targetTime).getTime();

            // If event already started, skip pre-event reminders (mark silently)
            // and let _fireNotification be the sole notification
            if (target <= now) {
                event._notified15 = true;
                event._notified5 = true;
                if (event.alarms) {
                    if (!event._valarmNotified) event._valarmNotified = {};
                    for (let mins of event.alarms) {
                        event._valarmNotified[mins] = true;
                    }
                }
            } else {
                // Collect all reminders that would fire this tick
                let pending = [];

                if (this.enableCountdownReminders && event._remind15 && !event._notified15) {
                    let t15 = target - 15 * 60 * 1000;
                    if (t15 <= now) {
                        pending.push({
                            triggerTime: t15,
                            mark: function() { event._notified15 = true; },
                            notify: function() {
                                let remaining = Math.max(0, Math.floor((target - now) / 60000));
                                Main.notify("Task Reminder", event.description + " in " + remaining + " min");
                            }
                        });
                    }
                }
                if (this.enableCountdownReminders && event._remind5 && !event._notified5) {
                    let t5 = target - 5 * 60 * 1000;
                    if (t5 <= now) {
                        pending.push({
                            triggerTime: t5,
                            mark: function() { event._notified5 = true; },
                            notify: function() {
                                let remaining = Math.max(0, Math.floor((target - now) / 60000));
                                Main.notify("Task Reminder", event.description + " in " + remaining + " min");
                            }
                        });
                    }
                }
                if (this.respectValarm && event.alarms && event.alarms.length > 0) {
                    if (!event._valarmNotified) event._valarmNotified = {};
                    if (!event._valarmEnabled) event._valarmEnabled = {};
                    for (let mins of event.alarms) {
                        if (event._valarmEnabled[mins] === false) continue;
                        if (event._valarmEnabled[mins] === undefined) event._valarmEnabled[mins] = true;
                        if (event._valarmNotified[mins]) continue;
                        let triggerTime = target - mins * 60 * 1000;
                        if (triggerTime <= now) {
                            let m = mins; // capture for closure
                            pending.push({
                                triggerTime: triggerTime,
                                mark: function() { event._valarmNotified[m] = true; },
                                notify: function() {
                                    let remaining = Math.max(0, Math.floor((target - now) / 60000));
                                    let label;
                                    if (remaining >= 60) {
                                        label = Math.floor(remaining / 60) + "h" + (remaining % 60 > 0 ? remaining % 60 + "m" : "");
                                    } else {
                                        label = remaining + " min";
                                    }
                                    Main.notify("Task Reminder", event.description + " in " + label);
                                }
                            });
                        }
                    }
                }

                // Fire only the most relevant (latest trigger time) reminder
                if (pending.length > 0) {
                    pending.sort(function(a, b) { return b.triggerTime - a.triggerTime; });
                    for (let i = 0; i < pending.length; i++) {
                        pending[i].mark();
                        if (i === 0) {
                            if (this.notifyPastDue || pending[i].triggerTime >= this._startTime) {
                                fired = true;
                                pending[i].notify();
                                if (this.enableSound && this.soundFile) this._playSound();
                            }
                        }
                    }
                }
            }

            // Start time notification
            if (target <= now && !event._notified) {
                event._notified = true;
                if (!this.notifyPastDue && target < this._startTime) continue;
                fired = true;
                this._fireNotification(event);
            }
        }
        if (fired) _saveTasks(this.tasks);
        this._updatePanelLabel();
        // Manage throb - pause while menu is open
        if (!this.menu.isOpen) {
            if (this._hasUnhandledExpired()) this._startThrob();
            else this._stopThrob();
        }
        // Refresh popup if open
        if (this.menu.isOpen) this._rebuildMenu();

        // Nag: re-notify every 5 min for expired unchecked items (1 at a time)
        let nagCandidate = null;
        let nagCandidateTime = Infinity;
        let allItems = this.tasks.concat(this.calendarEvents);
        for (let item of allItems) {
            if (item.completed || item.dismissed) continue;
            if (item.day === "tomorrow") continue;
            if (!item._notified) continue;
            if (!item.targetTime) continue;
            if (!item._lastNagTime) item._lastNagTime = new Date(item.targetTime).getTime();
            if (now - item._lastNagTime >= 300000) {
                if (item._lastNagTime < nagCandidateTime) {
                    nagCandidate = item;
                    nagCandidateTime = item._lastNagTime;
                }
            }
        }
        if (nagCandidate) {
            nagCandidate._lastNagTime = now;
            Main.notify("Task Overdue", nagCandidate.description + " - still pending");
            if (this.enableSound && this.soundFile) this._playSound();
        }

        return true; // keep running
    }

    // ---- Notifications ----
    _fireNotification(task) {
        let msg = task.description;
        if (task.timerMode === "absolute") {
            msg += " - " + _formatTimeAmPm(new Date(task.targetTime));
        } else {
            msg += " - countdown finished";
        }
        Main.notify("Task Reminder", msg);
        if (this.enableSound && this.soundFile) {
            this._playSound();
        }
    }

    // ---- Panel label ----
    _updatePanelLabel() {
        let next = this._getNextActiveTask();
        if (!next) {
            this.set_applet_label("No tasks pending");
            return;
        }
        let now = Date.now();
        let target = new Date(next.targetTime).getTime();
        let remaining = Math.max(0, Math.floor((target - now) / 1000));
        let desc = next.description;
        if (desc.length > 15) desc = desc.substring(0, 14) + "\u2026";
        if (remaining <= 0) {
            this.set_applet_label(desc + " - expired");
        } else {
            this.set_applet_label(desc + " - " + _formatCountdown(remaining));
        }
    }

    _getNextActiveTask() {
        let now = Date.now();
        let best = null;
        let bestTime = Infinity;
        let allItems = this.tasks.concat(this.calendarEvents);
        for (let task of allItems) {
            if (task.completed || task.dismissed) continue;
            if (task.day === "tomorrow") continue;
            if (!task.targetTime) continue;
            let t = new Date(task.targetTime).getTime();
            let diff = t - now;
            if (diff > -3600000 && t < bestTime) {
                bestTime = t;
                best = task;
            }
        }
        return best;
    }

    // ---- Throb ----
    _hasUnhandledExpired() {
        let now = Date.now();
        for (let task of this.tasks) {
            if (task.completed || task.dismissed) continue;
            if (!task.targetTime) continue;
            if (new Date(task.targetTime).getTime() <= now) return true;
        }
        for (let event of this.calendarEvents) {
            if (event.completed || event.dismissed) continue;
            if (event.day === "tomorrow") continue;
            if (new Date(event.targetTime).getTime() <= now) return true;
        }
        return false;
    }

    _getExpiredTasks() {
        let now = Date.now();
        let expired = this.tasks.filter(t =>
            !t.completed && !t.dismissed && t.targetTime &&
            new Date(t.targetTime).getTime() <= now
        );
        let expiredCal = this.calendarEvents.filter(e =>
            !e.completed && !e.dismissed && e.day !== "tomorrow" &&
            new Date(e.targetTime).getTime() <= now
        );
        return expired.concat(expiredCal);
    }

    _startThrob() {
        if (this._throbId) return;
        this._throbOn = false;
        this._throbIndex = 0;
        this._throbId = Mainloop.timeout_add(500, Lang.bind(this, function () {
            this._throbOn = !this._throbOn;
            this.actor.set_style(this._throbOn ? "background-color: rgba(255, 80, 80, 0.6);" : null);
            // Cycle label through expired tasks on each full pulse (off->on)
            if (this._throbOn) {
                let expired = this._getExpiredTasks();
                if (expired.length > 0) {
                    let task = expired[this._throbIndex % expired.length];
                    let desc = task.description;
                    if (desc.length > 15) desc = desc.substring(0, 14) + "\u2026";
                    this.set_applet_label(desc + " - expired");
                    this._throbIndex++;
                }
            }
            return true;
        }));
    }

    _stopThrob() {
        if (!this._throbId) return;
        Mainloop.source_remove(this._throbId);
        this._throbId = null;
        this._throbOn = false;
        this._throbIndex = 0;
        this.actor.set_style(null);
        this._updatePanelLabel();
    }

    // ---- Menu building ----
    on_applet_clicked() {
        this._stopThrob();
        this._rebuildMenu();
        this.menu.toggle();
    }

    _rebuildMenu() {
        this.menu.removeAll();

        // Header with buttons
        let headerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        let headerBox = new St.BoxLayout({ style_class: "reminder-header" });
        let titleLabel = new St.Label({
            text: "Tasks",
            style_class: "reminder-header-label",
            y_align: Clutter.ActorAlign.CENTER
        });
        headerBox.add_child(titleLabel);

        // Spacer
        let spacer = new St.Widget({ x_expand: true });
        headerBox.add_child(spacer);

        // Dismiss All Old button
        let hasOld = this.tasks.some(t => !t.dismissed && this._isExpiredOrStale(t));
        if (hasOld) {
            let dismissAllBtn = this._makeButton("Dismiss All Old", "reminder-btn reminder-btn-danger", () => {
                this._dismissAllOld();
            });
            headerBox.add_child(dismissAllBtn);
        }

        // New Task button
        let newBtn = this._makeButton("+ New Task", "reminder-btn reminder-btn-primary", () => {
            this.menu.close();
            this._showNewTaskForm(null);
        });
        headerBox.add_child(newBtn);
        headerItem.addActor(headerBox);
        this.menu.addMenuItem(headerItem);

        // Separator
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Task list - merge manual tasks and calendar events, sorted by target time
        let visibleTasks = this.tasks.filter(t => !t.dismissed);
        let visibleCalEvents = this.calendarEvents.filter(e => !e.dismissed && e.day !== "tomorrow");
        let allItems = visibleTasks.concat(visibleCalEvents);
        allItems.sort((a, b) => {
            let ta = a.targetTime ? new Date(a.targetTime).getTime() : Infinity;
            let tb = b.targetTime ? new Date(b.targetTime).getTime() : Infinity;
            return ta - tb;
        });

        if (allItems.length === 0) {
            let emptyItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            let emptyLabel = new St.Label({
                text: "No tasks. Click '+ New Task' to add one.",
                style_class: "reminder-no-tasks"
            });
            emptyItem.addActor(emptyLabel);
            this.menu.addMenuItem(emptyItem);
        } else {
            for (let item of allItems) {
                if (item.source === "calendar") {
                    this._addCalendarEventRow(item);
                } else {
                    this._addTaskRow(item);
                }
            }
        }

        // Tomorrow section (view-only)
        let tomorrowEvents = this.calendarEvents.filter(e => !e.dismissed && e.day === "tomorrow");
        tomorrowEvents.sort((a, b) => {
            let ta = a.targetTime ? new Date(a.targetTime).getTime() : Infinity;
            let tb = b.targetTime ? new Date(b.targetTime).getTime() : Infinity;
            return ta - tb;
        });
        if (tomorrowEvents.length > 0) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            let tomorrowHeader = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            let tomorrowLabel = new St.Label({
                text: "Tomorrow",
                style_class: "reminder-tomorrow-header"
            });
            tomorrowHeader.addActor(tomorrowLabel);
            this.menu.addMenuItem(tomorrowHeader);
            for (let ev of tomorrowEvents) {
                this._addTomorrowEventRow(ev);
            }
        }
    }

    _isExpiredOrStale(task) {
        if (task.completed || task.dismissed) return false;
        if (!task.targetTime) return false;
        let target = new Date(task.targetTime).getTime();
        return target <= Date.now();
    }

    _addTaskRow(task) {
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        let container = new St.BoxLayout({
            style_class: "reminder-task-row",
            vertical: true
        });

        let isStale = !task.dismissed && !task.completed && task.targetTime &&
                      !_isToday(task.targetTime) &&
                      new Date(task.targetTime).getTime() < Date.now();
        let now = Date.now();
        let target = task.targetTime ? new Date(task.targetTime).getTime() : null;
        let expired = target && target <= now && !task.completed;

        // Line 1: [checkbox] [description] ... [buttons]
        let line1 = new St.BoxLayout({ style_class: "reminder-row-line1", vertical: false });

        // Checkbox
        let checkStyleClass = task.completed ? "reminder-checkbox-checked" : "reminder-checkbox";
        let checkBtn = new St.Button({ style_class: checkStyleClass });
        if (task.completed) checkBtn.set_label("\u2713");
        checkBtn.connect("clicked", () => {
            task.completed = !task.completed;
            _saveTasks(this.tasks);
            this._rebuildMenu();
            this._updatePanelLabel();
        });
        line1.add_child(checkBtn);

        // Description
        let descClass = "reminder-task-desc";
        if (task.completed) descClass = "reminder-task-desc-done";
        else if (isStale) descClass = "reminder-task-desc-stale";
        let descLabel = new St.Label({
            text: task.description,
            style_class: descClass,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        line1.add_child(descLabel);

        // Action buttons
        if (task.completed) {
            let dismissBtn = this._makeButton("Dismiss", "reminder-task-btn", () => {
                task.dismissed = true;
                _saveTasks(this.tasks);
                this._rebuildMenu();
                this._updatePanelLabel();
            });
            line1.add_child(dismissBtn);
        } else {
            // T-15 and T-5 toggles for upcoming tasks
            let upcoming = target && target > now;
            if (upcoming && this.enableCountdownReminders) {
                if (task._remind15 === undefined) task._remind15 = true;
                if (task._remind5 === undefined) task._remind5 = true;

                let t15Class = task._remind15 ? "reminder-toggle-t-active" : "reminder-toggle-t-inactive";
                let t15Btn = new St.Button({ label: "T-15", style_class: t15Class });
                t15Btn.connect("clicked", () => {
                    task._remind15 = !task._remind15;
                    _saveTasks(this.tasks);
                    this._rebuildMenu();
                });
                line1.add_child(t15Btn);

                let t5Class = task._remind5 ? "reminder-toggle-t-active" : "reminder-toggle-t-inactive";
                let t5Btn = new St.Button({ label: "T-5", style_class: t5Class });
                t5Btn.connect("clicked", () => {
                    task._remind5 = !task._remind5;
                    _saveTasks(this.tasks);
                    this._rebuildMenu();
                });
                line1.add_child(t5Btn);
            }

            let editBtn = this._makeButton("Edit", "reminder-task-btn", () => {
                this.menu.close();
                this._showNewTaskForm(task);
            });
            line1.add_child(editBtn);

            if (expired || isStale) {
                let dismissBtn = this._makeButton("Dismiss", "reminder-task-btn", () => {
                    task.dismissed = true;
                    _saveTasks(this.tasks);
                    this._rebuildMenu();
                    this._updatePanelLabel();
                });
                line1.add_child(dismissBtn);
            } else {
                let cancelBtn = this._makeButton("Cancel", "reminder-task-btn", () => {
                    task.dismissed = true;
                    _saveTasks(this.tasks);
                    this._rebuildMenu();
                    this._updatePanelLabel();
                });
                line1.add_child(cancelBtn);
            }
        }
        container.add_child(line1);

        // Line 2: meta info
        let line2 = new St.BoxLayout({ style_class: "reminder-row-line2" });

        if (isStale) {
            let badge = new St.Label({
                text: _isYesterday(task.targetTime) ? "YESTERDAY" : "OLD",
                style_class: "reminder-badge reminder-badge-stale"
            });
            line2.add_child(badge);
            let timeLabel = new St.Label({
                text: "was " + _formatTimeAmPm(new Date(task.targetTime)),
                style_class: "reminder-task-meta"
            });
            line2.add_child(timeLabel);
        } else if (expired) {
            let badge = new St.Label({ text: "EXPIRED", style_class: "reminder-badge reminder-badge-expired" });
            line2.add_child(badge);
            let timeLabel = new St.Label({
                text: "was " + _formatTimeAmPm(new Date(task.targetTime)),
                style_class: "reminder-task-meta"
            });
            line2.add_child(timeLabel);
        } else if (task.completed) {
            let badge = new St.Label({
                text: task.timerMode === "countdown" ? "COUNTDOWN" : _formatTimeAmPm(new Date(task.targetTime)),
                style_class: "reminder-badge " + (task.timerMode === "countdown" ? "reminder-badge-countdown" : "reminder-badge-absolute")
            });
            line2.add_child(badge);
            let doneLabel = new St.Label({ text: "Done", style_class: "reminder-task-meta" });
            doneLabel.set_style("color: #6b6;");
            line2.add_child(doneLabel);
        } else if (target) {
            let remaining = Math.max(0, Math.floor((target - now) / 1000));
            if (task.timerMode === "countdown") {
                let badge = new St.Label({ text: "COUNTDOWN", style_class: "reminder-badge reminder-badge-countdown" });
                line2.add_child(badge);
                let timeLabel = new St.Label({
                    text: _formatCountdown(remaining) + " remaining",
                    style_class: "reminder-task-meta"
                });
                line2.add_child(timeLabel);
            } else {
                let badge = new St.Label({
                    text: _formatTimeAmPm(new Date(task.targetTime)),
                    style_class: "reminder-badge reminder-badge-absolute"
                });
                line2.add_child(badge);
                let timeLabel = new St.Label({
                    text: _formatCountdown(remaining) + " left",
                    style_class: "reminder-task-meta"
                });
                line2.add_child(timeLabel);
            }
        }
        container.add_child(line2);

        item.addActor(container);
        this.menu.addMenuItem(item);
    }

    _makeButton(label, styleClass, callback) {
        let btn = new St.Button({ label: label, style_class: styleClass });
        btn.connect("clicked", callback);
        return btn;
    }

    _addCalendarEventRow(event) {
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        let now = Date.now();
        let start = new Date(event.targetTime).getTime();
        let end = event.endTime ? new Date(event.endTime).getTime() : start;
        let upcoming = start > now;
        let inProgress = start <= now && end > now;
        let past = end <= now;
        let acknowledged = event.completed;

        // Initialize reminder flags if not set
        if (event._remind15 === undefined) event._remind15 = true;
        if (event._remind5 === undefined) event._remind5 = true;

        // Determine container class for border color
        let calClass = "reminder-task-row reminder-cal-upcoming";
        if (acknowledged) calClass = "reminder-task-row reminder-cal-acknowledged";
        else if (past) calClass = "reminder-task-row reminder-cal-expired";
        else if (inProgress) calClass = "reminder-task-row reminder-cal-inprogress";

        let container = new St.BoxLayout({
            style_class: calClass,
            vertical: true
        });

        // Line 1: [checkbox] [description] [T-15] [T-5] [Dismiss]
        let line1 = new St.BoxLayout({ style_class: "reminder-row-line1", vertical: false });

        // Checkbox for acknowledgment
        let checkStyleClass = acknowledged ? "reminder-checkbox-checked" : "reminder-checkbox";
        let checkBtn = new St.Button({ style_class: checkStyleClass });
        if (acknowledged) checkBtn.set_label("\u2713");
        checkBtn.connect("clicked", () => {
            event.completed = !event.completed;
            this._rebuildMenu();
            this._updatePanelLabel();
        });
        line1.add_child(checkBtn);

        // Description
        let descStyle = acknowledged ? "reminder-task-desc-done" : "reminder-task-desc";
        let descLabel = new St.Label({
            text: event.description,
            style_class: descStyle,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        line1.add_child(descLabel);

        // T-15 and T-5 toggles (only for upcoming events)
        if (upcoming && this.enableCountdownReminders) {
            let t15Class = event._remind15 ? "reminder-toggle-t-active" : "reminder-toggle-t-inactive";
            let t15Btn = new St.Button({ label: "T-15", style_class: t15Class });
            t15Btn.connect("clicked", () => {
                event._remind15 = !event._remind15;
                this._rebuildMenu();
            });
            line1.add_child(t15Btn);

            let t5Class = event._remind5 ? "reminder-toggle-t-active" : "reminder-toggle-t-inactive";
            let t5Btn = new St.Button({ label: "T-5", style_class: t5Class });
            t5Btn.connect("clicked", () => {
                event._remind5 = !event._remind5;
                this._rebuildMenu();
            });
            line1.add_child(t5Btn);
        }

        // VALARM toggle buttons
        if (upcoming && this.respectValarm && event.alarms && event.alarms.length > 0) {
            if (!event._valarmEnabled) event._valarmEnabled = {};
            for (let mins of event.alarms) {
                if (mins === 15 || mins === 5) continue; // skip duplicates of T-15/T-5
                if (event._valarmEnabled[mins] === undefined) event._valarmEnabled[mins] = true;
                let label = mins >= 60 ? "V-" + Math.floor(mins / 60) + "h" : "V-" + mins;
                let vClass = event._valarmEnabled[mins] ? "reminder-toggle-v-active" : "reminder-toggle-v-inactive";
                let vBtn = new St.Button({ label: label, style_class: vClass });
                let m = mins; // capture for closure
                vBtn.connect("clicked", () => {
                    event._valarmEnabled[m] = !event._valarmEnabled[m];
                    this._rebuildMenu();
                });
                line1.add_child(vBtn);
            }
        }

        // Dismiss button
        let dismissBtn = this._makeButton("Dismiss", "reminder-task-btn", () => {
            event.dismissed = true;
            this._rebuildMenu();
            this._updatePanelLabel();
        });
        line1.add_child(dismissBtn);

        container.add_child(line1);

        // Line 2: badges + time range
        let line2 = new St.BoxLayout({ style_class: "reminder-row-line2" });

        // CAL badge
        let calBadge = new St.Label({ text: "CAL", style_class: "reminder-badge reminder-badge-cal" });
        line2.add_child(calBadge);

        // State badge
        if (past && !acknowledged) {
            let expBadge = new St.Label({ text: "EXPIRED", style_class: "reminder-badge reminder-badge-expired" });
            line2.add_child(expBadge);
        } else if (inProgress && !acknowledged) {
            let nowBadge = new St.Label({ text: "NOW", style_class: "reminder-badge reminder-badge-now" });
            line2.add_child(nowBadge);
        } else if (acknowledged) {
            let ackLabel = new St.Label({ text: "Acknowledged", style_class: "reminder-task-meta" });
            ackLabel.set_style("color: #6b6;");
            line2.add_child(ackLabel);
        }

        // Time range
        let timeText;
        if (event.allDay) {
            timeText = "ALL DAY";
        } else {
            timeText = _formatTimeAmPm(new Date(event.targetTime));
            if (event.endTime) {
                timeText += " - " + _formatTimeAmPm(new Date(event.endTime));
            }
        }
        let timeLabel = new St.Label({ text: timeText, style_class: "reminder-task-meta" });
        line2.add_child(timeLabel);

        // Countdown
        if (upcoming) {
            let remaining = Math.max(0, Math.floor((start - now) / 1000));
            let countLabel = new St.Label({ text: "in " + _formatCountdown(remaining), style_class: "reminder-badge reminder-badge-countdown" });
            line2.add_child(countLabel);
        } else if (inProgress) {
            let remaining = Math.max(0, Math.floor((end - now) / 1000));
            let countLabel = new St.Label({ text: _formatCountdown(remaining) + " left", style_class: "reminder-badge reminder-badge-now" });
            line2.add_child(countLabel);
        }

        container.add_child(line2);
        item.addActor(container);
        this.menu.addMenuItem(item);
    }

    _addTomorrowEventRow(event) {
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        let container = new St.BoxLayout({
            style_class: "reminder-task-row reminder-cal-tomorrow",
            vertical: true
        });

        // Line 1: time + description (no buttons)
        let line1 = new St.BoxLayout({ style_class: "reminder-row-line1", vertical: false });

        let timeText;
        if (event.allDay) {
            timeText = "ALL DAY";
        } else {
            timeText = _formatTimeAmPm(new Date(event.targetTime));
            if (event.endTime) {
                timeText += " - " + _formatTimeAmPm(new Date(event.endTime));
            }
        }
        let timeLabel = new St.Label({
            text: timeText,
            style_class: "reminder-tomorrow-time"
        });
        line1.add_child(timeLabel);

        let descLabel = new St.Label({
            text: event.description,
            style_class: "reminder-tomorrow-desc",
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        line1.add_child(descLabel);

        container.add_child(line1);
        item.addActor(container);
        this.menu.addMenuItem(item);
    }

    // ---- Dismiss all old ----
    _dismissAllOld() {
        for (let task of this.tasks) {
            if (this._isExpiredOrStale(task)) {
                task.dismissed = true;
            }
        }
        // Also dismiss completed tasks
        for (let task of this.tasks) {
            if (task.completed && !task.dismissed) {
                task.dismissed = true;
            }
        }
        // Dismiss acknowledged past calendar events
        let now = Date.now();
        for (let event of this.calendarEvents) {
            if (event.completed && !event.dismissed) {
                event.dismissed = true;
            }
            if (!event.dismissed && event.targetTime && new Date(event.targetTime).getTime() <= now) {
                event.dismissed = true;
            }
        }
        _saveTasks(this.tasks);
        this._rebuildMenu();
        this._updatePanelLabel();
    }

    // ---- New/Edit task form (modal-style popup) ----
    _showNewTaskForm(existingTask) {
        let dialog = new imports.ui.modalDialog.ModalDialog();
        let contentBox = new St.BoxLayout({
            vertical: true,
            style: "spacing: 10px; padding: 10px; min-width: 340px;"
        });

        // Title
        let title = new St.Label({
            text: existingTask ? "Edit Task" : "New Task",
            style: "font-size: 14px; font-weight: bold; color: #eee; margin-bottom: 6px;"
        });
        contentBox.add_child(title);

        // Description
        let descLabel = new St.Label({ text: "Description", style_class: "reminder-form-label" });
        contentBox.add_child(descLabel);
        let descEntry = new St.Entry({
            style_class: "reminder-form-input",
            hint_text: "e.g. Lunch break",
            can_focus: true
        });
        if (existingTask) descEntry.set_text(existingTask.description);
        contentBox.add_child(descEntry);

        // Timer mode toggle
        let modeLabel = new St.Label({ text: "Timer Mode", style_class: "reminder-form-label" });
        contentBox.add_child(modeLabel);
        let modeBox = new St.BoxLayout({ style: "spacing: 0px;" });
        let countdownBtn = new St.Button({ label: "Countdown", style_class: "reminder-toggle-btn-active" });
        let absoluteBtn = new St.Button({ label: "Set Time (AM/PM)", style_class: "reminder-toggle-btn" });
        let currentMode = (existingTask && existingTask.timerMode === "absolute") ? "absolute" : "countdown";

        function updateModeButtons() {
            if (currentMode === "countdown") {
                countdownBtn.style_class = "reminder-toggle-btn-active";
                absoluteBtn.style_class = "reminder-toggle-btn";
                countdownRow.show();
                absoluteRow.hide();
            } else {
                countdownBtn.style_class = "reminder-toggle-btn";
                absoluteBtn.style_class = "reminder-toggle-btn-active";
                countdownRow.hide();
                absoluteRow.show();
            }
        }

        countdownBtn.connect("clicked", () => { currentMode = "countdown"; updateModeButtons(); });
        absoluteBtn.connect("clicked", () => { currentMode = "absolute"; updateModeButtons(); });
        modeBox.add_child(countdownBtn);
        modeBox.add_child(absoluteBtn);
        contentBox.add_child(modeBox);

        // Countdown inputs (h:m:s)
        let countdownRow = new St.BoxLayout({ style: "spacing: 6px;", vertical: false });
        let cdLabel = new St.Label({ text: "Duration", style_class: "reminder-form-label" });
        let hEntry = new St.Entry({ style_class: "reminder-time-input", hint_text: "HH", can_focus: true });
        hEntry.set_text("00");
        let sep1 = new St.Label({ text: ":", style_class: "reminder-time-sep" });
        let mEntry = new St.Entry({ style_class: "reminder-time-input", hint_text: "MM", can_focus: true });
        mEntry.set_text("00");
        let sep2 = new St.Label({ text: ":", style_class: "reminder-time-sep" });
        let sEntry = new St.Entry({ style_class: "reminder-time-input", hint_text: "SS", can_focus: true });
        sEntry.set_text("00");
        let hmsLabel = new St.Label({ text: "h : m : s", style: "font-size: 10px; color: #888; margin-left: 4px;" });

        if (existingTask && existingTask.timerMode === "countdown" && existingTask.countdownSeconds) {
            let cs = existingTask.countdownSeconds;
            hEntry.set_text(_padTwo(Math.floor(cs / 3600)));
            mEntry.set_text(_padTwo(Math.floor((cs % 3600) / 60)));
            sEntry.set_text(_padTwo(cs % 60));
        }

        countdownRow.add_child(hEntry);
        countdownRow.add_child(sep1);
        countdownRow.add_child(mEntry);
        countdownRow.add_child(sep2);
        countdownRow.add_child(sEntry);
        countdownRow.add_child(hmsLabel);

        let countdownGroup = new St.BoxLayout({ vertical: true, style: "spacing: 4px;" });
        countdownGroup.add_child(cdLabel);
        countdownGroup.add_child(countdownRow);
        contentBox.add_child(countdownGroup);

        // Alias for show/hide (updateModeButtons references countdownRow/absoluteRow)
        countdownRow = countdownGroup;

        // Absolute time inputs (hh:mm AM/PM)
        let absoluteGroup = new St.BoxLayout({ vertical: true, style: "spacing: 4px;" });
        let atLabel = new St.Label({ text: "Remind At", style_class: "reminder-form-label" });
        absoluteGroup.add_child(atLabel);
        let absRow = new St.BoxLayout({ style: "spacing: 6px;" });
        let absHEntry = new St.Entry({ style_class: "reminder-time-input", hint_text: "HH", can_focus: true });
        absHEntry.set_text("12");
        let absSep = new St.Label({ text: ":", style_class: "reminder-time-sep" });
        let absMEntry = new St.Entry({ style_class: "reminder-time-input", hint_text: "MM", can_focus: true });
        absMEntry.set_text("00");
        let ampmState = "PM";
        let amBtn = new St.Button({ label: "AM", style_class: "reminder-toggle-btn" });
        let pmBtn = new St.Button({ label: "PM", style_class: "reminder-toggle-btn-active" });

        function updateAmPm() {
            if (ampmState === "AM") {
                amBtn.style_class = "reminder-toggle-btn-active";
                pmBtn.style_class = "reminder-toggle-btn";
            } else {
                amBtn.style_class = "reminder-toggle-btn";
                pmBtn.style_class = "reminder-toggle-btn-active";
            }
        }

        amBtn.connect("clicked", () => { ampmState = "AM"; updateAmPm(); });
        pmBtn.connect("clicked", () => { ampmState = "PM"; updateAmPm(); });

        if (existingTask && existingTask.timerMode === "absolute" && existingTask.targetTime) {
            let d = new Date(existingTask.targetTime);
            let eh = d.getHours();
            ampmState = eh >= 12 ? "PM" : "AM";
            eh = eh % 12;
            if (eh === 0) eh = 12;
            absHEntry.set_text(_padTwo(eh));
            absMEntry.set_text(_padTwo(d.getMinutes()));
            updateAmPm();
        }

        absRow.add_child(absHEntry);
        absRow.add_child(absSep);
        absRow.add_child(absMEntry);
        absRow.add_child(amBtn);
        absRow.add_child(pmBtn);
        absoluteGroup.add_child(absRow);
        contentBox.add_child(absoluteGroup);

        let absoluteRow = absoluteGroup;

        // Conflict warning label
        let conflictLabel = new St.Label({
            text: "",
            style: "font-size: 10px; color: #f67b7b; margin-top: 2px;"
        });
        conflictLabel.hide();
        contentBox.add_child(conflictLabel);

        let self = this;
        function updateConflictWarning() {
            let targetMs;
            if (currentMode === "absolute") {
                let ah = parseInt(absHEntry.get_text()) || 12;
                let am = parseInt(absMEntry.get_text()) || 0;
                if (ampmState === "AM") {
                    if (ah === 12) ah = 0;
                } else {
                    if (ah !== 12) ah += 12;
                }
                let target = new Date();
                target.setHours(ah, am, 0, 0);
                targetMs = target.getTime();
            } else {
                let h = parseInt(hEntry.get_text()) || 0;
                let m = parseInt(mEntry.get_text()) || 0;
                let s = parseInt(sEntry.get_text()) || 0;
                let totalSec = h * 3600 + m * 60 + s;
                if (totalSec <= 0) {
                    conflictLabel.hide();
                    return;
                }
                targetMs = Date.now() + totalSec * 1000;
            }

            let conflicts = self._findConflicts(targetMs, existingTask);
            if (conflicts.length > 0) {
                let names = conflicts.map(c => c.description).join(", ");
                conflictLabel.set_text("Conflicts with: " + names);
                conflictLabel.show();
            } else {
                conflictLabel.hide();
            }
        }

        absHEntry.get_clutter_text().connect("text-changed", updateConflictWarning);
        absMEntry.get_clutter_text().connect("text-changed", updateConflictWarning);
        hEntry.get_clutter_text().connect("text-changed", updateConflictWarning);
        mEntry.get_clutter_text().connect("text-changed", updateConflictWarning);
        sEntry.get_clutter_text().connect("text-changed", updateConflictWarning);
        amBtn.connect("clicked", updateConflictWarning);
        pmBtn.connect("clicked", updateConflictWarning);
        countdownBtn.connect("clicked", updateConflictWarning);
        absoluteBtn.connect("clicked", updateConflictWarning);

        // Initial mode state
        updateModeButtons();
        updateConflictWarning();

        // Buttons
        let btnRow = new St.BoxLayout({ style: "spacing: 6px; margin-top: 8px;" });
        let btnSpacer = new St.Widget({ x_expand: true });
        btnRow.add_child(btnSpacer);

        let cancelFormBtn = this._makeButton("Cancel", "reminder-btn", () => {
            dialog.close();
            dialog.destroy();
        });
        btnRow.add_child(cancelFormBtn);

        let saveBtn = this._makeButton(existingTask ? "Save" : "Start Task", "reminder-btn reminder-btn-primary", () => {
            let desc = descEntry.get_text().trim();
            if (!desc) {
                descEntry.grab_key_focus();
                return;
            }
            if (this.tasks.filter(t => !t.dismissed).length >= MAX_TASKS && !existingTask) {
                Main.notify("Task Reminder", "Maximum of " + MAX_TASKS + " tasks reached. Dismiss old tasks first.");
                return;
            }
            let task = existingTask || {
                id: _generateId(),
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
                let h = parseInt(hEntry.get_text()) || 0;
                let m = parseInt(mEntry.get_text()) || 0;
                let s = parseInt(sEntry.get_text()) || 0;
                let totalSec = h * 3600 + m * 60 + s;
                if (totalSec <= 0) {
                    mEntry.grab_key_focus();
                    return;
                }
                task.countdownSeconds = totalSec;
                task.targetTime = new Date(Date.now() + totalSec * 1000).toISOString();
            } else {
                let ah = parseInt(absHEntry.get_text()) || 12;
                let am = parseInt(absMEntry.get_text()) || 0;
                // Convert 12h to 24h
                if (ampmState === "AM") {
                    if (ah === 12) ah = 0;
                } else {
                    if (ah !== 12) ah += 12;
                }
                let target = new Date();
                target.setHours(ah, am, 0, 0);
                // If time already passed today, it's still set for today
                // (user might want to track an expired deadline)
                task.targetTime = target.toISOString();
                task.countdownSeconds = null;
            }

            if (!existingTask) {
                this.tasks.push(task);
            }
            _saveTasks(this.tasks);
            this._updatePanelLabel();
            dialog.close();
            dialog.destroy();
        });
        btnRow.add_child(saveBtn);
        contentBox.add_child(btnRow);

        dialog.contentLayout.add_child(contentBox);
        dialog.open();

        // Focus description field
        descEntry.grab_key_focus();
    }

    // ---- Settings button callback ----
    on_preview_sound() {
        this._playSound();
    }

    // ---- Conflict detection ----
    _findConflicts(targetMs, excludeTask) {
        let conflicts = [];
        let allItems = this.tasks.concat(this.calendarEvents);
        for (let item of allItems) {
            if (item.completed || item.dismissed) continue;
            if (excludeTask && item.id === excludeTask.id) continue;
            if (!item.targetTime) continue;
            let start = new Date(item.targetTime).getTime();
            let end = item.endTime ? new Date(item.endTime).getTime() : start;
            // Conflict: target falls within the item's time range (or matches a point-in-time task)
            if (targetMs >= start && targetMs <= end) {
                conflicts.push(item);
            }
        }
        return conflicts;
    }

    // ---- Sound playback ----
    // Use Gio.Subprocess for reliable process spawning.
    // Validates file existence before attempting playback.
    _playSound() {
        if (!this.soundFile) return;

        // filechooser returns a URI (file:///path); convert to plain path
        let soundPath = this.soundFile;
        if (soundPath.startsWith("file://")) {
            soundPath = Gio.File.new_for_uri(soundPath).get_path();
        }

        let file = Gio.File.new_for_path(soundPath);
        if (!file.query_exists(null)) {
            global.logError(UUID + ": Sound file not found: " + soundPath);
            return;
        }

        let candidates = [
            ['paplay',            soundPath],           // PulseAudio / PipeWire
            ['aplay',             soundPath],           // ALSA
            ['canberra-gtk-play', '-f', soundPath],    // libcanberra
            ['play',              soundPath]            // SoX
        ];

        for (let argv of candidates) {
            if (GLib.find_program_in_path(argv[0])) {
                try {
                    let proc = new Gio.Subprocess({
                        argv: argv,
                        flags: Gio.SubprocessFlags.NONE
                    });
                    proc.init(null);
                    return;
                } catch (e) {
                    global.logError(UUID + ": _playSound failed with " + argv[0] + ": " + e.message);
                    // fall through to next candidate
                }
            }
        }

        // No working player found - tell the user
        let dialog = new imports.ui.modalDialog.ModalDialog();
        let box = new St.BoxLayout({
            vertical: true,
            style: "spacing: 8px; padding: 12px; min-width: 300px;"
        });
        let titleLbl = new St.Label({
            text: "Audio Player Not Found",
            style: "font-size: 14px; font-weight: bold; color: #eee;"
        });
        box.add_child(titleLbl);
        let msg = new St.Label({
            text: "No supported audio player is installed.\n\n" +
                  "Install one of the following:\n\n" +
                  "  sudo apt install pulseaudio-utils\n" +
                  "    (provides paplay)\n\n" +
                  "  sudo apt install alsa-utils\n" +
                  "    (provides aplay)\n\n" +
                  "  sudo apt install libcanberra-gtk3-module\n" +
                  "    (provides canberra-gtk-play)",
            style: "font-size: 12px; color: #ccc;"
        });
        box.add_child(msg);
        let btnRow = new St.BoxLayout({ style: "margin-top: 10px;" });
        btnRow.add_child(new St.Widget({ x_expand: true }));
        let closeBtn = this._makeButton("OK", "reminder-btn", () => {
            dialog.close();
            dialog.destroy();
        });
        btnRow.add_child(closeBtn);
        box.add_child(btnRow);
        dialog.contentLayout.add_child(box);
        dialog.open();
    }

    // ---- Nextcloud integration ----
    _tryLoadNcCredentials() {
        if (!this.caldavUrl) return;
        let creds = Nextcloud.loadCredentials(this.caldavUrl);
        if (creds) {
            this._ncLoginName = creds.loginName;
            this._ncAppPassword = creds.appPassword;
            this._ncConnected = true;
            this._authFailed = false;
            this._startCalendarSync();
        }
    }

    _getHostname() {
        if (!this.caldavUrl) return "";
        try {
            // Extract hostname from URL
            let match = this.caldavUrl.match(/^https?:\/\/([^/:]+)/);
            return match ? match[1] : this.caldavUrl;
        } catch (e) {
            return this.caldavUrl;
        }
    }

    _updateTooltip() {
        let host = this._getHostname();
        let tip;
        if (!host) {
            tip = "Task Reminder";
        } else if (this._ncConnected) {
            tip = "Connected to " + host;
        } else {
            tip = "Logged out of " + host;
        }
        if (this._lastSyncTime) {
            tip += "\nLast sync: " + _formatTimeAmPm(this._lastSyncTime);
        }
        this.set_applet_tooltip(tip);
    }

    // ---- Calendar sync ----
    _startCalendarSync() {
        if (this._syncId) return;
        // Sync immediately, then every 10 minutes
        this._doCalendarSync();
        this._syncId = Mainloop.timeout_add_seconds(600, Lang.bind(this, function () {
            this._doCalendarSync();
            return true;
        }));
    }

    _stopCalendarSync() {
        if (this._syncId) {
            Mainloop.source_remove(this._syncId);
            this._syncId = null;
        }
    }

    _doCalendarSync() {
        if (!this._ncConnected || !this.caldavUrl) return;
        if (this._authFailed) return;
        if (this._syncInProgress) return;
        if (!this.caldavCalendars || !Array.isArray(this.caldavCalendars)) return;

        let enabledCals = this.caldavCalendars.filter(c => c.enabled);
        if (enabledCals.length === 0) return;

        this._syncInProgress = true;

        let now = new Date();
        let rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        let rangeEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 0, 0, 0);

        let config = JSON.stringify({
            serverUrl: this.caldavUrl,
            loginName: this._ncLoginName,
            appPassword: this._ncAppPassword,
            rangeStart: rangeStart.toISOString(),
            rangeEnd: rangeEnd.toISOString(),
            calendars: enabledCals.map(c => ({
                displayName: c.displayName,
                href: c.href,
                filter: c.filter || ""
            }))
        });

        try {
            let workerPath = AppletDir + "/sync-worker.js";
            let proc = Gio.Subprocess.new(
                ["cjs", workerPath],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(config, null, Lang.bind(this, function (proc, asyncResult) {
                this._syncInProgress = false;
                try {
                    let [ok, stdout, stderr] = proc.communicate_utf8_finish(asyncResult);
                    if (!ok || !stdout) {
                        global.logError(UUID + ": Sync worker returned no output. stderr: " + (stderr || ""));
                        return;
                    }
                    let results = JSON.parse(stdout);
                    this._processSyncResults(results);
                } catch (e) {
                    global.logError(UUID + ": Sync worker error: " + e.message);
                }
            }));
        } catch (e) {
            this._syncInProgress = false;
            global.logError(UUID + ": Failed to spawn sync worker: " + e.message);
        }
    }

    _processSyncResults(results) {
        if (results.authFailed) {
            this._authFailed = true;
            this._ncConnected = false;
            this._stopCalendarSync();
            Nextcloud.clearCredentials(this.caldavUrl);
            Main.notify("Task Reminder", "Nextcloud session expired. Reconnect from the context menu.");
            return;
        }

        if (results.errors.length > 0) {
            this._syncFailCount++;
            if (this._syncFailCount === 1) {
                global.logError(UUID + ": Sync failed: " + results.errors[0]);
            }
        }

        // Build new calendar events from thread results
        let newEvents = [];
        let now = new Date();
        let todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
        for (let ev of results.events) {
            let targetTime = ev.dtstart;
            let endTime = ev.dtend;
            let evStart = new Date(ev.dtstart);
            let day = evStart.getTime() < todayEnd.getTime() ? "today" : "tomorrow";
            if (ev.allDay && day === "today") {
                let h = this.allDayReminderHour || 8;
                let m = this.allDayReminderMinute || 0;
                let reminderDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
                targetTime = reminderDate.toISOString();
                endTime = null;
            }
            newEvents.push({
                id: "cal-" + ev.uid,
                source: "calendar",
                day: day,
                description: ev.summary,
                targetTime: targetTime,
                endTime: endTime,
                calendarName: ev.calendarName,
                alarms: ev.alarms,
                allDay: ev.allDay,
                completed: false,
                dismissed: false,
                _notified: false,
                _valarmNotified: {},
                _valarmEnabled: {}
            });
        }

        global.log(UUID + ": Total calendar events after sync: " + newEvents.length);

        // Merge: preserve acknowledged/dismissed state from existing events
        let existingById = {};
        for (let ev of this.calendarEvents) {
            existingById[ev.id] = ev;
        }

        for (let ev of newEvents) {
            let existing = existingById[ev.id];
            if (existing) {
                ev.completed = existing.completed;
                ev.dismissed = existing.dismissed;
                ev._notified = existing._notified;
                ev._notified15 = existing._notified15;
                ev._notified5 = existing._notified5;
                ev._remind15 = existing._remind15;
                ev._remind5 = existing._remind5;
                ev._valarmNotified = existing._valarmNotified || {};
                ev._valarmEnabled = existing._valarmEnabled || {};
            }
        }

        // Auto-dismiss past + acknowledged events
        let nowMs = Date.now();
        for (let ev of newEvents) {
            if (ev.completed && ev.endTime && new Date(ev.endTime).getTime() <= nowMs) {
                ev.dismissed = true;
            }
        }

        this.calendarEvents = newEvents;
        if (this._syncFailCount > 0) {
            global.log(UUID + ": Sync recovered after " + this._syncFailCount + " failure(s)");
        }
        this._syncFailCount = 0;
        this._lastSyncTime = new Date();
        this._updateTooltip();
        if (this._manualSyncRequested) {
            this._manualSyncRequested = false;
            Main.notify("Task Reminder", "Calendar sync complete. " + this.calendarEvents.filter(e => !e.dismissed).length + " events today.");
        }
    }

    _ncConnect() {
        if (!this.caldavUrl) {
            Main.notify("Task Reminder", "Set the Nextcloud server URL in Configure first.");
            return;
        }

        // Show confirmation dialog with read-only URL, then initiate Login Flow v2
        let dialog = new imports.ui.modalDialog.ModalDialog();
        let box = new St.BoxLayout({
            vertical: true,
            style: "spacing: 10px; padding: 12px; min-width: 440px;"
        });

        let title = new St.Label({
            text: "Connect to Nextcloud",
            style: "font-size: 14px; font-weight: bold; color: #eee;"
        });
        box.add_child(title);

        let urlLabel = new St.Label({ text: "Server URL", style: "color: #ccc; font-size: 11px;" });
        box.add_child(urlLabel);
        let urlDisplay = new St.Label({
            text: this.caldavUrl,
            style: "color: #eee; font-size: 12px; padding: 4px 6px; background-color: #333; border-radius: 3px; min-width: 380px;"
        });
        box.add_child(urlDisplay);

        let hint = new St.Label({
            text: "(change in Configure settings)",
            style: "color: #888; font-size: 10px;"
        });
        box.add_child(hint);

        let btnRow = new St.BoxLayout({ style: "spacing: 6px; margin-top: 6px;" });
        btnRow.add_child(new St.Widget({ x_expand: true }));

        let cancelBtn = this._makeButton("Cancel", "reminder-btn", () => {
            dialog.close();
            dialog.destroy();
        });
        btnRow.add_child(cancelBtn);

        let connectBtn = this._makeButton("Connect", "reminder-btn reminder-btn-primary", () => {
            let serverUrl = this.caldavUrl.trim().replace(/\/+$/, "");
            connectBtn.reactive = false;

            let flowData = Nextcloud.loginFlowInit(serverUrl);
            if (!flowData) {
                Main.notify("Task Reminder", "Failed to contact server. Check URL in Configure.");
                dialog.close();
                dialog.destroy();
                return;
            }

            // Close dialog before opening browser so it's not blocking
            dialog.close();
            dialog.destroy();

            // Open browser
            this._launchBrowser(flowData.loginUrl);
            Main.notify("Task Reminder", "Approve access in your browser. Waiting...");

            // Poll in background
            let attempts = 0;
            this._ncPollId = Mainloop.timeout_add_seconds(2, Lang.bind(this, function () {
                attempts++;
                if (attempts > 150) {
                    Main.notify("Task Reminder", "Nextcloud login timed out.");
                    this._ncPollId = null;
                    return false;
                }
                let result = Nextcloud.loginFlowPoll(flowData.pollUrl, flowData.pollToken);
                if (result === null) return true; // still waiting
                if (result === false) {
                    Main.notify("Task Reminder", "Nextcloud login flow expired.");
                    this._ncPollId = null;
                    return false;
                }
                // Success
                this._ncLoginName = result.loginName;
                this._ncAppPassword = result.appPassword;
                this._ncConnected = true;
                this._authFailed = false;
                Nextcloud.storeCredentials(serverUrl, result.loginName, result.appPassword);
                this._ncPollId = null;
                if (this._ncMenuItem) this._ncMenuItem.label.set_text("Logout from Nextcloud");
                this._updateTooltip();
                this._startCalendarSync();
                Main.notify("Task Reminder", "Connected as " + result.loginName);
                this._ncDiscoverCalendars();
                return false;
            }));
        });
        btnRow.add_child(connectBtn);
        box.add_child(btnRow);

        dialog.contentLayout.add_child(box);
        dialog.open();
    }

    _launchBrowser(url) {
        if (this.browserCommand) {
            let cmd = this.browserCommand.trim();
            if (cmd.indexOf("%u") !== -1) {
                cmd = cmd.replace("%u", url);
            } else {
                cmd = cmd + " " + url;
            }
            try {
                GLib.spawn_command_line_async(cmd);
                return;
            } catch (e) {
                global.logError(UUID + ": Browser command failed: " + e.message);
            }
        }
        // Fallback to system default
        try {
            Gio.AppInfo.launch_default_for_uri(url, null);
        } catch (e) {
            global.logError(UUID + ": Could not open browser: " + e.message);
        }
    }

    _ncDisconnect() {
        // Revoke app password on server before clearing locally
        if (this.caldavUrl && this._ncLoginName && this._ncAppPassword) {
            Nextcloud.revokeAppPassword(this.caldavUrl, this._ncLoginName, this._ncAppPassword);
        }
        if (this.caldavUrl) Nextcloud.clearCredentials(this.caldavUrl);
        this._ncConnected = false;
        this._ncLoginName = null;
        this._ncAppPassword = null;
        this.caldavCalendars = "";
        this.calendarEvents = [];
        this._stopCalendarSync();
        if (this._ncMenuItem) this._ncMenuItem.label.set_text("Connect to Nextcloud");
        this._updateTooltip();
        Main.notify("Task Reminder", "Disconnected from Nextcloud.");
    }

    _ncDiscoverCalendars() {
        if (!this._ncConnected || !this.caldavUrl) {
            Main.notify("Task Reminder", "Connect to Nextcloud first.");
            return;
        }
        try {
            let calendars = Nextcloud.discoverCalendars(this.caldavUrl, this._ncLoginName, this._ncAppPassword);
            if (!calendars || calendars.length === 0) {
                Main.notify("Task Reminder", "No calendars found on " + this.caldavUrl);
                return;
            }
            // Preserve existing enabled state and filter for known calendars
            let existing = {};
            if (this.caldavCalendars && Array.isArray(this.caldavCalendars)) {
                for (let row of this.caldavCalendars) {
                    existing[row.href] = { enabled: row.enabled, filter: row.filter || "" };
                }
            }
            let rows = calendars.map(cal => ({
                enabled: (cal.href in existing) ? existing[cal.href].enabled : true,
                displayName: cal.displayName,
                filter: (cal.href in existing) ? existing[cal.href].filter : "",
                href: cal.href
            }));
            this.caldavCalendars = rows;
            let count = calendars.length;
            Main.notify("Task Reminder", "Found " + count + " calendar" + (count !== 1 ? "s" : "") + ". Check Configure to select which to sync.");
        } catch (e) {
            global.logError(UUID + ": discoverCalendars failed: " + e.message);
            Main.notify("Task Reminder", "Calendar discovery failed: " + e.message);
        }
    }

    // Settings button callback for Discover Calendars
    on_discover_calendars() {
        this._ncDiscoverCalendars();
    }

    // Settings button callback for Sync Now
    on_sync_now() {
        this._manualSyncRequested = true;
        this._doCalendarSync();
    }

    // ---- Context menu (right-click) ----
    _buildContextMenu() {
        this._applet_context_menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Nextcloud connection
        this._ncMenuItem = new PopupMenu.PopupMenuItem(
            this._ncConnected ? "Logout from Nextcloud" : "Connect to Nextcloud"
        );
        this._ncMenuItem.connect("activate", () => {
            if (this._ncConnected) this._ncDisconnect();
            else this._ncConnect();
        });
        this._applet_context_menu.addMenuItem(this._ncMenuItem);

        this._applet_context_menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let previewItem = new PopupMenu.PopupMenuItem("Preview Sound");
        previewItem.connect("activate", () => this._playSound());
        this._applet_context_menu.addMenuItem(previewItem);

        let aboutItem = new PopupMenu.PopupMenuItem("About");
        aboutItem.connect("activate", () => this._showAboutDialog());
        this._applet_context_menu.addMenuItem(aboutItem);
    }

    _showAboutDialog() {
        let text = "Task Reminder v1.0.0\n" +
                   "Timer and todo list applet for Cinnamon.\n" +
                   "Countdown and absolute time reminders\n" +
                   "for scheduling tasks throughout the day.\n\n" +
                   "Author: bitcrash";
        Main.notify("About Task Reminder", text);
    }

    // ---- Lifecycle ----
    on_applet_added_to_panel() {
        this._buildContextMenu();
    }

    on_applet_removed_from_panel() {
        this._stopTick();
        this._stopThrob();
        this._stopCalendarSync();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new ReminderApplet(orientation, panelHeight, instanceId);
}