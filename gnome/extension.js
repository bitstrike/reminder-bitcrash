import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Nextcloud from './nextcloud.js';

const UUID = 'reminder@bitcrash';
const MAX_TASKS = 100;

// ---- Utility functions ----

function _generateId() {
    return 't' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function _padTwo(n) {
    return n < 10 ? '0' + n : '' + n;
}

function _formatCountdown(totalSeconds) {
    if (totalSeconds <= 0) return '0:00';
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return h + ':' + _padTwo(m) + ':' + _padTwo(s);
    return m + ':' + _padTwo(s);
}

function _formatTimeAmPm(date) {
    let h = date.getHours();
    const m = date.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    return h + ':' + _padTwo(m) + ' ' + ampm;
}

function _isToday(dateStr) {
    const d = new Date(dateStr);
    const now = new Date();
    return d.getFullYear() === now.getFullYear() &&
           d.getMonth() === now.getMonth() &&
           d.getDate() === now.getDate();
}

function _isYesterday(dateStr) {
    const d = new Date(dateStr);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return d.getFullYear() === yesterday.getFullYear() &&
           d.getMonth() === yesterday.getMonth() &&
           d.getDate() === yesterday.getDate();
}

// ---- Data persistence ----

function _getDataDir() {
    const dir = GLib.build_filenamev([GLib.get_user_config_dir(), UUID]);
    GLib.mkdir_with_parents(dir, 0o755);
    return dir;
}

function _getDataPath() {
    return GLib.build_filenamev([_getDataDir(), 'tasks.json']);
}

function _loadTasks() {
    const path = _getDataPath();
    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return [];
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (ok) {
            const decoder = new TextDecoder();
            return JSON.parse(decoder.decode(contents));
        }
    } catch (e) {
        console.error(`${UUID}: Failed to load tasks: ${e.message}`);
    }
    return [];
}

function _saveTasks(tasks) {
    try {
        const path = _getDataPath();
        const json = JSON.stringify(tasks, null, 2);
        GLib.file_set_contents(path, json);
    } catch (e) {
        console.error(`${UUID}: Failed to save tasks: ${e.message}`);
    }
}

// ---- Extension ----

