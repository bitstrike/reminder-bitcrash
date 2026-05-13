import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ReminderPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._window = window;

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-notifications-symbolic',
        });

        // -- Notifications group --
        const notifGroup = new Adw.PreferencesGroup({title: 'Notifications'});

        notifGroup.add(this._makeSwitch('notify-past-due',
            'Notify on past due items at startup',
            'If disabled, expired tasks are auto-dismissed on startup'));

        notifGroup.add(this._makeSwitch('enable-countdown-reminders',
            'Enable T-15 and T-5 reminders',
            'Show pre-event reminder toggles on tasks'));

        notifGroup.add(this._makeSpinRow('allday-reminder-hour',
            'All-day event reminder hour',
            'Hour (0-23) to notify about all-day events', 0, 23));

        notifGroup.add(this._makeSpinRow('allday-reminder-minute',
            'All-day event reminder minute',
            'Minute (0-59) to notify about all-day events', 0, 59));

        notifGroup.add(this._makeSwitch('respect-valarm',
            'Respect VALARM in calendar events',
            'Fire notifications at VALARM trigger times'));

        page.add(notifGroup);

        // -- Sound group --
        const soundGroup = new Adw.PreferencesGroup({title: 'Sound'});

        soundGroup.add(this._makeSwitch('enable-sound',
            'Play sound on reminder',
            'Play an audio file when a reminder fires'));

        soundGroup.add(this._makeSoundFileRow());
        soundGroup.add(this._makePreviewSoundRow());

        page.add(soundGroup);

        // -- Nextcloud group --
        const ncGroup = new Adw.PreferencesGroup({title: 'Nextcloud'});

        ncGroup.add(this._makeEntry('caldav-url',
            'Server URL',
            'e.g. https://cloud.example.com'));

        ncGroup.add(this._makeEntry('browser-command',
            'Browser command',
            'e.g. firefox %u (leave blank for system default)'));

        ncGroup.add(this._makeActionRow('Discover Calendars',
            'Fetch available calendars from server',
            () => this._onDiscoverCalendars()));

        ncGroup.add(this._makeActionRow('Sync Now',
            'Fetch today\'s events immediately',
            () => this._onSyncNow()));

        page.add(ncGroup);

        // -- Calendars group --
        this._calGroup = new Adw.PreferencesGroup({
            title: 'Calendars',
            description: 'Toggle which calendars to sync. Set comma-separated keywords to filter events.',
        });
        this._buildCalendarRows();
        page.add(this._calGroup);

        // Rebuild calendar rows when setting changes
        this._settings.connect('changed::caldav-calendars', () => {
            this._buildCalendarRows();
        });

        window.add(page);
    }

    _makeSwitch(key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle: subtitle || ''});
        this._settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _makeSpinRow(key, title, subtitle, min, max) {
        const row = new Adw.SpinRow({
            title,
            subtitle: subtitle || '',
            adjustment: new Gtk.Adjustment({
                lower: min,
                upper: max,
                step_increment: 1,
                page_increment: 5,
                value: this._settings.get_int(key),
            }),
        });
        this._settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _makeEntry(key, title, placeholder) {
        const row = new Adw.EntryRow({title});
        row.text = this._settings.get_string(key);
        if (placeholder)
            row.set_tooltip_text(placeholder);
        row.connect('changed', () => {
            this._settings.set_string(key, row.text);
        });
        this._settings.connect(`changed::${key}`, () => {
            const val = this._settings.get_string(key);
            if (row.text !== val) row.text = val;
        });
        return row;
    }

    _makeActionRow(title, subtitle, callback) {
        const row = new Adw.ActionRow({title, subtitle});
        const btn = new Gtk.Button({
            label: title,
            valign: Gtk.Align.CENTER,
        });
        btn.connect('clicked', callback);
        row.add_suffix(btn);
        row.set_activatable_widget(btn);
        return row;
    }

    _makeSoundFileRow() {
        const current = this._settings.get_string('sound-file');
        const row = new Adw.ActionRow({
            title: 'Sound file',
            subtitle: current || '(none selected)',
        });

        const chooseBtn = new Gtk.Button({
            label: 'Choose',
            valign: Gtk.Align.CENTER,
        });
        chooseBtn.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Select Sound File'});
            const filter = new Gtk.FileFilter();
            filter.set_name('Audio files');
            filter.add_mime_type('audio/x-wav');
            filter.add_mime_type('audio/ogg');
            filter.add_mime_type('audio/mpeg');
            filter.add_mime_type('audio/x-vorbis+ogg');
            filter.add_pattern('*.wav');
            filter.add_pattern('*.ogg');
            filter.add_pattern('*.oga');
            filter.add_pattern('*.mp3');
            const filters = Gio.ListStore.new(Gtk.FileFilter);
            filters.append(filter);
            dialog.set_filters(filters);
            dialog.set_default_filter(filter);

            const cur = this._settings.get_string('sound-file');
            if (cur) {
                try { dialog.set_initial_file(Gio.File.new_for_path(cur)); }
                catch (_e) { /* ignore */ }
            }

            dialog.open(this._window, null, (_d, result) => {
                try {
                    const file = dialog.open_finish(result);
                    if (file) {
                        const path = file.get_path();
                        this._settings.set_string('sound-file', path);
                        row.subtitle = path;
                    }
                } catch (_e) { /* cancelled */ }
            });
        });
        row.add_suffix(chooseBtn);

        const clearBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Clear sound file',
        });
        clearBtn.connect('clicked', () => {
            this._settings.set_string('sound-file', '');
            row.subtitle = '(none selected)';
        });
        row.add_suffix(clearBtn);

        this._settings.connect('changed::sound-file', () => {
            const val = this._settings.get_string('sound-file');
            row.subtitle = val || '(none selected)';
        });

        return row;
    }

    _makePreviewSoundRow() {
        const row = new Adw.ActionRow({
            title: 'Preview Sound',
            subtitle: 'Play the selected sound file',
        });
        const btn = new Gtk.Button({
            label: 'Play',
            valign: Gtk.Align.CENTER,
        });
        btn.connect('clicked', () => {
            const soundFile = this._settings.get_string('sound-file');
            if (!soundFile) return;
            let path = soundFile;
            if (path.startsWith('file://'))
                path = Gio.File.new_for_uri(path).get_path();
            const file = Gio.File.new_for_path(path);
            if (!file.query_exists(null)) return;

            const candidates = [
                ['paplay', path],
                ['aplay', path],
                ['canberra-gtk-play', '-f', path],
                ['play', path],
            ];
            for (const argv of candidates) {
                if (GLib.find_program_in_path(argv[0])) {
                    try {
                        const proc = new Gio.Subprocess({argv, flags: Gio.SubprocessFlags.NONE});
                        proc.init(null);
                        return;
                    } catch (_e) { /* try next */ }
                }
            }
        });
        row.add_suffix(btn);
        return row;
    }

    _buildCalendarRows() {
        // Remove previously added rows
        if (this._calRows) {
            for (const row of this._calRows)
                this._calGroup.remove(row);
        }
        this._calRows = [];

        let calendars = [];
        try {
            calendars = JSON.parse(this._settings.get_string('caldav-calendars'));
            if (!Array.isArray(calendars)) calendars = [];
        } catch (_e) {
            calendars = [];
        }

        if (calendars.length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: 'No calendars discovered',
                subtitle: 'Connect to Nextcloud and click Discover Calendars',
            });
            this._calGroup.add(emptyRow);
            this._calRows.push(emptyRow);
            return;
        }

        for (let i = 0; i < calendars.length; i++) {
            const cal = calendars[i];
            const row = new Adw.ExpanderRow({
                title: cal.displayName || cal.href,
                subtitle: cal.href,
                show_enable_switch: true,
                enable_expansion: cal.enabled !== false,
            });

            const filterRow = new Adw.EntryRow({title: 'Filter keywords (comma-separated)'});
            filterRow.text = cal.filter || '';
            filterRow.connect('changed', () => {
                this._updateCalendar(i, {filter: filterRow.text});
            });
            row.add_row(filterRow);

            row.connect('notify::enable-expansion', () => {
                this._updateCalendar(i, {enabled: row.enable_expansion});
            });

            this._calGroup.add(row);
            this._calRows.push(row);
        }
    }

    _updateCalendar(index, changes) {
        let calendars = [];
        try {
            calendars = JSON.parse(this._settings.get_string('caldav-calendars'));
            if (!Array.isArray(calendars)) return;
        } catch (_e) { return; }

        if (index >= calendars.length) return;
        Object.assign(calendars[index], changes);
        this._settings.set_string('caldav-calendars', JSON.stringify(calendars));
    }

    _onDiscoverCalendars() {
        // Import nextcloud module dynamically for prefs context
        import('./nextcloud.js').then(Nextcloud => {
            const url = this._settings.get_string('caldav-url');
            if (!url) return;

            const creds = Nextcloud.loadCredentials(url);
            if (!creds) {
                this._showToast('Connect to Nextcloud first (from the panel menu)');
                return;
            }

            try {
                const calendars = Nextcloud.discoverCalendars(url, creds.loginName, creds.appPassword);
                if (!calendars || calendars.length === 0) {
                    this._showToast('No calendars found');
                    return;
                }

                // Preserve existing state
                let existing = {};
                try {
                    const stored = JSON.parse(this._settings.get_string('caldav-calendars'));
                    if (Array.isArray(stored)) {
                        for (const row of stored)
                            existing[row.href] = {enabled: row.enabled, filter: row.filter || ''};
                    }
                } catch (_e) { /* ignore */ }

                const rows = calendars.map(cal => ({
                    enabled: (cal.href in existing) ? existing[cal.href].enabled : true,
                    displayName: cal.displayName,
                    filter: (cal.href in existing) ? existing[cal.href].filter : '',
                    href: cal.href,
                }));
                this._settings.set_string('caldav-calendars', JSON.stringify(rows));
                this._showToast('Found ' + calendars.length + ' calendar(s)');
            } catch (e) {
                this._showToast('Discovery failed: ' + e.message);
            }
        }).catch(e => {
            this._showToast('Failed to load Nextcloud module: ' + e.message);
        });
    }

    _onSyncNow() {
        // Sync is handled by the extension process, not prefs.
        // We can only trigger it indirectly by toggling a setting.
        // For now, show a hint.
        this._showToast('Use "Sync Now" from the panel menu (extension must be running)');
    }

    _showToast(message) {
        if (this._window) {
            const toast = new Adw.Toast({title: message, timeout: 3});
            this._window.add_toast(toast);
        }
    }
}
