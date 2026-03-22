/*
 * Multiple Paste - GNOME Shell Clipboard History Manager
 * Copyright (c) 2026 jonis100
 * Licensed under MIT - see LICENSE file
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class MultiplePastePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.multiple-paste');

        const page = new Adw.PreferencesPage();

        const group = new Adw.PreferencesGroup({
            title: _('Clipboard History'),
        });
        page.add(group);

        const row = new Adw.SpinRow({
            title: _('Maximum entries'),
            subtitle: _('Number of clipboard items to keep in history'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 100,
                step_increment: 1,
                value: settings.get_int('max-entries'),
            }),
        });
        settings.bind('max-entries', row, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);

        window.add(page);
    }
}