export default class ReminderExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._startTime = Date.now();

        // Load task data
        this.tasks = _loadTasks();
        this.calendarEvents = [];

        // Auto-dismiss expired items at startup if user opted out
        if (!this._settings.get_boolean('notify-past-due')) {
            const now = Date.now();
            for (const task of this.tasks) {
                if (task.completed || task.dismissed) continue;
                if (task.targetTime && new Date(task.targetTime).getTime() <= now)
                    task.dismissed = true;
            }
            _saveTasks(this.tasks);
        }

        // Throb state
        this._throbId = null;
        this._throbOn = false;
        this._throbIndex = 0;

        // Nextcloud state
        this._ncConnected = false;
        this._ncLoginName = null;
        this._ncAppPassword = null;
        this._ncPollId = null;
        this._syncId = null;

        // Panel button
        this._button = new PanelMenu.Button(0.0, this.metadata.name, false);

        const icon = new St.Icon({
            icon_name: 'alarm-symbolic',
            style_class: 'system-status-icon',
        });
        this._button.add_child(icon);

        this._label = new St.Label({
            text: 'No tasks pending',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-left: 4px; font-size: 11px;',
        });
        this._button.add_child(this._label);

        this._rebuildMenu();

        this._button.menu.connect('open-state-changed', (_menu, open) => {
            if (open) this._rebuildMenu();
        });

        // Tick timer (1 second)
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._onTick();
            return GLib.SOURCE_CONTINUE;
        });

        this._updatePanelLabel();
        Main.panel.addToStatusArea(this.uuid, this._button);

        // Load Nextcloud credentials if available
        this._tryLoadNcCredentials();
    }

    disable() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = null;
        }
        if (this._ncPollId) {
            GLib.source_remove(this._ncPollId);
            this._ncPollId = null;
        }
        this._stopCalendarSync();
        this._stopThrob();
        this._button?.destroy();
        this._button = null;
        this._label = null;
        this._settings = null;
        this.tasks = null;
        this.calendarEvents = null;
    }

    // ---- Task data operations ----

    _addTask(task) {
        if (this.tasks.filter(t => !t.dismissed).length >= MAX_TASKS) {
            Main.notify('Task Reminder', 'Maximum of ' + MAX_TASKS + ' tasks reached. Dismiss old tasks first.');
            return false;
        }
        this.tasks.push(task);
        _saveTasks(this.tasks);
        this._updatePanelLabel();
        return true;
    }

    _updateTask(_task) {
        _saveTasks(this.tasks);
        this._updatePanelLabel();
    }

    _dismissTask(task) {
        task.dismissed = true;
        _saveTasks(this.tasks);
        this._updatePanelLabel();
    }

    _toggleComplete(task) {
        task.completed = !task.completed;
        _saveTasks(this.tasks);
        this._updatePanelLabel();
    }

    _dismissAllOld() {
        const now = Date.now();
        for (const task of this.tasks) {
            if (task.completed && !task.dismissed)
                task.dismissed = true;
            if (!task.completed && !task.dismissed && task.targetTime &&
                new Date(task.targetTime).getTime() <= now)
                task.dismissed = true;
        }
        for (const event of this.calendarEvents) {
            if (event.completed && !event.dismissed)
                event.dismissed = true;
            if (!event.dismissed && event.targetTime &&
                new Date(event.targetTime).getTime() <= now)
                event.dismissed = true;
        }
        _saveTasks(this.tasks);
        this._updatePanelLabel();
    }

    _getNextActiveTask() {
        const now = Date.now();
        let best = null;
        let bestTime = Infinity;
        const allItems = this.tasks.concat(this.calendarEvents);
        for (const task of allItems) {
            if (task.completed || task.dismissed) continue;
            if (!task.targetTime) continue;
            const t = new Date(task.targetTime).getTime();
            if (t - now > -3600000 && t < bestTime) {
                bestTime = t;
                best = task;
            }
        }
        return best;
    }

    _isExpiredOrStale(task) {
        if (task.completed || task.dismissed) return false;
        if (!task.targetTime) return false;
        return new Date(task.targetTime).getTime() <= Date.now();
    }

    _hasUnhandledExpired() {
        const now = Date.now();
        for (const task of this.tasks) {
            if (task.completed || task.dismissed) continue;
            if (!task.targetTime) continue;
            if (new Date(task.targetTime).getTime() <= now) return true;
        }
        for (const event of this.calendarEvents) {
            if (event.completed || event.dismissed) continue;
            if (event.allDay) continue;
            if (!event.targetTime) continue;
            if (new Date(event.targetTime).getTime() <= now) return true;
        }
        return false;
    }

    _getExpiredTasks() {
        const now = Date.now();
        const expired = this.tasks.filter(t =>
            !t.completed && !t.dismissed && t.targetTime &&
            new Date(t.targetTime).getTime() <= now
        );
        const expiredCal = this.calendarEvents.filter(e =>
            !e.completed && !e.dismissed && !e.allDay && e.targetTime &&
            new Date(e.targetTime).getTime() <= now
        );
        return expired.concat(expiredCal);
    }

    // ---- Tick loop (Phase 3) ----

    _onTick() {
        try {
            this._doTick();
        } catch (e) {
            console.error(`${UUID}: tick error: ${e.message}`);
        }
        this._updatePanelLabel();

        // Throb management (pause while menu open)
        if (!this._button?.menu?.isOpen) {
            if (this._hasUnhandledExpired()) this._startThrob();
            else this._stopThrob();
        }

        // Refresh popup if open
        if (this._button?.menu?.isOpen) this._rebuildMenu();
    }

    _doTick() {
        const now = Date.now();
        let fired = false;
        const notifyPastDue = this._settings.get_boolean('notify-past-due');
        const enableCountdown = this._settings.get_boolean('enable-countdown-reminders');

        // Process manual tasks
        for (const task of this.tasks) {
            if (task.completed || task.dismissed) continue;
            if (!task.targetTime) continue;
            const target = new Date(task.targetTime).getTime();

            // If event already started, skip pre-event reminders (mark silently)
            // and let _fireNotification be the sole notification
            if (target <= now) {
                task._notified15 = true;
                task._notified5 = true;
            } else if (enableCountdown) {
                const pending = [];
                if (task._remind15 && !task._notified15) {
                    const t15 = target - 15 * 60 * 1000;
                    if (t15 <= now) {
                        pending.push({
                            triggerTime: t15,
                            mark: () => { task._notified15 = true; },
                            notify: () => {
                                const remaining = Math.max(0, Math.floor((target - now) / 60000));
                                Main.notify('Task Reminder', task.description + ' in ' + remaining + ' min');
                            },
                        });
                    }
                }
                if (task._remind5 && !task._notified5) {
                    const t5 = target - 5 * 60 * 1000;
                    if (t5 <= now) {
                        pending.push({
                            triggerTime: t5,
                            mark: () => { task._notified5 = true; },
                            notify: () => {
                                const remaining = Math.max(0, Math.floor((target - now) / 60000));
                                Main.notify('Task Reminder', task.description + ' in ' + remaining + ' min');
                            },
                        });
                    }
                }
                if (pending.length > 0) {
                    pending.sort((a, b) => b.triggerTime - a.triggerTime);
                    for (let i = 0; i < pending.length; i++) {
                        pending[i].mark();
                        if (i === 0) {
                            if (notifyPastDue || pending[i].triggerTime >= this._startTime) {
                                fired = true;
                                pending[i].notify();
                                this._maybePlaySound();
                            }
                        }
                    }
                }
            }

            // Main fire
            if (target <= now && !task._notified) {
                task._notified = true;
                if (!notifyPastDue && target < this._startTime) continue;
                fired = true;
                this._fireNotification(task);
            }
        }

        // Process calendar events
        for (const event of this.calendarEvents) {
            if (event.completed || event.dismissed) continue;
            if (event.allDay) continue; // all-day events don't fire time-based reminders
            if (!event.targetTime) continue;
            const target = new Date(event.targetTime).getTime();

            // If event already started, skip pre-event reminders (mark silently)
            if (target <= now) {
                event._notified15 = true;
                event._notified5 = true;
                if (event.alarms) {
                    if (!event._valarmNotified) event._valarmNotified = {};
                    for (const mins of event.alarms)
                        event._valarmNotified[mins] = true;
                }
            } else if (enableCountdown) {
                const pending = [];
                if (event._remind15 && !event._notified15) {
                    const t15 = target - 15 * 60 * 1000;
                    if (t15 <= now) {
                        pending.push({
                            triggerTime: t15,
                            mark: () => { event._notified15 = true; },
                            notify: () => {
                                const remaining = Math.max(0, Math.floor((target - now) / 60000));
                                Main.notify('Task Reminder', event.description + ' in ' + remaining + ' min');
                            },
                        });
                    }
                }
                if (event._remind5 && !event._notified5) {
                    const t5 = target - 5 * 60 * 1000;
                    if (t5 <= now) {
                        pending.push({
                            triggerTime: t5,
                            mark: () => { event._notified5 = true; },
                            notify: () => {
                                const remaining = Math.max(0, Math.floor((target - now) / 60000));
                                Main.notify('Task Reminder', event.description + ' in ' + remaining + ' min');
                            },
                        });
                    }
                }
                // VALARM reminders
                if (this._settings.get_boolean('respect-valarm') && event.alarms && event.alarms.length > 0) {
                    if (!event._valarmNotified) event._valarmNotified = {};
                    if (!event._valarmEnabled) event._valarmEnabled = {};
                    for (const mins of event.alarms) {
                        if (event._valarmEnabled[mins] === false) continue;
                        if (event._valarmEnabled[mins] === undefined) event._valarmEnabled[mins] = true;
                        if (event._valarmNotified[mins]) continue;
                        const triggerTime = target - mins * 60 * 1000;
                        if (triggerTime <= now) {
                            const m = mins;
                            pending.push({
                                triggerTime,
                                mark: () => { event._valarmNotified[m] = true; },
                                notify: () => {
                                    const remaining = Math.max(0, Math.floor((target - now) / 60000));
                                    let label;
                                    if (remaining >= 60)
                                        label = Math.floor(remaining / 60) + 'h' + (remaining % 60 > 0 ? remaining % 60 + 'm' : '');
                                    else
                                        label = remaining + ' min';
                                    Main.notify('Task Reminder', event.description + ' in ' + label);
                                },
                            });
                        }
                    }
                }
                if (pending.length > 0) {
                    pending.sort((a, b) => b.triggerTime - a.triggerTime);
                    for (let i = 0; i < pending.length; i++) {
                        pending[i].mark();
                        if (i === 0) {
                            if (notifyPastDue || pending[i].triggerTime >= this._startTime) {
                                fired = true;
                                pending[i].notify();
                                this._maybePlaySound();
                            }
                        }
                    }
                }
            }

            // Main fire
            if (target <= now && !event._notified) {
                event._notified = true;
                if (!notifyPastDue && target < this._startTime) continue;
                fired = true;
                this._fireNotification(event);
            }
        }

        if (fired) _saveTasks(this.tasks);

        // Nag: re-notify every 5 min for expired unchecked items (one at a time)
        let nagCandidate = null;
        let nagCandidateTime = Infinity;
        const allItems = this.tasks.concat(this.calendarEvents);
        for (const item of allItems) {
            if (item.completed || item.dismissed) continue;
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
            Main.notify('Task Reminder', nagCandidate.description + ' - still pending');
            this._maybePlaySound();
        }
    }

    // ---- Notifications & Sound (Phase 4) ----

    _fireNotification(task) {
        let msg = task.description;
        if (task.timerMode === 'absolute')
            msg += ' - ' + _formatTimeAmPm(new Date(task.targetTime));
        else
            msg += ' - countdown finished';
        Main.notify('Task Reminder', msg);
        this._maybePlaySound();
    }

    _maybePlaySound() {
        if (!this._settings.get_boolean('enable-sound')) return;
        const soundFile = this._settings.get_string('sound-file');
        if (!soundFile) return;

        let soundPath = soundFile;
        if (soundPath.startsWith('file://')) {
            soundPath = Gio.File.new_for_uri(soundPath).get_path();
        }

        const file = Gio.File.new_for_path(soundPath);
        if (!file.query_exists(null)) {
            console.error(`${UUID}: Sound file not found: ${soundPath}`);
            return;
        }

        const candidates = [
            ['paplay', soundPath],
            ['aplay', soundPath],
            ['canberra-gtk-play', '-f', soundPath],
            ['play', soundPath],
        ];

        for (const argv of candidates) {
            if (GLib.find_program_in_path(argv[0])) {
                try {
                    const proc = new Gio.Subprocess({
                        argv,
                        flags: Gio.SubprocessFlags.NONE,
                    });
                    proc.init(null);
                    return;
                } catch (e) {
                    console.error(`${UUID}: _playSound failed with ${argv[0]}: ${e.message}`);
                }
            }
        }
    }

    // ---- Throb (Phase 7 - included early since tick loop references it) ----

    _startThrob() {
        if (this._throbId) return;
        this._throbOn = false;
        this._throbIndex = 0;
        this._throbId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._throbOn = !this._throbOn;
            if (this._button)
                this._button.set_style(this._throbOn ? 'background-color: rgba(255, 80, 80, 0.6);' : null);
            if (this._throbOn) {
                const expired = this._getExpiredTasks();
                if (expired.length > 0) {
                    const task = expired[this._throbIndex % expired.length];
                    let desc = task.description;
                    if (desc.length > 15) desc = desc.substring(0, 14) + '\u2026';
                    if (this._label) this._label.set_text(desc + ' - expired');
                    this._throbIndex++;
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopThrob() {
        if (!this._throbId) return;
        GLib.source_remove(this._throbId);
        this._throbId = null;
        this._throbOn = false;
        this._throbIndex = 0;
        if (this._button) this._button.set_style(null);
        this._updatePanelLabel();
    }

    // ---- Nextcloud ----

    _tryLoadNcCredentials() {
        const url = this._settings.get_string('caldav-url');
        if (!url) return;
        const creds = Nextcloud.loadCredentials(url);
        if (creds) {
            this._ncLoginName = creds.loginName;
            this._ncAppPassword = creds.appPassword;
            this._ncConnected = true;
            this._startCalendarSync();
        }
    }

    _ncConnect() {
        const url = this._settings.get_string('caldav-url');
        if (!url) {
            Main.notify('Task Reminder', 'Set the Nextcloud server URL in Settings first.');
            return;
        }

        const serverUrl = url.trim().replace(/\/+$/, '');
        const flowData = Nextcloud.loginFlowInit(serverUrl);
        if (!flowData) {
            Main.notify('Task Reminder', 'Failed to contact server. Check URL in Settings.');
            return;
        }

        // Open browser
        this._launchBrowser(flowData.loginUrl);
        Main.notify('Task Reminder', 'Approve access in your browser. Waiting...');

        // Poll in background
        let attempts = 0;
        this._ncPollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            attempts++;
            if (attempts > 150) {
                Main.notify('Task Reminder', 'Nextcloud login timed out.');
                this._ncPollId = null;
                return GLib.SOURCE_REMOVE;
            }
            const result = Nextcloud.loginFlowPoll(flowData.pollUrl, flowData.pollToken);
            if (result === null) return GLib.SOURCE_CONTINUE; // still waiting
            if (result === false) {
                Main.notify('Task Reminder', 'Nextcloud login flow expired.');
                this._ncPollId = null;
                return GLib.SOURCE_REMOVE;
            }
            // Success
            this._ncLoginName = result.loginName;
            this._ncAppPassword = result.appPassword;
            this._ncConnected = true;
            Nextcloud.storeCredentials(serverUrl, result.loginName, result.appPassword);
            this._ncPollId = null;
            this._startCalendarSync();
            Main.notify('Task Reminder', 'Connected as ' + result.loginName);
            this._ncDiscoverCalendars();
            return GLib.SOURCE_REMOVE;
        });
    }

    _ncDisconnect() {
        const url = this._settings.get_string('caldav-url');
        if (url && this._ncLoginName && this._ncAppPassword)
            Nextcloud.revokeAppPassword(url, this._ncLoginName, this._ncAppPassword);
        if (url) Nextcloud.clearCredentials(url);
        this._ncConnected = false;
        this._ncLoginName = null;
        this._ncAppPassword = null;
        this.calendarEvents = [];
        this._stopCalendarSync();
        this._updatePanelLabel();
        Main.notify('Task Reminder', 'Disconnected from Nextcloud.');
    }

    _ncDiscoverCalendars() {
        const url = this._settings.get_string('caldav-url');
        if (!this._ncConnected || !url) {
            Main.notify('Task Reminder', 'Connect to Nextcloud first.');
            return;
        }
        try {
            const calendars = Nextcloud.discoverCalendars(url, this._ncLoginName, this._ncAppPassword);
            if (!calendars || calendars.length === 0) {
                Main.notify('Task Reminder', 'No calendars found on ' + url);
                return;
            }
            // Preserve existing enabled state
            let existing = {};
            try {
                const stored = JSON.parse(this._settings.get_string('caldav-calendars'));
                if (Array.isArray(stored)) {
                    for (const row of stored)
                        existing[row.href] = {enabled: row.enabled, filter: row.filter || ''};
                }
            } catch (_e) { /* ignore parse errors */ }

            const rows = calendars.map(cal => ({
                enabled: (cal.href in existing) ? existing[cal.href].enabled : true,
                displayName: cal.displayName,
                filter: (cal.href in existing) ? existing[cal.href].filter : '',
                href: cal.href,
            }));
            this._settings.set_string('caldav-calendars', JSON.stringify(rows));
            Main.notify('Task Reminder',
                'Found ' + calendars.length + ' calendar' + (calendars.length !== 1 ? 's' : '') + '.');
        } catch (e) {
            console.error(`${UUID}: discoverCalendars failed: ${e.message}`);
            Main.notify('Task Reminder', 'Calendar discovery failed: ' + e.message);
        }
    }

    _launchBrowser(url) {
        const browserCmd = this._settings.get_string('browser-command');
        if (browserCmd) {
            let cmd = browserCmd.trim();
            if (cmd.indexOf('%u') !== -1)
                cmd = cmd.replace('%u', url);
            else
                cmd = cmd + ' ' + url;
            try {
                GLib.spawn_command_line_async(cmd);
                return;
            } catch (e) {
                console.error(`${UUID}: Browser command failed: ${e.message}`);
            }
        }
        try {
            Gio.AppInfo.launch_default_for_uri(url, null);
        } catch (e) {
            console.error(`${UUID}: Could not open browser: ${e.message}`);
        }
    }

    // ---- Calendar sync ----

    _startCalendarSync() {
        if (this._syncId) return;
        this._doCalendarSync();
        this._syncId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 600, () => {
            this._doCalendarSync();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopCalendarSync() {
        if (this._syncId) {
            GLib.source_remove(this._syncId);
            this._syncId = null;
        }
    }

    _doCalendarSync() {
        const url = this._settings.get_string('caldav-url');
        if (!this._ncConnected || !url) return;

        let enabledCals = [];
        try {
            const stored = JSON.parse(this._settings.get_string('caldav-calendars'));
            if (Array.isArray(stored))
                enabledCals = stored.filter(c => c.enabled);
        } catch (_e) { return; }

        if (enabledCals.length === 0) return;

        const now = new Date();
        const rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        const rangeEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);

        const newEvents = [];
        for (const cal of enabledCals) {
            try {
                let events = Nextcloud.fetchEvents(
                    url, this._ncLoginName, this._ncAppPassword,
                    cal.href, rangeStart, rangeEnd
                );
                if (!events) continue;

                // Keyword filter
                if (cal.filter && cal.filter.trim()) {
                    const keywords = cal.filter.split(',').map(k => k.trim().toLowerCase()).filter(k => k);
                    if (keywords.length > 0) {
                        events = events.filter(ev => {
                            const text = ((ev.summary || '') + ' ' + (ev.description || '')).toLowerCase();
                            return keywords.some(kw => text.includes(kw));
                        });
                    }
                }

                for (const ev of events) {
                    let targetTime = ev.dtstart;
                    let endTime = ev.dtend;
                    // All-day events: use configured reminder time instead of midnight
                    if (ev.allDay) {
                        const today = new Date();
                        const h = this._settings.get_int('allday-reminder-hour');
                        const m = this._settings.get_int('allday-reminder-minute');
                        const reminderDate = new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m, 0);
                        targetTime = reminderDate.toISOString();
                        endTime = null;
                    }
                    newEvents.push({
                        id: 'cal-' + ev.uid,
                        source: 'calendar',
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
                        _valarmEnabled: {},
                    });
                }
            } catch (e) {
                if (e.authFailed) {
                    this._ncConnected = false;
                    this._stopCalendarSync();
                    Nextcloud.clearCredentials(url);
                    Main.notify('Task Reminder', 'Nextcloud session expired. Reconnect from the menu.');
                    return;
                }
                console.error(`${UUID}: Sync failed for ${cal.displayName}: ${e.message}`);
            }
        }

        // Merge: preserve state from existing events
        const existingById = {};
        for (const ev of this.calendarEvents)
            existingById[ev.id] = ev;

        for (const ev of newEvents) {
            const existing = existingById[ev.id];
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

        // Auto-dismiss past acknowledged events
        const nowMs = Date.now();
        for (const ev of newEvents) {
            if (ev.completed && ev.endTime && new Date(ev.endTime).getTime() <= nowMs)
                ev.dismissed = true;
        }

        this.calendarEvents = newEvents;
    }

    // ---- Panel label ----

    _updatePanelLabel() {
        if (!this._label) return;
        const next = this._getNextActiveTask();
        if (!next) {
            this._label.set_text('No tasks pending');
            return;
        }
        const now = Date.now();
        const target = new Date(next.targetTime).getTime();
        const remaining = Math.max(0, Math.floor((target - now) / 1000));
        let desc = next.description;
        if (desc.length > 15) desc = desc.substring(0, 14) + '\u2026';
        if (remaining <= 0)
            this._label.set_text(desc + ' - expired');
        else
            this._label.set_text(desc + ' - ' + _formatCountdown(remaining));
    }

    // ---- Conflict detection ----

    _findConflicts(targetMs, excludeTask) {
        const conflicts = [];
        const allItems = this.tasks.concat(this.calendarEvents);
        for (const item of allItems) {
            if (item.completed || item.dismissed) continue;
            if (excludeTask && item.id === excludeTask.id) continue;
            if (!item.targetTime) continue;
            const start = new Date(item.targetTime).getTime();
            const end = item.endTime ? new Date(item.endTime).getTime() : start;
            if (targetMs >= start && targetMs <= end)
                conflicts.push(item);
        }
        return conflicts;
    }

    // ---- Menu building (Phase 5) ----

    _rebuildMenu() {
        this._button.menu.removeAll();

        // Header
        const headerItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        const headerBox = new St.BoxLayout({style_class: 'reminder-header'});

        const titleLabel = new St.Label({
            text: 'Tasks',
            style_class: 'reminder-header-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(titleLabel);
        headerBox.add_child(new St.Widget({x_expand: true}));

        const hasOld = this.tasks.some(t => this._isExpiredOrStale(t));
        if (hasOld) {
            const dismissAllBtn = new St.Button({
                label: 'Dismiss All Old',
                style_class: 'reminder-btn reminder-btn-danger',
            });
            dismissAllBtn.connect('clicked', () => {
                this._dismissAllOld();
                this._rebuildMenu();
            });
            headerBox.add_child(dismissAllBtn);
        }

        const newBtn = new St.Button({
            label: '+ New Task',
            style_class: 'reminder-btn reminder-btn-primary',
        });
        newBtn.connect('clicked', () => {
            this._button.menu.close();
            this._showTaskDialog(null);
        });
        headerBox.add_child(newBtn);

        headerItem.add_child(headerBox);
        this._button.menu.addMenuItem(headerItem);
        this._button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Merge and sort
        const visibleTasks = this.tasks.filter(t => !t.dismissed);
        const visibleCal = this.calendarEvents.filter(e => !e.dismissed);
        const allItems = visibleTasks.concat(visibleCal);
        allItems.sort((a, b) => {
            const ta = a.targetTime ? new Date(a.targetTime).getTime() : Infinity;
            const tb = b.targetTime ? new Date(b.targetTime).getTime() : Infinity;
            return ta - tb;
        });

        if (allItems.length === 0) {
            const emptyItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
            const emptyLabel = new St.Label({
                text: "No tasks. Click '+ New Task' to add one.",
                style_class: 'reminder-no-tasks',
            });
            emptyItem.add_child(emptyLabel);
            this._button.menu.addMenuItem(emptyItem);
        } else {
            for (const item of allItems) {
                this._addTaskRow(item);
            }
        }

        // Footer: actions
        this._button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Nextcloud connect/disconnect
        const ncLabel = this._ncConnected ? 'Disconnect from Nextcloud' : 'Connect to Nextcloud';
        const ncItem = new PopupMenu.PopupMenuItem(ncLabel);
        ncItem.connect('activate', () => {
            if (this._ncConnected) this._ncDisconnect();
            else this._ncConnect();
        });
        this._button.menu.addMenuItem(ncItem);

        // Sync Now (only if connected)
        if (this._ncConnected) {
            const syncItem = new PopupMenu.PopupMenuItem('Sync Now');
            syncItem.connect('activate', () => {
                this._doCalendarSync();
                Main.notify('Task Reminder',
                    'Sync complete. ' + this.calendarEvents.filter(e => !e.dismissed).length + ' events today.');
            });
            this._button.menu.addMenuItem(syncItem);
        }

        // Settings
        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => {
            this.openPreferences();
        });
        this._button.menu.addMenuItem(settingsItem);

        // About
        const aboutItem = new PopupMenu.PopupMenuItem('About');
        aboutItem.connect('activate', () => {
            Main.notify('Task Reminder',
                'Task Reminder v1.0.0\n' +
                'Timer and todo list for GNOME Shell.\n' +
                'Author: bitcrash');
        });
        this._button.menu.addMenuItem(aboutItem);
    }

    _addTaskRow(task) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
        const now = Date.now();
        const target = task.targetTime ? new Date(task.targetTime).getTime() : null;
        const expired = target && target <= now && !task.completed;
        const isStale = !task.dismissed && !task.completed && task.targetTime &&
                        !_isToday(task.targetTime) && target < now;
        const isCalendar = task.source === 'calendar';
        const enableCountdown = this._settings.get_boolean('enable-countdown-reminders');
        const upcoming = target && target > now;

        const container = new St.BoxLayout({
            style_class: 'reminder-task-row',
            vertical: true,
        });

        // Line 1: checkbox + description + toggles + buttons
        const line1 = new St.BoxLayout({style_class: 'reminder-row-line1'});

        // Checkbox
        const checkClass = task.completed ? 'reminder-checkbox-checked' : 'reminder-checkbox';
        const checkBtn = new St.Button({style_class: checkClass});
        if (task.completed) checkBtn.set_label('\u2713');
        checkBtn.connect('clicked', () => {
            this._toggleComplete(task);
            this._rebuildMenu();
        });
        line1.add_child(checkBtn);

        // Description
        let descClass = 'reminder-task-desc';
        if (task.completed) descClass = 'reminder-task-desc-done';
        else if (isStale) descClass = 'reminder-task-desc-stale';
        const descLabel = new St.Label({
            text: task.description,
            style_class: descClass,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        line1.add_child(descLabel);

        // T-15 / T-5 toggles for upcoming non-completed tasks
        if (upcoming && !task.completed && enableCountdown) {
            if (task._remind15 === undefined) task._remind15 = true;
            if (task._remind5 === undefined) task._remind5 = true;

            const t15Class = task._remind15 ? 'reminder-toggle-t-active' : 'reminder-toggle-t-inactive';
            const t15Btn = new St.Button({label: 'T-15', style_class: t15Class});
            t15Btn.connect('clicked', () => {
                task._remind15 = !task._remind15;
                _saveTasks(this.tasks);
                this._rebuildMenu();
            });
            line1.add_child(t15Btn);

            const t5Class = task._remind5 ? 'reminder-toggle-t-active' : 'reminder-toggle-t-inactive';
            const t5Btn = new St.Button({label: 'T-5', style_class: t5Class});
            t5Btn.connect('clicked', () => {
                task._remind5 = !task._remind5;
                _saveTasks(this.tasks);
                this._rebuildMenu();
            });
            line1.add_child(t5Btn);
        }

        // VALARM toggles for calendar events
        if (upcoming && !task.completed && isCalendar &&
            this._settings.get_boolean('respect-valarm') &&
            task.alarms && task.alarms.length > 0) {
            if (!task._valarmEnabled) task._valarmEnabled = {};
            for (const mins of task.alarms) {
                if (mins === 15 || mins === 5) continue;
                if (task._valarmEnabled[mins] === undefined) task._valarmEnabled[mins] = true;
                const label = mins >= 60 ? 'V-' + Math.floor(mins / 60) + 'h' : 'V-' + mins;
                const vClass = task._valarmEnabled[mins] ? 'reminder-toggle-v-active' : 'reminder-toggle-v-inactive';
                const vBtn = new St.Button({label, style_class: vClass});
                const m = mins;
                vBtn.connect('clicked', () => {
                    task._valarmEnabled[m] = !task._valarmEnabled[m];
                    this._rebuildMenu();
                });
                line1.add_child(vBtn);
            }
        }

        // Action buttons
        if (task.completed) {
            line1.add_child(this._makeBtn('Dismiss', 'reminder-task-btn', () => {
                this._dismissTask(task);
                this._rebuildMenu();
            }));
        } else if (expired || isStale) {
            if (!isCalendar) {
                line1.add_child(this._makeBtn('Edit', 'reminder-task-btn', () => {
                    this._button.menu.close();
                    this._showTaskDialog(task);
                }));
            }
            line1.add_child(this._makeBtn('Dismiss', 'reminder-task-btn', () => {
                this._dismissTask(task);
                this._rebuildMenu();
            }));
        } else {
            if (!isCalendar) {
                line1.add_child(this._makeBtn('Edit', 'reminder-task-btn', () => {
                    this._button.menu.close();
                    this._showTaskDialog(task);
                }));
                line1.add_child(this._makeBtn('Cancel', 'reminder-task-btn', () => {
                    this._dismissTask(task);
                    this._rebuildMenu();
                }));
            } else {
                line1.add_child(this._makeBtn('Dismiss', 'reminder-task-btn', () => {
                    this._dismissTask(task);
                    this._rebuildMenu();
                }));
            }
        }

        container.add_child(line1);

        // Line 2: badges + time info
        const line2 = new St.BoxLayout({style_class: 'reminder-row-line2'});

        if (isCalendar)
            line2.add_child(new St.Label({text: 'CAL', style_class: 'reminder-badge reminder-badge-cal'}));

        if (task.allDay) {
            line2.add_child(new St.Label({text: 'ALL DAY', style_class: 'reminder-task-meta'}));
        } else if (isStale) {
            const badgeText = _isYesterday(task.targetTime) ? 'YESTERDAY' : 'OLD';
            line2.add_child(new St.Label({text: badgeText, style_class: 'reminder-badge reminder-badge-stale'}));
            line2.add_child(new St.Label({
                text: 'was ' + _formatTimeAmPm(new Date(task.targetTime)),
                style_class: 'reminder-task-meta',
            }));
        } else if (expired) {
            line2.add_child(new St.Label({text: 'EXPIRED', style_class: 'reminder-badge reminder-badge-expired'}));
            line2.add_child(new St.Label({
                text: 'was ' + _formatTimeAmPm(new Date(task.targetTime)),
                style_class: 'reminder-task-meta',
            }));
        } else if (task.completed) {
            const badge = task.timerMode === 'countdown' ? 'COUNTDOWN' : _formatTimeAmPm(new Date(task.targetTime));
            const badgeClass = task.timerMode === 'countdown' ? 'reminder-badge-countdown' : 'reminder-badge-absolute';
            line2.add_child(new St.Label({text: badge, style_class: 'reminder-badge ' + badgeClass}));
            const doneLabel = new St.Label({text: 'Done', style_class: 'reminder-task-meta'});
            doneLabel.set_style('color: #6b6;');
            line2.add_child(doneLabel);
        } else if (target) {
            const remaining = Math.max(0, Math.floor((target - now) / 1000));
            if (task.timerMode === 'countdown') {
                line2.add_child(new St.Label({text: 'COUNTDOWN', style_class: 'reminder-badge reminder-badge-countdown'}));
                line2.add_child(new St.Label({
                    text: _formatCountdown(remaining) + ' remaining',
                    style_class: 'reminder-task-meta',
                }));
            } else {
                line2.add_child(new St.Label({
                    text: _formatTimeAmPm(new Date(task.targetTime)),
                    style_class: 'reminder-badge reminder-badge-absolute',
                }));
                line2.add_child(new St.Label({
                    text: _formatCountdown(remaining) + ' left',
                    style_class: 'reminder-task-meta',
                }));
            }
        }

        container.add_child(line2);
        item.add_child(container);
        this._button.menu.addMenuItem(item);
    }

    _makeBtn(label, styleClass, callback) {
        const btn = new St.Button({label, style_class: styleClass});
        btn.connect('clicked', callback);
        return btn;
    }

    // ---- New/Edit Task Dialog (Phase 6) ----

    _showTaskDialog(existingTask) {
        const dialog = new ModalDialog.ModalDialog({styleClass: 'reminder-dialog'});
        const contentBox = new St.BoxLayout({
            vertical: true,
            style: 'spacing: 10px; padding: 10px; min-width: 340px;',
        });

        // Title
        const title = new St.Label({
            text: existingTask ? 'Edit Task' : 'New Task',
            style: 'font-size: 14px; font-weight: bold; color: #eee; margin-bottom: 6px;',
        });
        contentBox.add_child(title);

        // Description
        contentBox.add_child(new St.Label({text: 'Description', style_class: 'reminder-form-label'}));
        const descEntry = new St.Entry({
            style_class: 'reminder-form-input',
            hint_text: 'e.g. Lunch break',
            can_focus: true,
        });
        if (existingTask) descEntry.set_text(existingTask.description);
        contentBox.add_child(descEntry);

        // Timer mode toggle
        contentBox.add_child(new St.Label({text: 'Timer Mode', style_class: 'reminder-form-label'}));
        const modeBox = new St.BoxLayout({style: 'spacing: 0px;'});
        const countdownBtn = new St.Button({label: 'Countdown', style_class: 'reminder-toggle-btn-active'});
        const absoluteBtn = new St.Button({label: 'Set Time (AM/PM)', style_class: 'reminder-toggle-btn'});
        let currentMode = (existingTask && existingTask.timerMode === 'absolute') ? 'absolute' : 'countdown';

        modeBox.add_child(countdownBtn);
        modeBox.add_child(absoluteBtn);
        contentBox.add_child(modeBox);

        // Countdown inputs
        const countdownGroup = new St.BoxLayout({vertical: true, style: 'spacing: 4px;'});
        countdownGroup.add_child(new St.Label({text: 'Duration', style_class: 'reminder-form-label'}));
        const cdRow = new St.BoxLayout({style: 'spacing: 6px;'});
        const hEntry = new St.Entry({style_class: 'reminder-time-input', hint_text: 'HH', can_focus: true});
        hEntry.set_text('00');
        const mEntry = new St.Entry({style_class: 'reminder-time-input', hint_text: 'MM', can_focus: true});
        mEntry.set_text('00');
        const sEntry = new St.Entry({style_class: 'reminder-time-input', hint_text: 'SS', can_focus: true});
        sEntry.set_text('00');

        if (existingTask && existingTask.timerMode === 'countdown' && existingTask.countdownSeconds) {
            const cs = existingTask.countdownSeconds;
            hEntry.set_text(_padTwo(Math.floor(cs / 3600)));
            mEntry.set_text(_padTwo(Math.floor((cs % 3600) / 60)));
            sEntry.set_text(_padTwo(cs % 60));
        }

        cdRow.add_child(hEntry);
        cdRow.add_child(new St.Label({text: ':', style_class: 'reminder-time-sep'}));
        cdRow.add_child(mEntry);
        cdRow.add_child(new St.Label({text: ':', style_class: 'reminder-time-sep'}));
        cdRow.add_child(sEntry);
        cdRow.add_child(new St.Label({text: 'h : m : s', style: 'font-size: 10px; color: #888; margin-left: 4px;'}));
        countdownGroup.add_child(cdRow);
        contentBox.add_child(countdownGroup);

        // Absolute time inputs
        const absoluteGroup = new St.BoxLayout({vertical: true, style: 'spacing: 4px;'});
        absoluteGroup.add_child(new St.Label({text: 'Remind At', style_class: 'reminder-form-label'}));
        const absRow = new St.BoxLayout({style: 'spacing: 6px;'});
        const absHEntry = new St.Entry({style_class: 'reminder-time-input', hint_text: 'HH', can_focus: true});
        absHEntry.set_text('12');
        const absMEntry = new St.Entry({style_class: 'reminder-time-input', hint_text: 'MM', can_focus: true});
        absMEntry.set_text('00');
        let ampmState = 'PM';
        const amBtn = new St.Button({label: 'AM', style_class: 'reminder-toggle-btn'});
        const pmBtn = new St.Button({label: 'PM', style_class: 'reminder-toggle-btn-active'});

        const updateAmPm = () => {
            amBtn.style_class = ampmState === 'AM' ? 'reminder-toggle-btn-active' : 'reminder-toggle-btn';
            pmBtn.style_class = ampmState === 'PM' ? 'reminder-toggle-btn-active' : 'reminder-toggle-btn';
        };
        amBtn.connect('clicked', () => { ampmState = 'AM'; updateAmPm(); });
        pmBtn.connect('clicked', () => { ampmState = 'PM'; updateAmPm(); });

        if (existingTask && existingTask.timerMode === 'absolute' && existingTask.targetTime) {
            const d = new Date(existingTask.targetTime);
            let eh = d.getHours();
            ampmState = eh >= 12 ? 'PM' : 'AM';
            eh = eh % 12;
            if (eh === 0) eh = 12;
            absHEntry.set_text(_padTwo(eh));
            absMEntry.set_text(_padTwo(d.getMinutes()));
            updateAmPm();
        }

        absRow.add_child(absHEntry);
        absRow.add_child(new St.Label({text: ':', style_class: 'reminder-time-sep'}));
        absRow.add_child(absMEntry);
        absRow.add_child(amBtn);
        absRow.add_child(pmBtn);
        absoluteGroup.add_child(absRow);
        contentBox.add_child(absoluteGroup);

        // Conflict warning
        const conflictLabel = new St.Label({
            text: '',
            style: 'font-size: 10px; color: #f67b7b; margin-top: 2px;',
        });
        conflictLabel.hide();
        contentBox.add_child(conflictLabel);

        // Mode switching logic
        const updateMode = () => {
            if (currentMode === 'countdown') {
                countdownBtn.style_class = 'reminder-toggle-btn-active';
                absoluteBtn.style_class = 'reminder-toggle-btn';
                countdownGroup.show();
                absoluteGroup.hide();
            } else {
                countdownBtn.style_class = 'reminder-toggle-btn';
                absoluteBtn.style_class = 'reminder-toggle-btn-active';
                countdownGroup.hide();
                absoluteGroup.show();
            }
        };
        countdownBtn.connect('clicked', () => { currentMode = 'countdown'; updateMode(); });
        absoluteBtn.connect('clicked', () => { currentMode = 'absolute'; updateMode(); });
        updateMode();

        // Conflict check helper
        const checkConflict = () => {
            let targetMs;
            if (currentMode === 'absolute') {
                let ah = parseInt(absHEntry.get_text()) || 12;
                const am = parseInt(absMEntry.get_text()) || 0;
                if (ampmState === 'AM') { if (ah === 12) ah = 0; }
                else { if (ah !== 12) ah += 12; }
                const t = new Date();
                t.setHours(ah, am, 0, 0);
                targetMs = t.getTime();
            } else {
                const h = parseInt(hEntry.get_text()) || 0;
                const m = parseInt(mEntry.get_text()) || 0;
                const s = parseInt(sEntry.get_text()) || 0;
                const totalSec = h * 3600 + m * 60 + s;
                if (totalSec <= 0) { conflictLabel.hide(); return; }
                targetMs = Date.now() + totalSec * 1000;
            }
            const conflicts = this._findConflicts(targetMs, existingTask);
            if (conflicts.length > 0) {
                conflictLabel.set_text('Conflicts with: ' + conflicts.map(c => c.description).join(', '));
                conflictLabel.show();
            } else {
                conflictLabel.hide();
            }
        };

        // Buttons row
        const btnRow = new St.BoxLayout({style: 'spacing: 6px; margin-top: 8px;'});
        btnRow.add_child(new St.Widget({x_expand: true}));

        const cancelFormBtn = new St.Button({label: 'Cancel', style_class: 'reminder-btn'});
        cancelFormBtn.connect('clicked', () => { dialog.close(); });
        btnRow.add_child(cancelFormBtn);

        const saveBtn = new St.Button({
            label: existingTask ? 'Save' : 'Start Task',
            style_class: 'reminder-btn reminder-btn-primary',
        });
        saveBtn.connect('clicked', () => {
            const desc = descEntry.get_text().trim();
            if (!desc) { descEntry.grab_key_focus(); return; }

            const task = existingTask || {
                id: _generateId(),
                description: '',
                timerMode: 'countdown',
                targetTime: null,
                countdownSeconds: null,
                created: new Date().toISOString(),
                completed: false,
                dismissed: false,
            };
            task.description = desc;
            task.timerMode = currentMode;
            task._notified = false;
            task._notified15 = false;
            task._notified5 = false;

            if (currentMode === 'countdown') {
                const h = parseInt(hEntry.get_text()) || 0;
                const m = parseInt(mEntry.get_text()) || 0;
                const s = parseInt(sEntry.get_text()) || 0;
                const totalSec = h * 3600 + m * 60 + s;
                if (totalSec <= 0) { mEntry.grab_key_focus(); return; }
                task.countdownSeconds = totalSec;
                task.targetTime = new Date(Date.now() + totalSec * 1000).toISOString();
            } else {
                let ah = parseInt(absHEntry.get_text()) || 12;
                const am = parseInt(absMEntry.get_text()) || 0;
                if (ampmState === 'AM') { if (ah === 12) ah = 0; }
                else { if (ah !== 12) ah += 12; }
                const target = new Date();
                target.setHours(ah, am, 0, 0);
                task.targetTime = target.toISOString();
                task.countdownSeconds = null;
            }

            if (!existingTask) {
                if (!this._addTask(task)) { dialog.close(); return; }
            } else {
                this._updateTask(task);
            }

            dialog.close();
            if (this._button?.menu?.isOpen) this._rebuildMenu();
        });
        btnRow.add_child(saveBtn);
        contentBox.add_child(btnRow);

        dialog.contentLayout.add_child(contentBox);
        dialog.open();
        descEntry.grab_key_focus();
    }
}
