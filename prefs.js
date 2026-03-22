/*
 * Multiple Paste - GNOME Shell Clipboard History Manager
 * Copyright (c) 2026 jonis100
 * Licensed under MIT - see LICENSE file
 */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MODIFIER_KEYS = new Set([
    Gdk.KEY_Control_L, Gdk.KEY_Control_R,
    Gdk.KEY_Shift_L,   Gdk.KEY_Shift_R,
    Gdk.KEY_Alt_L,     Gdk.KEY_Alt_R,
    Gdk.KEY_Super_L,   Gdk.KEY_Super_R,
    Gdk.KEY_Meta_L,    Gdk.KEY_Meta_R,
    Gdk.KEY_Hyper_L,   Gdk.KEY_Hyper_R,
]);

const ShortcutRow = GObject.registerClass(
    class ShortcutRow extends Adw.ActionRow {
        _init(title, settings, key) {
            super._init({title, activatable: true});

            this._settings = settings;
            this._key = key;

            this._accelLabel = new Gtk.ShortcutLabel({
                valign: Gtk.Align.CENTER,
                disabled_text: _('Disabled'),
            });
            this._updateLabel();
            settings.connect(`changed::${key}`, () => this._updateLabel());

            const clearBtn = new Gtk.Button({
                icon_name: 'edit-clear-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: _('Clear shortcut'),
            });
            clearBtn.connect('clicked', () => settings.set_strv(key, []));

            this.add_suffix(this._accelLabel);
            this.add_suffix(clearBtn);
            this.connect('activated', () => this._showCaptureDialog());
        }

        _updateLabel() {
            const accels = this._settings.get_strv(this._key);
            this._accelLabel.accelerator = accels[0] ?? '';
        }

        _showCaptureDialog() {
            const dialog = new Gtk.Dialog({
                title: _('Set Shortcut'),
                transient_for: this.get_root(),
                modal: true,
                use_header_bar: 1,
            });

            dialog.get_content_area().append(new Gtk.Label({
                label: _('Press the desired key combination…'),
                margin_top: 24,
                margin_bottom: 24,
                margin_start: 24,
                margin_end: 24,
            }));

            const controller = new Gtk.EventControllerKey();
            controller.connect('key-pressed', (_ctrl, keyval, _code, state) => {
                if (MODIFIER_KEYS.has(keyval))
                    return Gdk.EVENT_PROPAGATE;

                const mods = state & Gtk.accelerator_get_default_mod_mask();
                const accel = Gtk.accelerator_name(keyval, mods);
                if (accel) {
                    this._settings.set_strv(this._key, [accel]);
                    dialog.close();
                }
                return Gdk.EVENT_STOP;
            });
            dialog.add_controller(controller);
            dialog.present();
        }
    }
);

export default class MultiplePastePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.multiple-paste');

        const page = new Adw.PreferencesPage();

        // --- Clipboard History ---
        const historyGroup = new Adw.PreferencesGroup({
            title: _('Clipboard History'),
        });
        page.add(historyGroup);

        const spinRow = new Adw.SpinRow({
            title: _('Maximum entries'),
            subtitle: _('Number of clipboard items to keep in history'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 100,
                step_increment: 1,
                value: settings.get_int('max-entries'),
            }),
        });
        settings.bind('max-entries', spinRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(spinRow);

        // --- Keyboard Shortcuts ---
        const shortcutGroup = new Adw.PreferencesGroup({
            title: _('Keyboard Shortcuts'),
        });
        page.add(shortcutGroup);

        shortcutGroup.add(new ShortcutRow(_('Toggle menu'), settings, 'toggle-menu'));

        window.add(page);
    }
}
