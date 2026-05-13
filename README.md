# Task Reminder

A panel widget for Linux desktops that combines a todo checklist with countdown and absolute-time reminders. Supports Cinnamon, GNOME Shell, and KDE Plasma. Integrates with your Nextcloud CalDAV calendar (read-only).  This project is ai-assisted.

## Features

- **Two timer modes**: countdown (h:m:s) or absolute time (AM/PM)
- **Desktop notifications** when reminders fire, with optional sound alerts
- **Nag mode**: re-notifies every 5 minutes for unacknowledged expired tasks
- **Panel display**: shows next task name and time remaining
- **T-15 / T-5 toggles**: optional early warnings before a task fires
- **Nextcloud CalDAV integration**: sync calendar events via Login Flow v2
  - Credentials stored securely (system keyring on Cinnamon/GNOME, kwallet on KDE)
  - Server-side recurring event expansion for correct occurrence dates
  - VALARM support for calendar reminder triggers
  - Per-calendar keyword filtering
- **All-day event handling**: configurable reminder time instead of midnight
- **Conflict detection**: warns when scheduling into an occupied timeslot
- **Persistence**: tasks saved to `~/.config/reminder@bitcrash/tasks.json`

## Platforms

| Directory | Desktop | Language | Status |
|-----------|---------|----------|--------|
| `cinnamon/` | Cinnamon 5.0+ | GJS (imports-style) | Complete |
| `gnome/` | GNOME Shell 46+ | GJS (ES modules) | Complete |
| `kde/` | KDE Plasma 5/6 | QML + JavaScript | Initial port |

## Installation

### Cinnamon

Copy or symlink `cinnamon/` to `~/.local/share/cinnamon/applets/reminder@bitcrash/`, then add the applet to your panel.

### GNOME Shell

Copy `gnome/` to `~/.local/share/gnome-shell/extensions/reminder@bitcrash/`, compile the schema, then enable:

```sh
glib-compile-schemas gnome/schemas/
gnome-extensions enable reminder@bitcrash
```

### KDE Plasma

```sh
plasmapkg2 -i kde/
```

Or symlink `kde/` to `~/.local/share/plasma/plasmoids/org.bitcrash.reminder/`.

## Configuration

Each platform has its own settings UI accessible from the widget's context menu. Settings include:

- Sound file for alerts
- Nextcloud server URL
- Browser command for authentication
- Calendar sync preferences
- All-day event reminder time (hour and minute)

## Requirements

- For sound: `paplay`, `aplay`, `canberra-gtk-play`, or `play` (SoX)
- For Nextcloud sync: network access and a Nextcloud instance with Login Flow v2

## License

GPL-3.0
