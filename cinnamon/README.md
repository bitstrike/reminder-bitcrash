# Task Reminder - Cinnamon Applet

A panel applet for the Cinnamon desktop that combines a todo checklist with countdown and absolute-time reminders. This project is ai-assisted. I've done what I can to make sure it's not doing stupid things. 

## Features

- **Two timer modes**: countdown (h:m:s) or absolute time (AM/PM)
- **Desktop notifications** when reminders fire, with optional sound alerts
- **Nag mode**: re-notifies every 5 minutes for unacknowledged expired tasks
- **Panel display**: shows next task name and time remaining
- **Visual pulse** on the panel when tasks are overdue
- **T-15 / T-5 toggles**: optional early warnings before a task fires
- **Nextcloud CalDAV integration**: sync calendar events via Login Flow v2
  - Credentials stored securely in the system keyring (libsecret)
  - VALARM support for calendar reminder triggers
  - Per-calendar keyword filtering
- **Conflict detection**: warns when scheduling into an occupied timeslot
- **Persistence**: tasks saved to `~/.config/reminder@bitcrash/tasks.json`

## Installation

Copy or symlink this directory to `~/.local/share/cinnamon/applets/reminder@bitcrash/`, then add the applet to your panel.

## Configuration

Right-click the panel icon and select Configure to set:

- Sound file for alerts
- Nextcloud server URL
- Browser command for authentication
- Calendar sync preferences

## Requirements

- Cinnamon 5.0+
- For sound: `paplay`, `aplay`, `canberra-gtk-play`, or `play` (SoX)
- For Nextcloud sync: network access and a Nextcloud instance with Login Flow v2
